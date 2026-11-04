/*
 * MAX7219 display driver — renders the latched 8-digit display as 8×8
 * matrix dots or 7-segment digits, from either of two firmwareside buses
 * (config `bus`):
 *
 *   bitbang — firmware drives DIN/CLK/LOAD with CPU GPIO writes (any
 *     soft-SPI code, delay-paced or back-to-back). CPU-driven edges are
 *     only observable while a fine sampling lease is held (M4 scheduler):
 *     the device arms a standing watch and escalates on the first bus
 *     edge, exactly like the bit-bang I2C slave.
 *
 *   hwspi — firmware talks to the part over the hardware SPI2 master
 *     (M5: the peripheral is modelled and its TX is observable at the
 *     register level). Each spi_device_transmit = one CS frame: the hal
 *     loads W0..W15 and the model wipes them at completion, so a batch
 *     watcher catches the payload (spi-lib.js SpiWindowEngine; measured
 *     catch rate 10/10 at arm batch 60). One transfer's bytes are the
 *     shifted-in 16-bit words — MSB first — which is exactly a LOAD-frame
 *     of the bit-bang engine's contract, so both buses feed the same
 *     register model through the same handler. Claims no pads in this
 *     mode (a register-level listener, like the LEDC devices).
 *
 * Bit-bang lease sizing (measured against the reference firmware, gun
 * 0.1.0: pulses with NO delays — back-to-back gpio_set_level calls): one
 * CLK edge costs ~20 instructions, the shortest CLK→DIN / CLK→CLK gap is
 * ~20-40, the LOAD fall leads the first CLK rise by ~80, a whole 16-bit
 * frame spans ~1820. So the fine lease sits at the scheduler's floor (20)
 * — every edge then lands in its own batch and DIN is never ambiguous
 * against a CLK rise — and the arm batch (60) always separates the LOAD
 * fall from the first CLK rise. Delay-paced bit-bang (esp_rom_delay_us(2),
 * gun 0.1.5-class, gaps ≥160) is covered with even wider margins.
 * Firmwares with pulses below ~20 instructions lose edges; the engine
 * drops misaligned frames and counts them in `dropped` (visible in the
 * caption) instead of showing garbage — drivers that re-push their
 * registers periodically self-heal.
 *
 * Daisy chains: N parts share DIN/CLK/LOAD (`sharedBus`); each instance
 * latches the word that ended in its chain position (chain length + position
 * in the config). Single devices (chain 1) simply take the last word. The
 * same chain semantics apply on hwspi: one hardware transfer of N×16 bits
 * is one frame of N daisy words.
 */
import {
    Max7219Model, Max7219Wire, pickChainWord, displayFromSnapshot,
    drawDisplay, drawSeg7, displayLevel, displayGeometry, MX_COLOR,
} from './max7219-lib.js';
import { SpiWindowEngine, discoverSpiWiring, readDmaPayload } from './spi-lib.js';
import { makeCanvas } from './ws2812-lib.js';

/** Standing watch batch (instructions) while the bus is idle — below the
 * LOAD-fall → first-CLK-rise gap (~80 instructions measured), so a frame's
 * first bit can never be swallowed by the watch batch. */
export const ARM_BATCH = 60;
/** Fine batch size while a frame is in flight — the scheduler floor: every
 * edge of a back-to-back bit-bang (gaps ≥20) lands in its own batch. */
export const FINE_BATCH = 20;
/** Fine lease budget (cycles), renewed on every edge: bridges the slowest
 * plausible mid-frame pause (8-word chain frames run ~600k cycles). */
export const FINE_HOLD_CYCLES = 2000000;
/** hwspi: standing arm batch — M5 measured the W load→fire window survives
 * batch 60 (10/10) but not 100 (1/9); 60 matches the bit-bang arm. */
export const HW_ARM_BATCH = 60;
/** hwspi: wiring rescan cadence (batches) — caption only, same cadence as
 * the LEDC auto-binding rescan. */
export const HW_RESCAN_BATCHES = 24;

const pinNum = (v, dflt) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : dflt;
};

const busFrom = (v) => (v === 'hwspi' ? 'hwspi' : 'bitbang');

const chainFrom = (v) => {
    const n = Number(v);
    return Number.isInteger(n) ? Math.min(8, Math.max(1, n)) : 1;
};

const posFrom = (v, chain) => {
    const n = Number(v);
    return Number.isInteger(n) ? Math.min(chain - 1, Math.max(0, n)) : 0;
};

/** A GDMA chain is MAX7219 traffic iff it is 1..8 whole 16-bit words and
 * every word's high byte is a register address 0x01..0x0F. */
const isDmaFrame = (b) => b.length >= 2 && b.length <= 16 && b.length % 2 === 0
    && b.every((v, i) => i % 2 === 1 || (v >= 0x01 && v <= 0x0f));

export class Device {
    static typeId = 'max7219';
    static version = '1.3.1';
    static title = 'MAX7219 Display';
    static category = 'display';
    static description = '8-digit LED driver on a firmware bit-banged DIN/CLK/LOAD bus or the hardware SPI2 master — 8×8 matrix or 7-segment view, daisy-chainable.';
    static defaultConfig = {
        name: 'MAX7219', bus: 'bitbang', din: 21, clk: 13, load: 14, chain: 1, pos: 0, mode: 'auto',
        segDecode: 'auto',
    };
    /* DIN/CLK/LOAD are a bus: daisy-chained parts legally share all three.
     * (hwspi mode claims nothing — pins() returns [].) */
    static sharedBus = true;
    static pins(cfg) {
        if (busFrom(cfg.bus) === 'hwspi') return [];
        return [pinNum(cfg.din, 21), pinNum(cfg.clk, 13), pinNum(cfg.load, 14)];
    }
    static configSchema = [
        { key: 'bus', label: 'Bus', type: 'select', options: [
            { value: 'bitbang', label: 'Bit-banged (DIN/CLK/LOAD GPIOs)' },
            { value: 'hwspi', label: 'Hardware SPI2 (register level, M5)' },
        ] },
        { key: 'din', label: 'DIN GPIO', type: 'pin' },
        { key: 'clk', label: 'CLK GPIO', type: 'pin' },
        { key: 'load', label: 'LOAD/CS GPIO', type: 'pin' },
        { key: 'chain', label: 'Chain length', type: 'number', min: 1, max: 8, step: 1 },
        { key: 'pos', label: 'Chain position', type: 'number', min: 0, max: 7, step: 1 },
        { key: 'mode', label: 'Display view', type: 'select', options: [
            { value: 'auto', label: 'Auto (decode-mode register)' },
            { value: 'matrix', label: '8×8 matrix' },
            { value: 'seg7', label: '7-segment digits' },
        ] },
        { key: 'segDecode', label: 'Digit decode', type: 'select', options: [
            { value: 'auto', label: 'Auto (decode-mode register)' },
            { value: 'bcd', label: 'Always Code B (BCD)' },
            { value: 'raw', label: 'Never decode (raw segment bits)' },
        ] },
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.bus = busFrom(cfg.bus);
        this.din = pinNum(cfg.din, 21);
        this.clk = pinNum(cfg.clk, 13);
        this.load = pinNum(cfg.load, 14);
        this.chain = chainFrom(cfg.chain);
        this.pos = posFrom(cfg.pos, this.chain);
        this.model = new Max7219Model();
        this.levels = { clk: null, din: null, load: null };
        this.frames = 0;   // aligned LOAD frames seen (any chain length)
        this.dropped = 0;  // misaligned frames — edges/transfers lost to sampling
        if (this.bus === 'hwspi') {
            /* register-level listener: no pad claims, no pin subscription —
             * the W window is watched every armed batch (M5, spi-lib), and
             * DMA transactions are recovered from the GDMA descriptor chain
             * (spi_bus_initialize(..., SPI_DMA_CH_AUTO) bypasses W entirely;
             * verified live with duel_of_8 0.3.0 on S3 — tests/m7_smoke.mjs). */
            this.window = new SpiWindowEngine(ctx, (bytes) => this._onHwTransfer(bytes));
            this.wiring = null;
            this.batchCount = 0;
            this.dmaChannel = null; // sticky GDMA channel (no PERI_SEL in the model)
            this.dmaLast = null;    // last fed chain's signature
            this.dmaFeeds = 0;
            ctx.armSampling(HW_ARM_BATCH);
            return;
        }
        this.wire = new Max7219Wire((words, bits) => this._onFrame(words, bits));
        ctx.subscribe([this.din, this.clk, this.load]);
        ctx.armSampling(ARM_BATCH);
    }

    onEmuReady() {
        // fresh emulator: the chip powers up in shutdown, blank, scan 1 digit
        this.model.reset();
        this.frames = 0;
        this.dropped = 0;
        if (this.bus === 'hwspi') {
            this.window.reset();
            this.wiring = null;
            this.dmaChannel = null;
            this.dmaLast = null;
            this.dmaFeeds = 0;
            this.ctx.armSampling(HW_ARM_BATCH);
        } else {
            this.wire.reset();
            this.levels = { clk: null, din: null, load: null };
            this.ctx.armSampling(ARM_BATCH);
        }
        this.ctx.markDirty();
    }

    onPinState(pin, s) {
        if (this.bus === 'hwspi') return;
        const high = !!(s.out && s.oe);
        if (pin === this.din) this.levels.din = high;
        else if (pin === this.clk) this.levels.clk = high;
        else this.levels.load = high;
        if (this.wire.step(this.levels.clk, this.levels.din, this.levels.load)) {
            // any edge: keep the fine window alive for the rest of the frame
            this.ctx.fineSampling(FINE_BATCH, FINE_HOLD_CYCLES);
        }
    }

    onBatch() {
        if (this.bus === 'hwspi') {
            this.window.sample();
            /* DMA firmware (spi_master with a dma channel): the payload lives
             * in the GDMA out-descriptor chain, which stays readable after
             * completion. MAX7219 frames are ≤16 bytes, so the whole frame
             * arrives in one walk; the content signature stops re-reads of a
             * descriptor the hal left armed/cleared between polls. A repeat
             * write of an IDENTICAL frame is deduped away — the latch state
             * would not change, so nothing is lost visually.
             *
             * Shape gate first: the GDMA has no PERI_SEL in the model, so
             * OTHER devices' DMA rides the same channels (measured: the probe
             * firmware's ILI9341 pixel chunks). A chain is MAX7219 traffic
             * only when every 16-bit word carries a register address byte in
             * 0x01..0x0F — anything else is ignored silently (not `dropped`,
             * it was never ours). */
            const walked = readDmaPayload(this.ctx, this.dmaChannel);
            if (walked && isDmaFrame(walked.bytes)) {
                if (walked.channel !== undefined) this.dmaChannel = walked.channel;
                const sig = `${walked.bytes.length}:${Array.from(walked.bytes).join(',')}`;
                // dedupe only the IMMEDIATELY PREVIOUS chain: a descriptor the
                // hal left readable between polls must not feed twice, but
                // returning to EARLIER content (a score that repeats, a blank
                // between states) is a real transaction and must land — a
                // global signature set silently dropped those (duel_of_8 game
                // rounds re-show old glyphs)
                if (sig !== this.dmaLast) {
                    this.dmaLast = sig;
                    this.dmaFeeds++;
                    this._onHwTransfer(walked.bytes);
                }
            }
            if (++this.batchCount % HW_RESCAN_BATCHES === 0) {
                const w = discoverSpiWiring(this.ctx);
                if (JSON.stringify(w) !== JSON.stringify(this.wiring)) {
                    this.wiring = w;   // caption only — the engine needs no wiring
                    this.ctx.markDirty();
                }
            }
            return;
        }
        if (this.wire.busy) {
            // mid-frame: renew even without edges (slow bit-bang pauses)
            this.ctx.fineSampling(FINE_BATCH, FINE_HOLD_CYCLES);
        }
    }

    getState() {
        const m = this.model;
        const st = {
            bus: this.bus,
            chain: this.chain, pos: this.pos,
            digits: m.digits.slice(),
            decodeMode: m.decodeMode,
            intensity: m.intensity,
            scanLimit: m.scanLimit,
            shutdown: m.shutdown,
            test: m.test,
            frames: this.frames,
            dropped: this.dropped,
            writes: m.writes,
        };
        if (this.bus === 'hwspi') {
            st.transfers = this.window.transfers;
            st.dmaFeeds = this.dmaFeeds;
            st.wiring = this.wiring;
        } else {
            st.din = this.din; st.clk = this.clk; st.load = this.load;
        }
        return st;
    }

    destroy() {
        this.ctx.releaseSampling();
        this.ctx.unsubscribe();
    }

    _onFrame(words) {
        if (words == null) {
            this.dropped++;
            this.ctx.markDirty();
            return;
        }
        this.frames++;
        const word = pickChainWord(words, this.chain, this.pos);
        if (word != null && this.model.write((word >> 8) & 0xff, word & 0xff)) {
            this.ctx.markDirty();
        }
    }

    /* hwspi: one SpiWindowEngine transfer = one CS frame — MSB-first bytes
     * pair into the 16-bit words a LOAD-frame carries, then the exact same
     * chain/latch path as bit-bang. */
    _onHwTransfer(bytes) {
        if (bytes.length === 0 || bytes.length % 2 !== 0 || bytes.length > 16 * 2) {
            this.dropped++;
            this.ctx.markDirty();
            return;
        }
        const words = new Array(bytes.length / 2);
        for (let i = 0; i < words.length; i++) {
            words[i] = ((bytes[2 * i] << 8) | bytes[2 * i + 1]) & 0xffff;
        }
        this._onFrame(words);
    }
}

export class View {
    constructor(el, sendCmd) {
        this.el = el;
        this.send = sendCmd;
        this.cfg = { mode: 'auto', segDecode: 'auto', chain: 1, pos: 0 };
        this.state = null;
        el.className = 'dev-body mx-body';

        const wrap = document.createElement('div');
        wrap.className = 'mx-wrap';
        this.wrap = wrap;
        const cap = document.createElement('div');
        cap.className = 'mx-cap';
        this.cap = cap;
        el.appendChild(wrap);
        el.appendChild(cap);
        this.cv = null; this.g = null; this.geo = null;
        this._rebuild('matrix'); // provisional until the first render/config
    }

    /* Compact row icon: the live display in miniature (matrix dots, or one
     * lit 7-segment digit). Same painters as the details canvas. */
    rowIcon(el) {
        el.title = 'MAX7219 display';
        const { cv, g } = makeCanvas(22, 22, 'mx-icon');
        this.iconCv = cv; this.iconG = g;
        el.appendChild(cv);
        this._apply(this.state);
    }

    /* Geometry from the view mode — one place builds the canvas. */
    _rebuild(mode) {
        this.mode = mode;
        const geo = displayGeometry(mode);
        if (this.cv) this.cv.remove();
        const { cv, g } = makeCanvas(geo.w, geo.h, 'mx-canvas');
        this.cv = cv; this.g = g; this.geo = geo;
        this.wrap.appendChild(cv);
    }

    /* The ONE application of a display state — details canvas + row icon
     * from the same derived segments (AGENT.md §3.8). */
    _apply(state) {
        this.state = state;
        if (!state) return;
        const mode = this.cfg.mode === 'auto'
            ? (state.decodeMode ? 'seg7' : 'matrix')
            : this.cfg.mode;
        if (mode !== this.mode) this._rebuild(mode);
        const { segs, brightness } = displayFromSnapshot(state, this.cfg.segDecode);
        if (this.g) drawDisplay(this.g, this.geo, this.mode, segs, brightness);
        if (this.iconG) this._applyIcon(this.mode, segs, brightness);
        this.cap.textContent = (state.bus === 'hwspi'
            ? `hardware SPI2${state.wiring && state.wiring.mosi != null
                ? ` · MOSI GPIO${state.wiring.mosi} · SCLK GPIO${state.wiring.sclk}` : ''}`
            : `DIN GPIO${state.din} · CLK GPIO${state.clk} · LOAD GPIO${state.load}`)
            + (state.chain > 1 ? ` · chain ${state.pos + 1}/${state.chain}` : '')
            + ` · ${state.frames} frames` + (state.dmaFeeds ? ` · ${state.dmaFeeds} DMA` : '')
            + (state.dropped ? ` · ${state.dropped} dropped` : '')
            + (state.shutdown ? ' · shutdown' : '')
            + (state.test ? ' · display test' : '');
    }

    _applyIcon(mode, segs, brightness) {
        const g = this.iconG;
        g.clearRect(0, 0, 22, 22);
        const level = displayLevel(brightness);
        const lit = segs.some((s) => s);
        if (!lit) return;
        if (mode === 'seg7') {
            const d = segs.reduce((best, s, i) => (s ? i : best), -1);
            if (d >= 0) drawSeg7(g, 4, 1, 12, 20, segs[d], level);
            return;
        }
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                if ((segs[row] >> (7 - col)) & 1) {
                    g.fillStyle = `rgba(${MX_COLOR[0]},${MX_COLOR[1]},${MX_COLOR[2]},${Math.min(1, level * 1.3)})`;
                    g.beginPath();
                    g.arc(2.5 + col * 2.4, 2.5 + row * 2.4, 1, 0, Math.PI * 2);
                    g.fill();
                }
            }
        }
    }

    render(state) {
        this._apply(state);
    }

    setConfig(cfg) {
        this.cfg = {
            mode: ['auto', 'matrix', 'seg7'].includes(cfg.mode) ? cfg.mode : 'auto',
            segDecode: ['auto', 'bcd', 'raw'].includes(cfg.segDecode) ? cfg.segDecode : 'auto',
            chain: chainFrom(cfg.chain),
            pos: posFrom(cfg.pos, chainFrom(cfg.chain)),
        };
        this._apply(this.state);
    }
}
