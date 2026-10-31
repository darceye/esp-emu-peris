/*
 * WS2812 addressable LED strip — one RMT TX channel drives the whole strip.
 *
 * The pad-level waveform never reaches gpio_state() (it goes through the
 * GPIO matrix — M0 Q3a), so frames are decoded from the RMT channel RAM
 * (M0 Q3b + the M3 probe): after a transmission the RAM holds the reset
 * symbol, the transmit terminator and the last ≤46 bits of the frame (the
 * RAM wraps every 48 words — one word per bit with the copy encoder), so
 * only the tail LEDs of long strips are recoverable; the View marks the
 * rest as unknown. The channel is auto-discovered from the GPIO-matrix
 * routing (RMT_SIG_OUT0/1) or picked manually, and the CHnSTATUS state
 * machine tells finished transmissions from in-flight ones. Shared decode
 * and painting logic lives in ws2812-lib.js.
 */
import {
    parseChannel, channelOptions, LEDC_RESCAN_BATCHES as RESCAN_BATCHES,
    readRmtWords, rmtTxBusy, discoverRmtPins, decodeWs2812, slotsToRgb,
    LevelAnimator, ledPositions, drawLedDot, shapeLevel, makeCanvas,
} from './ws2812-lib.js';

const MAX_LEDS = 64;

/** LED count from config (editor numbers may arrive as strings). */
export function countFrom(v) {
    const n = Number(v);
    return Number.isInteger(n) ? Math.min(MAX_LEDS, Math.max(1, n)) : 8;
}

export class Device {
    static typeId = 'ws2812';
    static version = '1.0.0';
    static title = 'WS2812 Strip';
    static category = 'pwm';
    static description = 'Addressable LED strip on an RMT TX channel (frames decoded from the RMT channel RAM; wiring auto-discovered).';
    static defaultConfig = {
        name: 'WS2812', channel: 'auto', count: 8, order: 'grb',
        layout: 'strip', columns: 8, maxBright: 1, gamma: 1,
    };
    /* Like the LEDC devices: the RMT→pad routing is firmware-side GPIO-matrix
     * config, so the plugin claims no GPIO of its own. */
    static pins() { return []; }
    static configSchema = [
        // option count = C3 RMT TX channels (per-chip tables in src/core/mmio)
        { key: 'channel', label: 'RMT channel', type: 'select', options: channelOptions(2) },
        { key: 'count', label: 'LED count', type: 'number', min: 1, max: MAX_LEDS, step: 1 },
        { key: 'order', label: 'Colour order', type: 'select', options: [
            { value: 'grb', label: 'GRB (WS2812)' }, { value: 'rgb', label: 'RGB' },
        ] },
        { key: 'layout', label: 'Layout', type: 'select', options: [
            { value: 'strip', label: 'Strip' }, { value: 'ring', label: 'Ring' }, { value: 'matrix', label: 'Matrix' },
        ] },
        { key: 'columns', label: 'Matrix columns', type: 'number', min: 1, max: MAX_LEDS, step: 1 },
        { key: 'maxBright', label: 'Brightness cap', type: 'number', min: 0, max: 1, step: 0.05 },
        { key: 'gamma', label: 'Gamma', type: 'number', min: 0.4, max: 3, step: 0.1 },
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.count = countFrom(cfg.count);
        this.order = cfg.order === 'rgb' ? 'rgb' : 'grb';
        this.mode = null;        // 'auto' | channel number (resolved on first batch)
        this.chan = null;        // bound channel (null = not wired yet)
        this.pin = null;         // discovered pad of this channel
        this.leds = Array.from({ length: this.count }, () => [0, 0, 0]);
        this.visible = 0;        // tail LEDs the RAM window can recover
        this.frames = 0;         // latched frame count (caption)
        this.words = null;       // last channel-RAM snapshot (change gate)
        this.tick = 0;
    }

    onEmuReady() {
        // fresh emulator instance: routing and RAM are unknown again (all
        // registers read 0 until the firmware runs)
        if (this.mode === 'auto') this.chan = null;
        this.pin = null;
        this.leds = this.leds.map(() => [0, 0, 0]);
        this.visible = 0;
        this.frames = 0;
        this.words = null;
        this.ctx.markDirty();
    }

    onBatch() {
        if (this.mode === null) {
            this.mode = parseChannel(this.cfg.channel, this.ctx.mmio?.rmt.txChannelCount ?? 2);
            if (this.mode !== 'auto') this.chan = this.mode;
        }
        this.tick++;
        // Discover (and keep following) the firmware's wiring, like pwm-led
        if (this.chan == null || this.pin == null || this.tick % RESCAN_BATCHES === 0) {
            const pins = discoverRmtPins(this.ctx);
            if (this.mode === 'auto') {
                const ch = pins.size ? Math.min(...pins.keys()) : null;
                if (ch !== this.chan) { this.chan = ch; this.ctx.markDirty(); }
            }
            this.pin = this.chan == null ? null : pins.get(this.chan) ?? null;
        }
        if (this.chan == null || !this.ctx.mmio) return;
        if (rmtTxBusy(this.ctx, this.chan)) return; // settle before decoding
        const words = readRmtWords(this.ctx, this.chan);
        if (this.words !== null && wordsEq(words, this.words)) return;
        this.words = words;
        const dec = decodeWs2812(words);
        if (dec == null) return; // no completed transmission in RAM yet
        // tail-aligned: the window holds the END of the strip; anything the
        // 48-word RAM cannot keep stays unknown (drawn hollow by the View)
        const slots = slotsToRgb(dec.slots, this.order).slice(-this.count);
        if (slots.length === 0) return;
        const leds = this.leds.map((c) => c.slice());
        for (let i = 0; i < slots.length; i++) leds[this.count - slots.length + i] = slots[i];
        if (slots.length !== this.visible || leds.some((c, i) => c.some((v, k) => v !== this.leds[i][k]))) {
            this.leds = leds;
            this.visible = slots.length;
            this.frames++;
            this.ctx.markDirty();
        }
    }

    getState() {
        return {
            leds: this.leds, visible: this.visible,
            channel: this.chan, pin: this.pin, frames: this.frames,
        };
    }
}

function wordsEq(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

export class View {
    constructor(el, sendCmd) {
        this.el = el;
        this.send = sendCmd;
        this.cfg = { count: 8, layout: 'strip', columns: 8, maxBright: 1, gamma: 1 };
        this.levels = [];        // flat interpolated [r,g,b]×count (0..1 each)
        this.visible = 0;
        el.className = 'dev-body ws2812-body';
        const wrap = document.createElement('div');
        wrap.className = 'ws-wrap';
        this.cv = null; this.g = null; this.geo = null;
        this.wrap = wrap;
        const cap = document.createElement('div');
        cap.className = 'led-cap';
        this.cap = cap;
        el.appendChild(wrap);
        el.appendChild(cap);
        this.animator = new LevelAnimator((lv) => this._apply(lv));
        this._rebuild();
        this._apply([]);
    }

    /* Compact row icon: the strip tail in miniature (the tail is exactly the
     * part the channel RAM recovers). Same painter as the big canvas. */
    rowIcon(el) {
        el.title = 'WS2812 strip (tail LEDs)';
        const { cv, g } = makeCanvas(22, 22, 'ws-icon');
        this.iconCv = cv; this.iconG = g;
        el.appendChild(cv);
        this._apply(this.levels);
    }

    /* Geometry from config — one place builds the canvas and dot positions. */
    _rebuild() {
        const c = this.cfg;
        const geo = ledPositions(c.layout, c.count, c.columns, c.layout === 'ring' ? 190 : 300);
        if (this.cv) this.cv.remove();
        const { cv, g } = makeCanvas(geo.w, geo.h, 'ws-canvas');
        this.cv = cv; this.g = g; this.geo = geo;
        this.wrap.appendChild(cv);
    }

    /* The ONE application of the LED levels — details canvas + row icon, from
     * the same interpolated values (AGENT.md §3.8). */
    _apply(levels) {
        this.levels = levels;
        const c = this.cfg;
        const known = c.count - this.visible; // first `known` LEDs are unknown
        if (this.g && this.geo) {
            this.g.clearRect(0, 0, this.geo.w, this.geo.h);
            for (let i = 0; i < c.count; i++) {
                const dot = this.geo.dots[i];
                const l = levels.length >= (i + 1) * 3
                    ? [levels[i * 3], levels[i * 3 + 1], levels[i * 3 + 2]]
                    : [0, 0, 0];
                const shaped = l.map((v) => shapeLevel(v, c.maxBright, c.gamma));
                const rgb = shaped.map((v) => v * 255);
                drawLedDot(this.g, dot.x, dot.y, dot.r, rgb, Math.max(...shaped), i < known);
            }
        }
        if (this.iconG) {
            this.iconG.clearRect(0, 0, 22, 22);
            const n = Math.min(3, c.count);
            for (let k = 0; k < n; k++) {
                const i = c.count - n + k; // tail LEDs
                const unk = i < known;
                const l = levels.length >= (i + 1) * 3
                    ? [levels[i * 3], levels[i * 3 + 1], levels[i * 3 + 2]]
                    : [0, 0, 0];
                const shaped = l.map((v) => shapeLevel(v, c.maxBright, c.gamma));
                drawLedDot(this.iconG, 4 + k * 7, 11, 3.2, shaped.map((v) => v * 255), Math.max(...shaped), unk);
            }
        }
    }

    render(state) {
        this.visible = state.visible || 0;
        const leds = Array.isArray(state.leds) ? state.leds : [];
        const target = [];
        for (let i = 0; i < this.cfg.count; i++) {
            const c = leds[i] || [0, 0, 0];
            target.push((c[0] || 0) / 255, (c[1] || 0) / 255, (c[2] || 0) / 255);
        }
        this.animator.setTarget(target);
        const ch = state.channel;
        this.cap.textContent = ch == null
            ? 'waiting for firmware RMT wiring…'
            : `RMT ch${ch} → GPIO${state.pin ?? '?'} · ${this.visible}/${this.cfg.count} LEDs visible`
              + (state.frames ? ` · ${state.frames} frames` : '');
    }

    setConfig(cfg) {
        const count = countFrom(cfg.count);
        const layout = ['strip', 'ring', 'matrix'].includes(cfg.layout) ? cfg.layout : 'strip';
        const rebuild = count !== this.cfg.count || layout !== this.cfg.layout
            || (layout === 'matrix' && Number(cfg.columns) !== this.cfg.columns);
        this.cfg = {
            count, layout,
            columns: Math.max(1, Number(cfg.columns) || 8),
            maxBright: Math.min(1, Math.max(0, Number(cfg.maxBright) || 0)),
            gamma: Math.min(3, Math.max(0.4, Number(cfg.gamma) || 1)),
        };
        if (rebuild) this._rebuild();
        this._apply(this.levels);
    }
}
