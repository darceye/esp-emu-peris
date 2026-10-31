/*
 * ws2812-lib — shared helpers for the WS2812/RMT device plugin (ws2812).
 * One semantic, one implementation (AGENT.md §3.8): RMT channel RAM reads,
 * TX-busy detection, wiring discovery, the WS2812 frame decode (reset resync
 * + leading-zero realignment) and the LED-grid painters live here; the plugin
 * and the unit tests import this module. Channel parsing, the wiring-rescan
 * cadence and the page-side animator are reused from ledc-lib (never forked).
 *
 * Not listed in manifest.json → never loaded as a device itself. Page-only
 * helpers (canvas painters) must not run at import time so Node tests can
 * load this file.
 *
 * Measured emulator behaviour this builds on (M0 Q3b + M3 probe, see
 * docs/FEASIBILITY.md):
 *   - The copy encoder emits ONE RMT word per WS2812 bit: d0/l0 = the high
 *     run, d1/l1 = the low run of the same bit; the reset is one word
 *     (d0 >= 300 low) followed by ONE all-zero word (transmit terminator).
 *   - Words land at channel_word(k) = k mod 48 sequentially and WRAP, so
 *     after a transmission the RAM holds only the LAST 48 words: reset,
 *     terminator, and at most the final 46 bits of the frame — for strips
 *     longer than ~2 LEDs only the tail LEDs are recoverable (the same limit
 *     as real C3 hardware, where 48 words/channel is all the RAM there is).
 */

import { parseChannel, channelOptions, LEDC_RESCAN_BATCHES, LevelAnimator, withAlpha } from './ledc-lib.js';

/* re-exported so ws2812.js and the tests import one place */
export { parseChannel, channelOptions, LEDC_RESCAN_BATCHES, LevelAnimator, withAlpha };

/* ---- WS2812 symbol thresholds (RMT @ 10 MHz → 0.1 µs/tick) ------------------ */

/** Reset / latch: low level held ≥ 30 µs (the probe firmware sends 60 µs). */
export const WS_RESET_TICKS = 300;
/** High run > 0.6 µs is a '1' (T1H ≈ 0.8 µs, T0H ≈ 0.4 µs). */
export const WS_ONE_TICKS = 6;

/* ---- channel RAM access ----------------------------------------------------- */

/** Snapshot one RMT channel's symbol RAM (one readMem call). */
export function readRmtWords(ctx, ch) {
    const mmio = ctx.mmio;
    const bytes = ctx.readMem(mmio.rmt.ch(ch).mem, mmio.rmt.memWordsPerChannel * 4);
    const words = new Uint32Array(mmio.rmt.memWordsPerChannel);
    for (let w = 0; w < words.length; w++) {
        words[w] = (bytes[w * 4] | (bytes[w * 4 + 1] << 8) | (bytes[w * 4 + 2] << 16) | (bytes[w * 4 + 3] << 24)) >>> 0;
    }
    return words;
}

/**
 * Is the channel's TX state machine running? CHnSTATUS bits[11:9] ≠ 0 while
 * a transmission is in flight (measured: 1 = sending). Skipping the decode
 * while busy avoids latching half-overwritten RAM windows. On an emulator
 * build without STATUS the read yields 0 → never busy → decode degrades to
 * "latest snapshot wins" (a wrong frame self-corrects one batch later).
 */
export function rmtTxBusy(ctx, ch) {
    const status = ctx.readU32(ctx.mmio.rmt.ch(ch).status);
    return ((status >>> 9) & 7) !== 0;
}

/* ---- wiring discovery (GPIO matrix) ---------------------------------------- */

/** Map of RMT TX channel → GPIO-matrix output signal id for this chip. */
export function rmtSignalMap(mmio) {
    const map = new Map();
    for (let ch = 0; ch < mmio.rmt.txChannelCount; ch++) {
        const sig = mmio.signals[`rmtCh${ch}`];
        if (sig !== undefined) map.set(ch, sig);
    }
    return map;
}

/**
 * Scan every pad's GPIO_FUNCn_OUT_SEL_CFG for RMT channel routing
 * ({ channel → pin }, same approach as ledc-lib's discoverLedcPins). Empty
 * map when the chip has no MMIO table.
 */
export function discoverRmtPins(ctx) {
    const mmio = ctx.mmio;
    const found = new Map();
    if (!mmio) return found;
    const want = new Map();
    for (const [ch, sig] of rmtSignalMap(mmio)) want.set(sig, ch);
    const { funcOutSelBase, funcOutSelStride } = mmio.gpio;
    for (let pin = 0; pin < ctx.gpioCount; pin++) {
        const ch = want.get(ctx.readU32(funcOutSelBase + funcOutSelStride * pin) & 0x1ff);
        if (ch !== undefined) found.set(ch, pin);
    }
    return found;
}

/* ---- frame decode ------------------------------------------------------------ */

/**
 * Decode the post-transmission channel RAM into WS2812 LED slots (wire byte
 * order, oldest slot first). Returns null when no completed transmission is
 * present (no reset symbol), else
 *   { slots: [[w0,w1,w2], ...], bits: <visible bit count>, resetWord: <idx> }.
 *
 * Layout logic (see the file header): the reset word sits at R, the transmit
 * terminator at R+1 (all-zero — verified; also guards against a stale reset
 * whose frame was overwritten), and the last ≤46 frame bits occupy R+2..R+47
 * in address order. The window is the frame TAIL, so the LED byte grid is
 * realigned by prepending (24 − len mod 24) mod 24 zero bits — the leading
 * bits the RAM wrap destroyed (M0 measured a 2-bit loss for 8-LED frames).
 */
export function decodeWs2812(words) {
    const n = words.length;
    let resetWord = -1;
    for (let w = 0; w < n; w++) {
        const word = words[w];
        if (((word >>> 15) & 1) === 0 && (word & 0x7fff) >= WS_RESET_TICKS) resetWord = w;
    }
    if (resetWord < 0) return null;
    // the word after a completed frame's reset is the all-zero terminator
    if (words[(resetWord + 1) % n] !== 0) return null;

    const bits = [];
    for (let i = 2; i < n; i++) { // R+2 .. R+47 (mod n): the tail window
        const word = words[(resetWord + i) % n];
        if (((word >>> 15) & 1) === 1) bits.push((word & 0x7fff) > WS_ONE_TICKS ? 1 : 0);
        // level-0 runs < reset length are the low halves of bit symbols; the
        // terminator above already excluded the one that matters
    }
    const pad = (24 - (bits.length % 24)) % 24;
    const slots = [];
    for (let s = 0; s + 24 <= pad + bits.length; s += 24) {
        let v = 0;
        for (let b = 0; b < 24; b++) {
            const idx = s + b - pad;
            v = (v << 1) | (idx < 0 ? 0 : bits[idx]);
        }
        slots.push([(v >> 16) & 255, (v >> 8) & 255, v & 255]);
    }
    return { slots, bits: bits.length, resetWord };
}

/** Map wire-order slots to [r,g,b] triplets for a colour order setting. */
export function slotsToRgb(slots, order) {
    return slots.map(([w0, w1, w2]) =>
        order === 'rgb' ? [w0, w1, w2] : [w1, w0, w2]); // default GRB (WS2812)
}

/* ---- rendering (page side) ---------------------------------------------------- */

/** Device-ratio-aware canvas; returns the 2D context pre-scaled so drawing
 * coordinates are CSS pixels (page-only — must not run at import time). */
export function makeCanvas(w, h, cls) {
    const cv = document.createElement('canvas');
    if (cls) cv.className = cls;
    const dpr = globalThis.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    return { cv, g };
}

/** Brightness cap + gamma shaping (both 1/identity by default). Pure. */
export function shapeLevel(v, cap = 1, gamma = 1) {
    const x = Math.max(0, Math.min(1, v)) * Math.max(0, Math.min(1, cap));
    return gamma === 1 ? x : Math.pow(x, gamma);
}

/**
 * LED dot positions for a layout. Pure math (unit-tested); the plugin uses
 * it for the details canvas AND the row icon so both visuals share geometry.
 * Returns { w, h, dots: [{x, y, r}] } — w/h size the canvas (dots are
 * centred coordinates; unknown LEDs are simply not filled by the painter).
 */
export function ledPositions(layout, count, columns, maxW = 300) {
    const dots = [];
    const gap = 4;
    const fit = (perLine) => Math.max(6, Math.min(26, Math.floor((maxW - gap * (perLine + 1)) / perLine)));
    if (layout === 'ring') {
        const d = Math.min(22, Math.max(6, Math.floor((2 * Math.PI * (maxW / 2 - 14)) / count) - 3));
        const c = maxW / 2, R = maxW / 2 - d / 2 - 2;
        for (let i = 0; i < count; i++) {
            const a = -Math.PI / 2 + (2 * Math.PI * i) / count;
            dots.push({ x: c + R * Math.cos(a), y: c + R * Math.sin(a), r: d / 2 });
        }
        return { w: maxW, h: maxW, dots };
    }
    const cols = layout === 'matrix' ? Math.max(1, columns | 0 || Math.ceil(Math.sqrt(count))) : count;
    const rows = Math.ceil(count / cols);
    const d = fit(Math.max(cols, rows));
    for (let i = 0; i < count; i++) {
        const col = layout === 'matrix' ? i % cols : i;
        const row = layout === 'matrix' ? Math.floor(i / cols) : 0;
        dots.push({ x: gap + d / 2 + col * (d + gap), y: gap + d / 2 + row * (d + gap), r: d / 2 });
    }
    return { w: cols * d + gap * (cols + 1), h: rows * d + gap * (rows + 1), dots };
}

/**
 * Paint one addressable LED: dark body + additive colour×level glow (one
 * painter for every layout and the row icon — AGENT.md §3.8). rgb is the
 * base [r,g,b]; level a shaped 0..1 brightness. level <= 0 paints the unlit
 * body only; `unknown` leaves just a hollow placeholder (bits the channel
 * RAM window cannot recover).
 */
export function drawLedDot(g, x, y, r, rgb, level, unknown = false) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    if (unknown) {
        g.strokeStyle = 'rgba(255,255,255,0.14)';
        g.lineWidth = 1;
        g.setLineDash([2, 2]);
        g.stroke();
        g.setLineDash([]);
        return;
    }
    g.fillStyle = '#101014';
    g.fill();
    if (level > 0.003) {
        const hex = `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
        const lit = g.createRadialGradient(x * 0.96, y * 0.92, r * 0.1, x, y, r);
        lit.addColorStop(0, withAlpha(hex, Math.min(1, level * 1.3)));
        lit.addColorStop(0.6, withAlpha(hex, level));
        lit.addColorStop(1, withAlpha(hex, 0));
        g.fillStyle = lit;
        g.fill();
    }
    g.strokeStyle = level > 0.4 ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)';
    g.lineWidth = 1;
    g.stroke();
}
