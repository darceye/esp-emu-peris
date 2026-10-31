/*
 * IR NEC receiver — captures firmware NEC transmissions two ways:
 *
 *   gpio  — the firmware bit-bangs the carrier on a GPIO; edges are seen
 *           through the sigbus while the device holds a fine sampling
 *           lease (M4 scheduler). Rising/falling edges accumulate into a
 *           burst envelope (nec-lib.edgesToSegments) and decode once the
 *           line goes quiet.
 *   rmt   — the firmware transmits carrier-less NEC symbols through an
 *           RMT TX channel; a 34-word frame fits the post-transmission
 *           48-word channel RAM (unlike WS2812 frames), so it decodes
 *           from MMIO after every batch, exactly like the M3 ws2812
 *           device (CHnSTATUS busy gate included). Mid-transmission RAM
 *           stitching is impossible: the emulator leaves
 *           CHnSTATUS.APB_MEM_WADDR at 0 (M4 probe).
 *
 * source 'auto' picks RMT when the configured pin is routed to an RMT TX
 * channel through the GPIO matrix, gpio otherwise.
 */
import {
    parseChannel, channelOptions, LEDC_RESCAN_BATCHES as RESCAN_BATCHES,
    readRmtWords, rmtTxBusy, discoverRmtPins,
} from './ws2812-lib.js';
import { edgesToSegments, decodeNec, rmtWordsToSegments } from './nec-lib.js';

/** Standing watch batch (instructions) while the line is quiet — small
 * enough that the first burst of a frame is certain to be sampled (guest
 * delay loops run ~50% of nominal time on this emulator, M4). */
export const ARM_BATCH = 1000;
/** Fine batch size while a frame is in flight. */
export const FINE_BATCH = 300;
/** Fine lease budget (cycles), renewed on every edge: bridges the longest
 * edge-free window inside a frame (a 1-bit gap ≈ 1.7 ms). */
export const FINE_HOLD_CYCLES = 1500000;
/** Quiet line for this long (µs) = frame over, flush the decoder. */
export const FLUSH_QUIET_US = 25000;
/** Edge buffer cap — a full frame carries ~1400 rising edges. */
export const MAX_EDGES = 6000;

const pinNum = (v, dflt) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : dflt;
};

export class Device {
    static typeId = 'ir-nec';
    static version = '1.0.0';
    static title = 'IR NEC receiver';
    static category = 'protocol';
    static description = 'Captures firmware NEC IR codes — bit-banged on a GPIO (fine-grained edge sampling) or sent through an RMT TX channel (channel-RAM decode).';
    static defaultConfig = { name: 'IR', pin: 10, source: 'auto', channel: 'auto' };
    static pins(cfg) {
        return cfg.source === 'rmt' ? [] : [pinNum(cfg.pin, 10)];
    }
    static configSchema = [
        { key: 'source', label: 'Capture source', type: 'select', options: [
            { value: 'auto', label: 'Auto (RMT wiring, else GPIO)' },
            { value: 'gpio', label: 'GPIO edge sampling' },
            { value: 'rmt', label: 'RMT channel RAM' },
        ] },
        { key: 'pin', label: 'GPIO pin', type: 'pin' },
        { key: 'channel', label: 'RMT channel', type: 'select', options: channelOptions(2) },
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.pin = pinNum(cfg.pin, 10);
        this.src = ['auto', 'gpio', 'rmt'].includes(cfg.source) ? cfg.source : 'auto';
        // manual channel survives emulator reloads (firmware-side routing
        // does not); 'auto' re-discovers on every resolution
        this.manualChan = parseChannel(cfg.channel, ctx.mmio?.rmt.txChannelCount ?? 2);
        this.chan = this.src === 'rmt' && this.manualChan !== 'auto' ? this.manualChan : null;
        this.rmtPin = null;       // discovered pad of the bound channel
        this.mode = null;         // 'gpio' | 'rmt' (resolved on first batch)
        this.edges = [];          // { up, us } while a gpio frame is in flight
        this.lastEdgeUs = -1;
        this.frames = [];         // decoded frames, newest last (capped)
        this.count = 0;
        this.words = null;        // last rmt RAM snapshot (change gate)
        this.tick = 0;
        this.cpus = ctx.cyclesPerUs || 160;
        ctx.subscribe([this.pin]);
        if (this.src !== 'rmt') ctx.armSampling(ARM_BATCH);
    }

    onEmuReady() {
        // fresh emulator: no wiring, no RAM, no half-captured frame
        this.chan = this.src === 'rmt' && this.manualChan !== 'auto' ? this.manualChan : null;
        this.rmtPin = null;
        this.mode = null;
        this.edges = [];
        this.lastEdgeUs = -1;
        this.frames = [];
        this.count = 0;
        this.words = null;
        this.cpus = this.ctx.cyclesPerUs || 160;
        if (this.src !== 'rmt') this.ctx.armSampling(ARM_BATCH);
        this.ctx.markDirty();
    }

    onPinState(pin, s) {
        if (this.mode === 'rmt' || pin !== this.pin) return;
        const up = !!(s.out && s.oe);
        const us = s.cycles / this.cpus;
        this.edges.push({ up, us });
        if (this.edges.length > MAX_EDGES) this.edges.splice(0, this.edges.length - MAX_EDGES);
        this.lastEdgeUs = us;
        this.ctx.fineSampling(FINE_BATCH, FINE_HOLD_CYCLES);
    }

    onBatch() {
        this.tick++;
        this._resolveMode();
        if (this.mode === 'rmt') {
            this._pollRmt();
            return;
        }
        // gpio mode: flush the decoder once the line has been quiet
        if (this.edges.length && this.lastEdgeUs >= 0) {
            const nowUs = this.ctx.cycles() / this.cpus;
            if (nowUs - this.lastEdgeUs > FLUSH_QUIET_US) this._flushGpio();
        }
    }

    getState() {
        return {
            mode: this.mode,
            pin: this.mode === 'rmt' ? this.rmtPin : this.pin,
            channel: this.mode === 'rmt' ? this.chan : null,
            count: this.count,
            last: this.frames[this.frames.length - 1] || null,
            log: this.frames.slice(-8),
        };
    }

    destroy() {
        this.ctx.releaseSampling();
        this.ctx.unsubscribe();
    }

    _resolveMode() {
        if (this.mode !== null) return;
        if (this.src === 'gpio') { this.mode = 'gpio'; return; }
        // auto / rmt: look for a routed RMT TX channel whose pad is the
        // configured pin (auto), the manual pick, or any routed channel
        const pins = discoverRmtPins(this.ctx);
        let ch = null;
        if (this.src === 'auto') {
            for (const [c, p] of pins) if (p === this.pin) ch = c;
        } else if (this.chan != null) {
            ch = this.chan; // manual channel from the config
        }
        if (ch == null && this.src === 'rmt' && this.manualChan === 'auto') {
            ch = pins.size ? Math.min(...pins.keys()) : null;
        }
        if (ch != null) {
            this.chan = ch;
            this.rmtPin = pins.get(ch) ?? null;
        }
        if (this.src === 'rmt' || ch != null) this.mode = 'rmt';
        else this.mode = 'gpio';
    }

    _pollRmt() {
        if (this.chan == null || !this.ctx.mmio) return;
        // follow the firmware's wiring like the M2/M3 devices
        if (this.tick % RESCAN_BATCHES === 0) {
            const pins = discoverRmtPins(this.ctx);
            this.rmtPin = pins.get(this.chan) ?? null;
        }
        if (rmtTxBusy(this.ctx, this.chan)) return;
        const words = readRmtWords(this.ctx, this.chan);
        if (this.words !== null && wordsEq(words, this.words)) return;
        this.words = words;
        const segs = rmtWordsToSegments(words);
        if (segs == null) return;
        const frame = decodeNec(segs);
        if (frame) this._pushFrame(frame);
    }

    _flushGpio() {
        const segs = edgesToSegments(this.edges);
        this.edges = [];
        const frame = decodeNec(segs);
        if (frame) this._pushFrame(frame);
    }

    _pushFrame(frame) {
        const last = this.frames[this.frames.length - 1];
        if (frame.repeat && last) {
            this.frames[this.frames.length - 1] = { ...last, repeats: (last.repeats || 0) + 1 };
        } else {
            this.frames.push({ ...frame, repeats: 0 });
            if (this.frames.length > 40) this.frames.shift();
            this.count++;
        }
        this.ctx.markDirty();
    }
}

function wordsEq(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

const hex2 = (v) => (v & 0xff).toString(16).padStart(2, '0');

export class View {
    constructor(el, sendCmd) {
        this.el = el;
        this.send = sendCmd;
        this.cfg = { pin: 10, channel: 'auto', source: 'auto' };
        el.className = 'dev-body ir-body';

        this.last = document.createElement('div');
        this.last.className = 'ir-last';
        this.list = document.createElement('div');
        this.list.className = 'ir-list';
        this.cap = document.createElement('div');
        this.cap.className = 'ir-cap';
        el.appendChild(this.last);
        el.appendChild(this.list);
        el.appendChild(this.cap);
        this._renderLast(null);
    }

    rowIcon(el) {
        el.title = 'IR NEC receiver';
        const chip = document.createElement('span');
        chip.className = 'ir-icon';
        chip.textContent = 'IR';
        this.icon = chip;
        el.appendChild(chip);
        this._applyIcon(0);
    }

    /* one styling path for the icon */
    _applyIcon(count) {
        if (!this.icon) return;
        this.icon.classList.toggle('live', count > 0);
        this.icon.dataset.count = count > 99 ? '99+' : String(count || '');
    }

    _renderLast(frame) {
        this.last.innerHTML = '';
        if (!frame || frame.repeat) {
            const d = document.createElement('span');
            d.className = 'ir-code';
            d.textContent = '— no code yet —';
            this.last.appendChild(d);
            return;
        }
        const code = document.createElement('span');
        code.className = 'ir-code';
        code.textContent = `addr 0x${hex2(frame.addr)} · cmd 0x${hex2(frame.cmd)}`;
        this.last.appendChild(code);
        const badge = document.createElement('span');
        badge.className = 'ir-valid' + (frame.valid ? '' : ' bad');
        badge.textContent = frame.valid ? 'NEC' : 'raw';
        badge.title = frame.valid
            ? 'inverse fields match (standard NEC)'
            : `raw bytes ${hex2(frame.addr)} ${hex2(frame.invAddr)} ${hex2(frame.cmd)} ${hex2(frame.invAddr)}`;
        this.last.appendChild(badge);
        if (frame.repeats) {
            const r = document.createElement('span');
            r.className = 'ir-repeat';
            r.textContent = `+${frame.repeats} repeat`;
            this.last.appendChild(r);
        }
    }

    render(state) {
        this._applyIcon(state.count || 0);
        this._renderLast(state.last);
        this.list.innerHTML = '';
        const entries = (state.log || []).filter((f) => !f.repeat).slice(-6).reverse();
        if (!entries.length) {
            const d = document.createElement('div');
            d.className = 'ir-empty';
            d.textContent = 'waiting for IR traffic…';
            this.list.appendChild(d);
        }
        for (const f of entries) {
            const d = document.createElement('div');
            d.className = 'ir-entry';
            d.textContent = `addr 0x${hex2(f.addr)} · cmd 0x${hex2(f.cmd)}`
                + (f.valid ? '' : ' (raw)') + (f.repeats ? ` · +${f.repeats}` : '');
            this.list.appendChild(d);
        }
        const mode = state.mode || 'gpio';
        this.cap.textContent = mode === 'rmt'
            ? `RMT ch${state.channel} → GPIO${state.pin ?? '?'} · ${state.count || 0} frames`
            : `GPIO${state.pin} edge capture · ${state.count || 0} frames`;
    }

    setConfig(cfg) {
        this.cfg = {
            pin: pinNum(cfg.pin, 10),
            channel: cfg.channel ?? 'auto',
            source: cfg.source ?? 'auto',
        };
    }
}
