/*
 * ledc-lib — shared helpers for the LEDC-based device plugins (pwm-led,
 * rgb-led). One semantic, one implementation (AGENT.md §3.8): wiring
 * discovery, duty decode and smooth-brightness animation live here and
 * every plugin entry point calls these.
 *
 * Not listed in manifest.json → never loaded as a device itself; imported
 * relatively by the device modules (worker *and* page side) and by the
 * unit tests. Page-only helpers (canvas/animator) must not run at import
 * time so Node tests can load this file.
 */

/* ---- channel config values ------------------------------------------------ */

/**
 * Normalise a channel setting: 'auto' (any case) stays 'auto'; an integer
 * inside [0, count) becomes that number (the generic editor's <select>
 * hands back strings, so '3' must work); anything else falls back to
 * 'auto'.
 */
export function parseChannel(v, count) {
    if (v == null || (typeof v === 'string' && v.trim().toLowerCase() === 'auto')) return 'auto';
    const n = Number(v); // NB: Number(null) is 0 — handled above
    if (Number.isInteger(n) && n >= 0 && n < count) return n;
    return 'auto';
}

/** <option> list for a channel select field: Auto + Channel 0..count-1. */
export function channelOptions(count) {
    const opts = [{ value: 'auto', label: 'Auto (discover)' }];
    for (let i = 0; i < count; i++) opts.push({ value: i, label: `Channel ${i}` });
    return opts;
}

/* ---- wiring discovery (GPIO matrix) --------------------------------------- */

/** Map of LEDC channel → GPIO-matrix output signal id for this chip. */
export function ledcSignalMap(mmio) {
    const map = new Map();
    for (let ch = 0; ch < mmio.ledc.channelCount; ch++) {
        const sig = mmio.signals[`ledcCh${ch}`];
        if (sig !== undefined) map.set(ch, sig);
    }
    return map;
}

/**
 * Scan every pad's GPIO_FUNCn_OUT_SEL_CFG register and return
 * { channel → pin } for the pads the firmware currently routes to an LEDC
 * channel (M0: the routing is readable; low 9 bits hold the signal id,
 * 0x100 = plain GPIO). One readU32 per pad — cheap next to a 50k-instruction
 * batch. Returns an empty map when the chip has no MMIO table.
 */
export function discoverLedcPins(ctx) {
    const mmio = ctx.mmio;
    const found = new Map();
    if (!mmio) return found;
    const want = new Map(); // signal id → channel
    for (const [ch, sig] of ledcSignalMap(mmio)) want.set(sig, ch);
    const { funcOutSelBase, funcOutSelStride } = mmio.gpio;
    for (let pin = 0; pin < ctx.gpioCount; pin++) {
        const ch = want.get(ctx.readU32(funcOutSelBase + funcOutSelStride * pin) & 0x1ff);
        if (ch !== undefined) found.set(ch, pin);
    }
    return found;
}

/* ---- duty decode ----------------------------------------------------------- */

/**
 * Read one LEDC channel: enabled flag + duty as a 0..1 fraction. DUTY_R is
 * bits[18:4] (reg = dutyCounts << 4, M0 Q2b); full-scale counts come from
 * the channel's timer DUTY_RES field via conf0.TIMER_SEL. Three readU32
 * calls. A disabled channel reads as fraction 0 (the pad would idle low).
 */
export function readLedcChannel(ctx, ch) {
    const mmio = ctx.mmio;
    const regs = mmio.ledc.ch(ch);
    const conf0 = ctx.readU32(regs.conf0);
    const enabled = ((conf0 >>> 2) & 1) === 1;
    const res = ctx.readU32(mmio.ledc.timer(conf0 & 0x3).conf) & 0xf;
    const counts = ctx.readU32(regs.dutyR) >>> mmio.ledc.dutyShift;
    const max = res > 0 ? (1 << res) - 1 : 0;
    const fraction = enabled && max > 0 ? Math.min(1, counts / max) : 0;
    return { enabled, resolution: res, counts, fraction };
}

/** Batches between wiring re-checks (auto-binding follows firmware rewiring). */
export const LEDC_RESCAN_BATCHES = 24;

/** Duty quantisation (1/1000): below this a change is invisible on screen
 * and would only spam the ~30fps state channel. */
export function quantiseDuty(f) {
    return Math.round(f * 1000) / 1000;
}

/* ---- smooth rendering (page side) ------------------------------------------ */

/** One exponential-smoothing step toward the target (pure, unit-tested). */
export function lerpStep(cur, target, dtMs, tauMs = 90) {
    return cur + (target - cur) * (1 - Math.exp(-dtMs / tauMs));
}

/**
 * Continuous-brightness animation: setTarget(levels) starts a rAF loop;
 * each frame every level eases toward its target and onFrame(levels)
 * repaints ALL visuals of the plugin (canvas bulb + row icon — one render
 * path, AGENT.md §3.8). The loop stops once converged; the next setTarget
 * restarts it. Without requestAnimationFrame (tests) it is inert.
 */
export class LevelAnimator {
    constructor(onFrame) {
        this.onFrame = onFrame;
        this.cur = null;
        this.target = null;
        this.raf = 0;
        this.lastT = 0;
        this.tick = (t) => {
            const dt = this.lastT ? Math.min(64, t - this.lastT) : 16;
            this.lastT = t;
            let live = false;
            this.cur = this.target.map((tv, i) => {
                const v = lerpStep(this.cur[i], tv, dt);
                if (Math.abs(tv - v) > 0.001) live = true;
                return v;
            });
            this.onFrame(this.cur);
            this.raf = live ? requestAnimationFrame(this.tick) : 0;
        };
    }

    setTarget(levels) {
        this.target = levels.slice();
        if (this.cur == null) this.cur = levels.map(() => 0);
        if (this.raf === 0 && typeof requestAnimationFrame === 'function') {
            this.lastT = 0;
            this.raf = requestAnimationFrame(this.tick);
        }
    }
}

/** '#rrggbb' → 'rgba(r,g,b,a)' (invalid input falls back to white). */
export function withAlpha(hex, a) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    const r = Number.isFinite(n) ? (n >> 16) & 255 : 255;
    const g = Number.isFinite(n) ? (n >> 8) & 255 : 255;
    const b = Number.isFinite(n) ? n & 255 : 255;
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}

/** Additive mix of channel colours scaled by their levels → '#rrggbb'. */
export function mixHex(colours, levels) {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < colours.length; i++) {
        const lv = Math.max(0, Math.min(1, levels[i] ?? 0));
        const n = parseInt(String(colours[i]).replace('#', ''), 16);
        if (!Number.isFinite(n)) continue;
        r += ((n >> 16) & 255) * lv;
        g += ((n >> 8) & 255) * lv;
        b += (n & 255) * lv;
    }
    const c = (v) => Math.round(Math.min(255, v)).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Device-ratio-aware square canvas for a bulb View; returns the 2D context
 * pre-scaled so drawing coordinates are CSS pixels.
 */
export function makeBulbCanvas(size = 96) {
    const cv = document.createElement('canvas');
    cv.className = 'pwm-bulb';
    const dpr = globalThis.devicePixelRatio || 1;
    cv.width = Math.round(size * dpr);
    cv.height = Math.round(size * dpr);
    cv.style.width = `${size}px`;
    cv.style.height = `${size}px`;
    const g = cv.getContext('2d');
    g.scale(dpr, dpr);
    return { cv, g, size };
}

/**
 * Paint an LED bulb: dark body + one additive radial gradient per channel
 * (colour × level) — additive light mixing, so a three-diode RGB bulb
 * blends like the real thing. Returns the peak level (for outer glow).
 */
export function drawBulb(g, size, colours, levels) {
    const r = size / 2;
    g.clearRect(0, 0, size, size);
    const body = g.createRadialGradient(r * 0.76, r * 0.68, r * 0.1, r, r, r);
    body.addColorStop(0, '#1d1d23');
    body.addColorStop(0.72, '#101014');
    body.addColorStop(1, '#0a0a0d');
    g.fillStyle = body;
    g.beginPath();
    g.arc(r, r, r - 1.5, 0, Math.PI * 2);
    g.fill();

    let peak = 0;
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < colours.length; i++) {
        const lv = Math.max(0, Math.min(1, levels[i] ?? 0));
        if (lv <= 0.003) continue;
        peak = Math.max(peak, lv);
        const lit = g.createRadialGradient(r * 0.76, r * 0.68, 0, r, r, r);
        lit.addColorStop(0, withAlpha(colours[i], Math.min(1, lv * 1.25)));
        lit.addColorStop(0.55, withAlpha(colours[i], lv));
        lit.addColorStop(1, withAlpha(colours[i], 0));
        g.fillStyle = lit;
        g.beginPath();
        g.arc(r, r, r - 2, 0, Math.PI * 2);
        g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    return peak;
}
