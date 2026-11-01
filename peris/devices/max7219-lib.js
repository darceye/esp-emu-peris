/*
 * max7219-lib — shared helpers for the MAX7219 display device (0.9.0). One
 * semantic, one implementation (AGENT.md §3.8): the wire-level shift engine,
 * the register model (datasheet register map incl. Code B font, intensity,
 * scan limit, shutdown / display test) and the page-side painters (8×8
 * matrix dots, 7-segment digits) live here; the plugin and the unit tests
 * import this module. Not listed in manifest.json → never loaded as a device
 * itself. No page-only code runs at import time (Node tests import the file).
 *
 * Datasheet facts this encodes (MAX7219/MAX7221 datasheet, tables 2-8):
 *   - 16-bit word = 8-bit register address, then 8-bit data, MSB first;
 *     DIN is sampled on the CLK rising edge, the word is latched on the
 *     LOAD rising edge. Words shifted while LOAD is low stream through the
 *     device — a daisy chain of N parts latches the last N words.
 *   - no-decode mode data bits map one-to-one to segment lines (table 6):
 *       D7=DP D6=A D5=B D4=C D3=D D2=E D1=F D0=G
 *   - Code B decode (table 5) looks only at D3–D0 (D4–D6 disregarded);
 *     D7 is the decimal point, independent of the decoder.
 *   - power-on: all control registers reset, display blanked, SHUTDOWN mode
 *     (scan one digit, no decode, minimum intensity).
 *   - intensity = internal PWM, 16 steps from 1/32 to 31/32 duty (table 7).
 *
 * Wire model (matches what gpio_state() exposes; see i2c-lib for the M4
 * background): a sample carries each pad's END-OF-BATCH level, so the engine
 * is level-driven and reconstructs edges from level changes. DIN is always
 * stable around a CLK rising edge in SPI-mode-0 masters, so sampling the
 * current DIN level on an observed CLK rise is correct even when a DIN
 * change and a CLK edge land in the same batch — the sampling lease sizes
 * (ARM_BATCH/FINE_BATCH in max7219.js) are chosen so they never do.
 */

import { shapeLevel, drawLedDot, ledPositions } from './ws2812-lib.js';

/* Segment bits in the no-decode data byte (datasheet table 6). */
export const SEG = { DP: 0x80, A: 0x40, B: 0x20, C: 0x10, D: 0x08, E: 0x04, F: 0x02, G: 0x01 };

/** Code B font (datasheet table 5) as segment masks in the SEG layout,
 * indexed by the digit register's low nibble. */
export const CODE_B = [
    SEG.A | SEG.B | SEG.C | SEG.D | SEG.E | SEG.F,       // 0
    SEG.B | SEG.C,                                       // 1
    SEG.A | SEG.B | SEG.D | SEG.E | SEG.G,               // 2
    SEG.A | SEG.B | SEG.C | SEG.D | SEG.G,               // 3
    SEG.B | SEG.C | SEG.F | SEG.G,                       // 4
    SEG.A | SEG.C | SEG.D | SEG.F | SEG.G,               // 5
    SEG.A | SEG.C | SEG.D | SEG.E | SEG.F | SEG.G,       // 6
    SEG.A | SEG.B | SEG.C,                               // 7
    SEG.A | SEG.B | SEG.C | SEG.D | SEG.E | SEG.F | SEG.G, // 8
    SEG.A | SEG.B | SEG.C | SEG.D | SEG.F | SEG.G,       // 9
    SEG.G,                                               // 0xA '-'
    SEG.A | SEG.D | SEG.E | SEG.F | SEG.G,               // 0xB 'E'
    SEG.B | SEG.C | SEG.E | SEG.F | SEG.G,               // 0xC 'H'
    SEG.D | SEG.E | SEG.F,                               // 0xD 'L'
    SEG.A | SEG.B | SEG.E | SEG.F | SEG.G,               // 0xE 'P'
    0,                                                   // 0xF blank
];

/** Register addresses (datasheet table 2). */
export const MAX_REG = {
    NOOP: 0x00, DIGIT0: 0x01,
    DECODE: 0x09, INTENSITY: 0x0A, SCAN_LIMIT: 0x0B, SHUTDOWN: 0x0C, TEST: 0x0F,
};

/* ---- register model -------------------------------------------------------- */

/**
 * MAX7219 register file. write(addr, data) applies one latched word and
 * returns true when visible display state changed (digit bytes, mode or
 * brightness registers); no-op and undefined addresses are counted but never
 * change state. reset() reproduces the power-on state (shutdown, blank,
 * scan 1 digit, no decode, minimum intensity).
 */
export class Max7219Model {
    constructor() {
        this.reset();
    }

    reset() {
        this.digits = new Array(8).fill(0);
        this.decodeMode = 0;
        this.intensity = 0;
        this.scanLimit = 0;
        this.shutdown = true;
        this.test = false;
        this.writes = 0;
    }

    write(addr, data) {
        const a = addr & 0xff, d = data & 0xff;
        this.writes++;
        if (a >= MAX_REG.DIGIT0 && a <= MAX_REG.DIGIT0 + 7) {
            if (this.digits[a - 1] === d) return false;
            this.digits[a - 1] = d;
            return true;
        }
        switch (a) {
            case MAX_REG.DECODE:
                if (this.decodeMode === d) return false;
                this.decodeMode = d;
                return true;
            case MAX_REG.INTENSITY:
                if (this.intensity === (d & 0x0f)) return false;
                this.intensity = d & 0x0f;
                return true;
            case MAX_REG.SCAN_LIMIT:
                if (this.scanLimit === (d & 0x07)) return false;
                this.scanLimit = d & 0x07;
                return true;
            case MAX_REG.SHUTDOWN: {
                const down = (d & 1) === 0;
                if (this.shutdown === down) return false;
                this.shutdown = down;
                return true;
            }
            case MAX_REG.TEST: {
                const on = (d & 1) !== 0;
                if (this.test === on) return false;
                this.test = on;
                return true;
            }
            default:
                return false; // no-op (0x00) and undefined (0x0D/0x0E)
        }
    }

    /** Effective segment byte of one digit: Code B decode applied (D7=DP
     * independent), or the raw byte in no-decode mode. */
    digitSegments(d) {
        const raw = this.digits[d] & 0xff;
        if ((this.decodeMode >> d) & 1) return (CODE_B[raw & 0x0f]) | (raw & SEG.DP);
        return raw;
    }

    /** Average segment current duty for the intensity register (1/32…31/32). */
    brightness() {
        return (this.intensity + 1) / 32;
    }
}

/**
 * One latched LOAD frame → the word this chain position receives. Words
 * stream through the chain: the LAST word on the wire stays in the part
 * nearest the master, earlier words land further down. pos is 0-based from
 * the master (DIN) side, so pos p receives words[len-1-p]. Frames shorter
 * than the chain leave the far parts without a word (null).
 */
export function pickChainWord(words, chain, pos) {
    if (pos < 0 || pos >= chain) return null;
    const i = words.length - 1 - pos;
    return i >= 0 ? words[i] : null;
}

/**
 * Effective per-digit segment bytes for rendering, from a plain state
 * snapshot (the Device's getState output — pure function, shared by the View
 * and the unit tests): display test lights every segment, shutdown blanks,
 * digits beyond the scan limit are dark, Code B decode is applied. Returns
 * { segs: number[8], brightness }.
 */
export function displayFromSnapshot(st) {
    const segs = new Array(8).fill(0);
    const scan = Math.min(7, Math.max(0, st.scanLimit | 0));
    for (let d = 0; d < 8; d++) {
        if (st.test) segs[d] = 0xff;
        else if (!st.shutdown && d <= scan) {
            const raw = (st.digits?.[d] ?? 0) & 0xff;
            segs[d] = (st.decodeMode >> d) & 1 ? (CODE_B[raw & 0x0f] | (raw & SEG.DP)) : raw;
        }
    }
    return { segs, brightness: Math.min(15, Math.max(0, st.intensity | 0)) };
}

/* ---- wire engine ------------------------------------------------------------ */

/**
 * Level-driven MAX7219 shift register. Feed it one (clk, din, load) level
 * triple per observed pad change. A CLK rising edge shifts the current DIN
 * level in (MSB first); every 16 edges complete one word. The LOAD falling
 * edge starts a frame, the rising edge latches it: onFrame(words, bitCount)
 * fires with the decoded 16-bit words, or (null, bitCount) when the frame
 * was misaligned (a bit count that is not a multiple of 16 — the signature
 * of edges lost to sampling; the frame is dropped like a real chain would
 * ignore garbage).
 *
 * Unknown (null) levels bootstrap from the first sighting: a pad that
 * already sits at its idle level since emulator reset never produces a
 * change event, so CLK's null→high IS its first rising edge (the sigbus
 * reports changes only), while a LOAD sighting only learns the idle level —
 * a frame always needs its falling edge observed (see step()).
 *
 * Bits clocked while LOAD is high (no sane master does this) are reset at
 * the LOAD falling edge — the frame always starts clean.
 */
export class Max7219Wire {
    constructor(onFrame) {
        this.onFrame = onFrame || (() => {});
        this.reset();
    }

    reset() {
        this.clk = null;
        this.din = null;
        this.load = null;
        this.bits = 0;
        this.shift = 0;
        this.words = [];
    }

    /** A frame is in progress (LOAD observed low). */
    get busy() {
        return this.load === false;
    }

    /** One level sample; returns true when an edge was consumed. Null→high
     * on CLK counts as a genuine rising edge: the sigbus reports changes
     * only, so the pre-change level was the real sampled low (a fresh
     * emulator leaves every pad low and idle-level writes may never change
     * a pin that already sits there). LOAD latches only after its falling
     * edge was seen — a learned idle-high LOAD is not a frame. */
    step(clk, din, load) {
        this.din = din;
        let edge = false;
        if (clk && (this.clk === null || !this.clk)) { // CLK rising: sample DIN
            this.shift = ((this.shift << 1) | (din ? 1 : 0)) & 0xffff;
            this.bits++;
            edge = true;
            if (this.bits % 16 === 0) this.words.push(this.shift);
        }
        this.clk = clk;
        if (this.load !== null && load !== this.load) {
            edge = true;
            if (!load) { // LOAD falling: frame start
                this.bits = 0;
                this.shift = 0;
                this.words = [];
            } else { // LOAD rising: latch
                if (this.bits > 0) {
                    const words = this.bits % 16 === 0 && this.words.length > 0 ? this.words.slice() : null;
                    this.onFrame(words, this.bits);
                }
                this.bits = 0;
                this.words = [];
            }
        } else if (this.load === null && load !== null) {
            edge = true; // first sighting of LOAD: learn the idle level only
        }
        this.load = load;
        return edge;
    }
}

/* ---- rendering (page side) --------------------------------------------------- */

/** Classic red LED colour of MAX7219 modules (r,g,b 0-255). */
export const MX_COLOR = [255, 92, 77];

/**
 * Paint one 7-segment digit (plus DP) into a 2D context. segs is a segment
 * byte in the SEG layout; level a shaped 0..1 brightness (0 = unlit body).
 * Digits are drawn "right side up" with segment A on top; the DP dot sits at
 * the bottom-right. Pure painter, no state — the body canvas and the row
 * icon both call it (AGENT.md §3.8).
 */
export function drawSeg7(g, x, y, w, h, segs, level) {
    const th = w * 0.17;                       // segment thickness
    const gap = th * 0.35;
    const half = h / 2;
    const x1 = x + th / 2 + gap, x2 = x + w - th / 2 - gap;
    const yA = y + th / 2 + gap, yG = y + half, yD = y + h - th / 2 - gap;
    const hex = (pts) => {
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.closePath();
        g.fill();
    };
    const hseg = (cy) => hex([
        [x1 - th / 2, cy], [x1, cy - th / 2], [x2, cy - th / 2],
        [x2 + th / 2, cy], [x2, cy + th / 2], [x1, cy + th / 2],
    ]);
    const vseg = (cx, cy1, cy2) => hex([
        [cx, cy1 - th / 2], [cx + th / 2, cy1], [cx + th / 2, cy2],
        [cx, cy2 + th / 2], [cx - th / 2, cy2], [cx - th / 2, cy1],
    ]);
    const paint = (mask, shape) => {
        const on = (segs & mask) !== 0 && level > 0.003;
        g.save();
        g.fillStyle = on
            ? `rgba(${MX_COLOR[0]},${MX_COLOR[1]},${MX_COLOR[2]},${Math.min(1, level * 1.25)})`
            : 'rgba(255,255,255,0.05)';
        if (on) {
            g.shadowColor = `rgba(${MX_COLOR[0]},${MX_COLOR[1]},${MX_COLOR[2]},${Math.min(1, level)})`;
            g.shadowBlur = 6 * level;
        }
        shape();
        g.restore();
    };
    paint(SEG.A, () => hseg(yA));
    paint(SEG.B, () => vseg(x2, yA, yG - th / 2));
    paint(SEG.C, () => vseg(x2, yG + th / 2, yD));
    paint(SEG.D, () => hseg(yD));
    paint(SEG.E, () => vseg(x1, yG + th / 2, yD));
    paint(SEG.F, () => vseg(x1, yA, yG - th / 2));
    paint(SEG.G, () => hseg(yG));
    paint(SEG.DP, () => {
        g.beginPath();
        g.arc(x + w + th * 0.55, yD, th / 2, 0, Math.PI * 2);
        g.fill();
    });
}

/** Brightness level for a snapshot: intensity PWM duty, gamma-shaped. */
export function displayLevel(brightness) {
    return shapeLevel((brightness + 1) / 16, 1, 2.2);
}

/**
 * Geometry + painting of the whole 8-digit / 8×8 display into one canvas —
 * the ONE application of a display snapshot (body canvas and row icon both
 * call it). mode 'seg7' draws digits 7..0 left to right (DIG0 rightmost,
 * the usual wiring); 'matrix' draws digit d as row d, data bits D7..D0 as
 * columns left to right (segment lines are the columns of a matrix module).
 * Returns the canvas size used { w, h }.
 */
export function drawDisplay(g, geo, mode, segs, brightness) {
    const level = displayLevel(brightness);
    g.clearRect(0, 0, geo.w, geo.h);
    if (mode === 'seg7') {
        const dw = geo.dw, dh = geo.dh;
        for (let i = 0; i < 8; i++) {
            const d = 7 - i; // DIG0 rightmost
            drawSeg7(g, geo.gap + i * (dw + geo.gap + dw * 0.2), 0, dw, dh, segs[d], segs[d] ? level : 0);
        }
        return;
    }
    for (let d = 0; d < 8; d++) {
        for (let c = 0; c < 8; c++) {
            const dot = geo.dots[d * 8 + c];
            const on = (segs[d] >> (7 - c)) & 1; // D7 leftmost … D0 rightmost
            drawLedDot(g, dot.x, dot.y, dot.r, MX_COLOR, on ? level : 0);
        }
    }
}

/** Canvas geometry for one display mode (pure math; shares ledPositions for
 * the matrix grid so every MAX7219 visual uses one dot layout). */
export function displayGeometry(mode, maxW = 240) {
    if (mode === 'seg7') {
        const dw = Math.floor((maxW - 9 * 4) / 8.9); // 8 digits + gaps + dp overhang
        const dh = Math.round(dw * 1.55);
        return { w: Math.ceil(8 * (dw + 4) + dw * 0.2 + 4), h: dh, dw, dh, gap: 4 };
    }
    return ledPositions('matrix', 64, 8, maxW);
}
