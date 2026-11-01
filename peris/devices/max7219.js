/*
 * MAX7219 display driver — watches a firmware bit-banged 3-wire bus
 * (DIN / CLK / LOAD) and renders the latched 8-digit display as 8×8 matrix
 * dots or 7-segment digits.
 *
 * Why bit-bang only: signals routed through a hardware SPI peripheral never
 * appear in gpio_state() (M0 — the GPIO-matrix path is invisible), so the
 * device requires firmware that drives DIN/CLK/LOAD with CPU GPIO writes
 * (any soft-SPI code, delay-paced or back-to-back). CPU-driven edges are
 * only observable while a fine sampling lease is held (M4 scheduler): the
 * device arms a standing watch and escalates on the first bus edge, exactly
 * like the bit-bang I2C slave.
 *
 * Lease sizing (measured against the reference firmware, gun 0.1.0: pulses
 * with NO delays — back-to-back gpio_set_level calls): one CLK edge costs
 * ~20 instructions, the shortest CLK→DIN / CLK→CLK gap is ~20-40, the LOAD
 * fall leads the first CLK rise by ~80, a whole 16-bit frame spans ~1820.
 * So the fine lease sits at the scheduler's floor (20) — every edge then
 * lands in its own batch and DIN is never ambiguous against a CLK rise —
 * and the arm batch (60) always separates the LOAD fall from the first
 * CLK rise. Delay-paced bit-bang (esp_rom_delay_us(2), gun 0.1.5-class,
 * gaps ≥160) is covered with even wider margins. Firmwares with pulses
 * below ~20 instructions lose edges; the engine drops misaligned frames
 * and counts them in `dropped` (visible in the caption) instead of showing
 * garbage — drivers that re-push their registers periodically self-heal.
 *
 * Daisy chains: N parts share DIN/CLK/LOAD (`sharedBus`); each instance
 * latches the word that ended in its chain position (chain length + position
 * in the config). Single devices (chain 1) simply take the last word.
 */
import {
    Max7219Model, Max7219Wire, pickChainWord, displayFromSnapshot,
    drawDisplay, drawSeg7, displayLevel, displayGeometry, MX_COLOR,
} from './max7219-lib.js';
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

const pinNum = (v, dflt) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : dflt;
};

const chainFrom = (v) => {
    const n = Number(v);
    return Number.isInteger(n) ? Math.min(8, Math.max(1, n)) : 1;
};

const posFrom = (v, chain) => {
    const n = Number(v);
    return Number.isInteger(n) ? Math.min(chain - 1, Math.max(0, n)) : 0;
};

export class Device {
    static typeId = 'max7219';
    static version = '1.0.0';
    static title = 'MAX7219 Display';
    static category = 'display';
    static description = '8-digit LED driver on a firmware bit-banged DIN/CLK/LOAD bus — 8×8 matrix or 7-segment view, daisy-chainable.';
    static defaultConfig = {
        name: 'MAX7219', din: 21, clk: 13, load: 14, chain: 1, pos: 0, mode: 'auto',
    };
    /* DIN/CLK/LOAD are a bus: daisy-chained parts legally share all three. */
    static sharedBus = true;
    static pins(cfg) {
        return [pinNum(cfg.din, 21), pinNum(cfg.clk, 13), pinNum(cfg.load, 14)];
    }
    static configSchema = [
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
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.din = pinNum(cfg.din, 21);
        this.clk = pinNum(cfg.clk, 13);
        this.load = pinNum(cfg.load, 14);
        this.chain = chainFrom(cfg.chain);
        this.pos = posFrom(cfg.pos, this.chain);
        this.model = new Max7219Model();
        this.levels = { clk: null, din: null, load: null };
        this.frames = 0;   // aligned LOAD frames seen (any chain length)
        this.dropped = 0;  // misaligned frames — edges lost to sampling
        this.wire = new Max7219Wire((words, bits) => this._onFrame(words, bits));
        ctx.subscribe([this.din, this.clk, this.load]);
        ctx.armSampling(ARM_BATCH);
    }

    onEmuReady() {
        // fresh emulator: the chip powers up in shutdown, blank, scan 1 digit
        this.model.reset();
        this.wire.reset();
        this.levels = { clk: null, din: null, load: null };
        this.frames = 0;
        this.dropped = 0;
        this.ctx.armSampling(ARM_BATCH);
        this.ctx.markDirty();
    }

    onPinState(pin, s) {
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
        if (this.wire.busy) {
            // mid-frame: renew even without edges (slow bit-bang pauses)
            this.ctx.fineSampling(FINE_BATCH, FINE_HOLD_CYCLES);
        }
    }

    getState() {
        const m = this.model;
        return {
            din: this.din, clk: this.clk, load: this.load,
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
}

export class View {
    constructor(el, sendCmd) {
        this.el = el;
        this.send = sendCmd;
        this.cfg = { mode: 'auto', chain: 1, pos: 0 };
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
        const { segs, brightness } = displayFromSnapshot(state);
        if (this.g) drawDisplay(this.g, this.geo, this.mode, segs, brightness);
        if (this.iconG) this._applyIcon(this.mode, segs, brightness);
        this.cap.textContent = `DIN GPIO${state.din} · CLK GPIO${state.clk} · LOAD GPIO${state.load}`
            + (state.chain > 1 ? ` · chain ${state.pos + 1}/${state.chain}` : '')
            + ` · ${state.frames} frames` + (state.dropped ? ` · ${state.dropped} dropped` : '')
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
            chain: chainFrom(cfg.chain),
            pos: posFrom(cfg.pos, chainFrom(cfg.chain)),
        };
        this._apply(this.state);
    }
}
