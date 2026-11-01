/*
 * la-lib — shared helpers for the logic-analyzer device (0.10.0): config
 * parsing, capture readout math (level lookup, axis ticks, time formatting)
 * and the page-side waveform painter + floating window. One semantic, one
 * implementation (AGENT.md §3.8): the plugin, the unit tests and both View
 * surfaces (details mini-preview and the popup) all import this module; it
 * is not listed in manifest.json and must stay importable from Node — the
 * DOM-touching helpers (window, painter) only run when called from a View.
 *
 * Capture model (worker side, `logic-analyzer.js`):
 *   status  idle → armed (waiting for the trigger edge; arm lease holds a
 *           standing watch batch) → run (recording edges; fine lease renewed
 *           while edges flow) → done (buffer frozen, readable). 'auto'
 *           re-arms right after a capture finishes.
 *   edges   per channel a flat array [tUs, level, tUs, level, …] with times
 *           relative to the capture start (the trigger edge, or the arm
 *           moment for an immediate trigger) and levels 1/0 driven, -1
 *           released (oe dropped — drawn as a Z zone, we cannot know the
 *           pad's pulled level).
 *
 * Emulator constraints this builds on (M0/M4, docs/FEASIBILITY.md):
 *   - gpio_state() is sampled once per run_batch, so two flips inside one
 *     batch merge into a single visible edge — resolution is leased through
 *     the M4 scheduler (arm/fine batches) like the other bit-bang devices.
 *   - the guest clock is not wall-accurate (esp_rom_delay_us runs ~50% of
 *     nominal), so all displayed times are GUEST microseconds derived from
 *     the cycle counter, never wall time.
 */

/** Most channels one analyzer may claim (UI + colour palette sized for 8). */
export const MAX_CHANNELS = 8;
/** Total edge cap across all channels — protects the state push and the
 * painter; a capture that hits it stops with status 'done' + overflow. */
export const MAX_EDGES = 20000;
/** Standing watch batch (instructions) while armed — any single edge is
 * notified regardless of batch size, so the trigger resolves fine; 1000
 * matches the other M4 bus watchers. */
export const ARM_BATCH = 1000;
/** Fine batch sizes per resolution preset (instructions per batch). Edges
 * closer together than the batch merge — 'fine' sits at the scheduler floor
 * and resolves back-to-back gpio_set_level pulses (~20 instructions apart,
 * the tightest real firmware measured, gun 0.1.0). */
export const FINE_BATCHES = { fine: 20, normal: 100, coarse: 300 };
/** Fine lease budget (cycles), renewed on every edge while recording:
 * bridges the slowest plausible mid-transfer pause (delay-paced bit-bang). */
export const FINE_HOLD_CYCLES = 2000000;

/** Channel trace colours (index order, dark-theme tuned). */
export const LA_COLORS = [
    '#4fc3f7', '#ffb74d', '#81c784', '#e57373',
    '#ba68c8', '#fff176', '#4db6ac', '#f06292',
];

/**
 * Normalise a config `pins` value into a clean channel list: keeps integers
 * ≥ 0, dedupes (first occurrence wins), caps at MAX_CHANNELS. Always returns
 * a fresh array — the config merge is shallow, so mutating a default array
 * would corrupt every future device (AGENT.md §4 shallow-copy class).
 */
export function parsePins(v) {
    const out = [];
    if (!Array.isArray(v)) return out;
    for (const p of v) {
        const n = Number(p);
        if (Number.isInteger(n) && n >= 0 && !out.includes(n)) out.push(n);
        if (out.length >= MAX_CHANNELS) break;
    }
    return out;
}

/**
 * Level of one channel at time tUs (µs). flat is the channel's edge array,
 * initial the level sampled at capture start (null = never seen driven).
 * Returns 1/0/-1 (Z) or null (unknown before the first edge).
 */
export function levelAt(flat, initial, tUs) {
    let level = initial == null ? null : initial;
    for (let i = 0; i + 1 < flat.length; i += 2) {
        if (flat[i] > tUs) break;
        level = flat[i + 1];
    }
    return level;
}

/**
 * Nice axis tick step (µs) for a time span: a 1/2/5 × 10^k value that
 * yields roughly `target` ticks across the span.
 */
export function niceTickStep(spanUs, target = 6) {
    if (!(spanUs > 0)) return 1;
    const raw = spanUs / Math.max(1, target);
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / pow;
    const mult = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
    return mult * pow;
}

/** Format a guest duration in µs for labels ("840 µs", "12.5 ms", "1.20 s"). */
export function fmtUs(us) {
    if (!Number.isFinite(us)) return '—';
    if (us < 1000) return `${Math.round(us)} µs`;
    if (us < 1000000) return `${(us / 1000).toFixed(us < 10000 ? 2 : 1)} ms`;
    return `${(us / 1000000).toFixed(2)} s`;
}

/** µs↔pixel mapping for the waveform plot area (pure; painter + hover share it). */
export function waveformXform(w, gutterW, tMaxUs) {
    return viewXform(w, gutterW, { t0: 0, spanUs: tMaxUs });
}

/** µs↔pixel mapping for a zoomable view {t0, spanUs} — the Saleae-style
 * zoom/pan model: every pixel conversion funnels through here, so the
 * painter, the wheel zoom and the hover measurement always agree. */
export function viewXform(w, gutterW, view) {
    const plotW = Math.max(1, w - gutterW);
    const span = Math.max(1e-9, view.spanUs);
    const t0 = view.t0;
    return {
        usToX: (us) => gutterW + ((Math.min(Math.max(us, t0), t0 + span) - t0) / span) * plotW,
        xToUs: (x) => t0 + ((x - gutterW) / plotW) * span,
        plotW,
    };
}

/* ---- zoom / pan view model (Saleae-style) ---------------------------------- */

/** Smallest visible span (1 ns) — the zoom floor. */
export const MIN_SPAN_US = 0.001;

/** Scrollable/clampable time range for a captured state: the data extent
 * (last edge / captured time / window) plus 5% breathing room on each side.
 * Floored at 1 ms so an empty/never-captured state still yields a sane,
 * zoomable view (a 0 extent would collapse every span to 0). */
export function viewBounds(state) {
    let extent = Number(state?.windowUs) || 0;
    for (const flat of state?.edges ?? []) {
        if (flat.length >= 2) extent = Math.max(extent, flat[flat.length - 2]);
    }
    extent = Math.max(extent, Number(state?.capturedUs) || 0, 1000);
    return { tMin: -extent * 0.05, tMax: extent * 1.05, maxSpan: extent * 1.2 };
}

/** Clamp a view into the state's bounds (span floor … maxSpan, t0 inside). */
export function clampView(view, state) {
    const b = viewBounds(state);
    const spanUs = Math.min(Math.max(view.spanUs || MIN_SPAN_US, MIN_SPAN_US), b.maxSpan);
    const t0 = Math.min(Math.max(view.t0 || 0, b.tMin), b.tMax - spanUs);
    return { t0, spanUs };
}

/**
 * Zoom keeping `anchorUs` (the time under the cursor) pinned to the same
 * pixel — factor < 1 zooms in, > 1 zooms out. Pure; the wheel handler and
 * the keyboard zoom both call this.
 */
export function zoomAt(view, anchorUs, factor, state) {
    const cur = clampView(view, state);
    const f = Math.min(Math.max(factor, 0.02), 50);
    const spanUs = Math.min(Math.max(cur.spanUs * f, MIN_SPAN_US), viewBounds(state).maxSpan);
    const t0 = anchorUs - (anchorUs - cur.t0) * (spanUs / cur.spanUs);
    return clampView({ t0, spanUs }, state);
}

/* ---- hover measurement (Saleae-style) -------------------------------------- */

/**
 * The pulse (constant-level run) containing `tUs`: its level, the edge that
 * started it, the edge that ended it (null = open-ended), and the width
 * when both bounds exist. Before the first edge the level comes from
 * `initial` (null = never sampled → unknown).
 */
export function pulseAround(edges, initial, tUs) {
    let tStart = null;
    let level = initial == null ? null : initial;
    let tEnd = null;
    for (let k = 0; k + 1 < edges.length; k += 2) {
        if (edges[k] <= tUs) {
            tStart = edges[k];
            level = edges[k + 1];
        } else {
            tEnd = edges[k];
            break;
        }
    }
    return {
        level,
        tStart,
        tEnd,
        widthUs: tStart != null && tEnd != null ? tEnd - tStart : null,
    };
}

/**
 * PWM cycle containing (or nearest to) `tUs`: the interval between two
 * consecutive rising edges. Returns { periodUs, highUs, duty, freqHz } or
 * null when the channel shows no full cycle (fewer than two rising edges).
 * A high run without a following falling edge counts as high for the whole
 * period (100% duty). Z runs are ignored (not driven levels).
 */
export function pwmOf(edges, tUs) {
    const ris = [];
    for (let k = 0; k + 1 < edges.length; k += 2) {
        if (edges[k + 1] === 1) ris.push(edges[k]);
    }
    if (ris.length < 2) return null;
    let i = 0;
    while (i + 1 < ris.length && ris[i + 1] <= tUs) i++; // clamp to the last cycle
    const periodUs = ris[i + 1] - ris[i];
    if (!(periodUs > 0)) return null;
    let highUs = periodUs;
    for (let k = 0; k + 1 < edges.length; k += 2) {
        if (edges[k] > ris[i] && edges[k] < ris[i + 1] && edges[k + 1] === 0) {
            highUs = edges[k] - ris[i];
            break;
        }
    }
    return { periodUs, highUs, duty: highUs / periodUs, freqHz: 1e6 / periodUs };
}

/** One-character level label for lane gutters and the measurement bar. */
export function levelChar(level) {
    if (level === 1 || level === true) return '1';
    if (level === 0 || level === false) return '0';
    if (level === -1) return 'Z';
    return '?';
}

/** Format a frequency (Hz) for readouts ("156.3 Hz", "20.00 kHz", "1.000 MHz"). */
export function fmtHz(hz) {
    if (!Number.isFinite(hz) || hz <= 0) return '—';
    if (hz < 1000) return `${hz.toFixed(1)} Hz`;
    if (hz < 1e6) return `${(hz / 1000).toFixed(2)} kHz`;
    return `${(hz / 1e6).toFixed(3)} MHz`;
}

/* ---------------------------------------------------------------------------
 * Page-only helpers below — never executed at import time (Node-safe).
 * ------------------------------------------------------------------------- */

let topZ = 3000; // stacking counter shared by every floating window

/**
 * A draggable, resizable, NON-MODAL floating window appended to
 * document.body (position: fixed; no backdrop → the page underneath keeps
 * receiving pointer events). Header drags, bottom-right corner resizes,
 * geometry is clamped to the viewport and persisted to localStorage under
 * `storeKey`. Returns { el, body, destroy(), onResize(setup by caller) } —
 * the caller passes onResize(w, h) to re-fit its content (e.g. a canvas).
 */
export function makeFloatingWindow({ title, cls = '', storeKey = null,
    x = 80, y = 80, w = 560, h = 380, minW = 320, minH = 220, onResize }) {
    let saved = null;
    if (storeKey) {
        try { saved = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch { /* ignore */ }
    }
    const vp = () => ({ vw: window.innerWidth, vh: window.innerHeight });
    const clamp = (g) => {
        const { vw, vh } = vp();
        g.w = Math.min(Math.max(Math.round(g.w), minW), Math.max(minW, vw - 8));
        g.h = Math.min(Math.max(Math.round(g.h), minH), Math.max(minH, vh - 8));
        g.x = Math.min(Math.max(0, Math.round(g.x)), Math.max(0, vw - g.w));
        g.y = Math.min(Math.max(0, Math.round(g.y)), Math.max(0, vh - g.h));
        return g;
    };
    const geo = clamp(saved ? { ...saved } : (() => {
        // first open: cascade away from the panel, towards the viewport centre
        const { vw, vh } = vp();
        return { x: Math.max(8, (vw - w) / 2 - 60), y: Math.max(8, (vh - h) / 2 - 40), w, h };
    })());

    const el = document.createElement('div');
    el.className = `float-win ${cls}`;
    el.style.zIndex = String(++topZ);

    const head = document.createElement('div');
    head.className = 'float-win-head';
    const label = document.createElement('span');
    label.className = 'float-win-title';
    label.textContent = title;
    head.appendChild(label);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'float-win-close';
    close.title = 'Close window';
    close.textContent = '×';
    head.appendChild(close);

    const body = document.createElement('div');
    body.className = 'float-win-body';
    const grip = document.createElement('span');
    grip.className = 'float-win-resize';
    grip.title = 'Drag to resize';

    el.appendChild(head);
    el.appendChild(body);
    el.appendChild(grip);
    document.body.appendChild(el);

    const apply = () => {
        el.style.left = `${geo.x}px`;
        el.style.top = `${geo.y}px`;
        el.style.width = `${geo.w}px`;
        el.style.height = `${geo.h}px`;
    };
    apply();

    const persist = () => {
        if (!storeKey) return;
        try { localStorage.setItem(storeKey, JSON.stringify(geo)); } catch { /* ignore */ }
    };
    const emit = () => {
        apply();
        onResize?.(geo.w, geo.h);
    };

    // focus stacking: any pointerdown raises this window above its siblings
    const raise = () => { el.style.zIndex = String(++topZ); };
    el.addEventListener('pointerdown', raise);

    // --- drag by header (buttons inside the header excluded). Move/up live
    // on window (with optional pointer capture) so the drag survives the
    // cursor leaving the header — and works without an active pointer id
    // (synthetic events cannot setPointerCapture). ---
    head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button, input, select')) return;
        e.preventDefault();
        const sx = e.clientX - geo.x, sy = e.clientY - geo.y;
        try { head.setPointerCapture(e.pointerId); } catch { /* synthetic drag */ }
        const move = (ev) => {
            geo.x = ev.clientX - sx;
            geo.y = ev.clientY - sy;
            clamp(geo);
            apply();
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            persist();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    });

    // --- resize by the bottom-right corner ---
    grip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const sx = e.clientX, sy = e.clientY, w0 = geo.w, h0 = geo.h;
        try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic drag */ }
        const move = (ev) => {
            geo.w = w0 + (ev.clientX - sx);
            geo.h = h0 + (ev.clientY - sy);
            clamp(geo);
            emit();
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            persist();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    });

    let closed = false;
    const destroy = () => {
        if (closed) return;
        closed = true;
        el.remove();
    };
    return { el, body, head, close, destroy, raise, get geo() { return { ...geo }; } };
}

/**
 * (Re)size an existing canvas to a CSS box, DPI-aware — the counterpart of
 * ws2812-lib's makeCanvas for windows whose size changes at runtime.
 * Returns the 2D context scaled back to CSS pixels.
 */
export function resizeCanvas(cv, w, h) {
    const dpr = globalThis.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
}

/**
 * The ONE waveform painter — the popup canvas, the details mini-preview and
 * the row icon are three sizes of the same picture (AGENT.md §3.8). state is
 * the device's getState() payload; opts tune the chrome:
 *   gutter  draw the GPIO labels column (width px, 0 = off)
 *   axis    draw the time axis + grid ticks
 *   view    {t0, spanUs} visible window (default: fit the whole capture)
 *   hover   { x } in CSS pixels → crosshair + time readout
 *   measure { lane, from, to } → shaded pulse highlight (hover measurement)
 *   cursors { a, b } (µs|null) → Saleae-style A/B rulers with flags
 *   selectedLane  index → subtle lane tint (edge-jump channel)
 *   fitUs   legacy span override (defaults: run → window, done → captured)
 */
export function drawWaveform(g, w, h, state, opts = {}) {
    const gutter = opts.gutter ?? 54;
    const axis = opts.axis !== false;
    const axisH = axis ? Math.max(14, Math.round(h * 0.08)) : 0;
    const chs = state?.channels ?? [];
    const n = Math.max(1, chs.length);
    const view = opts.view ?? { t0: 0, spanUs: Math.max(1e-6, opts.fitUs ?? fitSpanUs(state)) };
    const t0 = view.t0, t1 = t0 + view.spanUs;

    g.clearRect(0, 0, w, h);
    const { usToX, xToUs, plotW } = viewXform(w, gutter, view);

    // lanes
    const plotH = Math.max(8, h - axisH);
    const laneH = plotH / n;
    const pad = Math.min(7, Math.max(2, laneH * 0.22));
    const laneY = (i) => i * laneH;

    // selected-lane tint (the channel edge-jump acts on)
    if (Number.isInteger(opts.selectedLane) && opts.selectedLane >= 0 && opts.selectedLane < chs.length) {
        g.fillStyle = 'rgba(255,255,255,0.04)';
        g.fillRect(0, laneY(opts.selectedLane), w, laneH);
    }

    // axis + grid (ticks derived from the visible span, not the capture)
    if (axis) {
        const step = niceTickStep(view.spanUs, Math.max(2, Math.round(plotW / 90)));
        g.strokeStyle = 'rgba(255,255,255,0.07)';
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.font = '9px ui-monospace, monospace';
        g.textAlign = 'center';
        g.lineWidth = 1;
        for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-9; t += step) {
            const x = Math.round(usToX(t)) + 0.5;
            g.beginPath();
            g.moveTo(x, 0);
            g.lineTo(x, plotH);
            g.stroke();
            g.fillText(fmtUs(t), x, h - 4);
        }
        // baseline between the lanes and the axis
        g.strokeStyle = 'rgba(255,255,255,0.12)';
        g.beginPath();
        g.moveTo(0, plotH + 0.5);
        g.lineTo(w, plotH + 0.5);
        g.stroke();
    }

    // progress mask while recording: the un-captured tail dims out
    if (state?.status === 'run' && Number.isFinite(state.capturedUs)) {
        const maskFrom = Math.max(state.capturedUs, t0);
        if (maskFrom < t1) {
            g.fillStyle = 'rgba(0,0,0,0.45)';
            g.fillRect(usToX(maskFrom), 0, Math.max(0, w - usToX(maskFrom)), plotH);
        }
    }

    // per-channel traces
    for (let i = 0; i < chs.length; i++) {
        const yTop = laneY(i) + pad;
        const yBot = laneY(i) + laneH - pad;
        const yMid = (yTop + yBot) / 2;
        const colour = LA_COLORS[i % LA_COLORS.length];
        const flat = state.edges?.[i] ?? [];
        const initial = state.initial?.[i];

        if (gutter > 0) {
            g.fillStyle = colour;
            g.font = '9.5px ui-monospace, monospace';
            g.textAlign = 'left';
            g.fillText(`GPIO${chs[i]}`, 4, yMid + 3);
            // level at the right edge of the view (Saleae shows the live value)
            g.textAlign = 'right';
            g.fillStyle = 'rgba(255,255,255,0.55)';
            g.fillText(levelChar(levelAt(flat, initial, t1)), w - 4, yMid + 3);
        }

        if (flat.length < 2 && initial == null) {
            // nothing known: dashed placeholder mid-lane
            g.strokeStyle = 'rgba(255,255,255,0.18)';
            g.setLineDash([3, 3]);
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(gutter, yMid);
            g.lineTo(w, yMid);
            g.stroke();
            g.setLineDash([]);
            continue;
        }

        g.strokeStyle = colour;
        g.lineWidth = Math.min(2, Math.max(1, laneH / 14));
        g.lineJoin = 'miter';
        g.beginPath();
        let prevY = initial == null ? yMid : initial > 0 ? yTop : initial === 0 ? yBot : yMid;
        // unknown head until the first edge (Z / never-sampled)
        if (initial == null) {
            g.setLineDash([3, 3]);
            g.moveTo(gutter, yMid);
            g.lineTo(usToX(flat[0] ?? t1), yMid);
            g.stroke();
            g.setLineDash([]);
            g.beginPath();
            prevY = yMid;
        }
        let x = gutter;
        g.moveTo(x, prevY);
        for (let k = 0; k + 1 < flat.length; k += 2) {
            const nx = usToX(flat[k]);
            const lvl = flat[k + 1];
            const ny = lvl > 0 ? yTop : lvl === 0 ? yBot : yMid;
            if (nx > x) g.lineTo(nx, prevY); // horizontal run
            g.lineTo(nx, ny);                // edge (vertical; Z drawn to mid)
            x = nx; prevY = ny;
        }
        // tail: level holds; a Z level renders dashed to the end
        if (prevY === yMid && flat.length >= 2 && flat[flat.length - 1] === -1) {
            g.lineTo(x, prevY);
            g.stroke();
            g.setLineDash([3, 3]);
            g.beginPath();
            g.moveTo(x, yMid);
            g.lineTo(w, yMid);
            g.stroke();
            g.setLineDash([]);
        } else {
            g.lineTo(w, prevY);
            g.stroke();
        }
    }

    // hover-measurement highlight: shade the measured pulse on its lane
    if (opts.measure && chs[opts.measure.lane] != null) {
        const { lane, from, to } = opts.measure;
        if (to > from) {
            const x0 = Math.max(gutter, usToX(from));
            const x1 = Math.min(w, usToX(to));
            if (x1 > x0) {
                g.fillStyle = LA_COLORS[lane % LA_COLORS.length] + '22';
                g.fillRect(x0, laneY(lane), x1 - x0, laneH);
                g.strokeStyle = LA_COLORS[lane % LA_COLORS.length] + '66';
                g.lineWidth = 1;
                g.strokeRect(x0 + 0.5, laneY(lane) + 0.5, x1 - x0 - 1, laneH - 1);
            }
        }
    }

    // trigger marker (only meaningful for a triggered capture)
    if (state?.triggered && 0 >= t0 && 0 <= t1) {
        const x = Math.round(usToX(0)) + 0.5;
        g.strokeStyle = 'rgba(255,179,64,0.85)';
        g.setLineDash([4, 3]);
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, plotH);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = 'rgba(255,179,64,0.9)';
        g.font = 'bold 9px ui-monospace, monospace';
        g.textAlign = 'left';
        g.fillText('T', x + 3, 9);
    }

    // A/B measurement cursors with letter flags
    const CURSOR_STYLE = { A: '#ffd54f', B: '#4dd0e1' };
    for (const key of ['A', 'B']) {
        const t = opts.cursors?.[key.toLowerCase()];
        if (t == null || t < t0 || t > t1) continue;
        const x = Math.round(usToX(t)) + 0.5;
        g.strokeStyle = CURSOR_STYLE[key];
        g.lineWidth = 1;
        g.setLineDash([]);
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, plotH);
        g.stroke();
        g.fillStyle = CURSOR_STYLE[key];
        g.font = 'bold 9px ui-monospace, monospace';
        g.textAlign = 'left';
        g.fillText(key, x + 3, plotH - 3);
    }

    // hover crosshair + readout
    if (opts.hover != null && opts.hover.x >= gutter) {
        const hx = Math.round(opts.hover.x) + 0.5;
        g.strokeStyle = 'rgba(255,255,255,0.35)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(hx, 0);
        g.lineTo(hx, h - axisH);
        g.stroke();
        const t = xToUs(opts.hover.x);
        const text = fmtUs(t);
        g.font = '10px ui-monospace, monospace';
        g.textAlign = hx > w - 70 ? 'right' : 'left';
        g.fillStyle = 'rgba(0,0,0,0.55)';
        const tw = g.measureText(text).width + 8;
        const tx = hx > w - 70 ? hx - tw - 2 : hx + 2;
        g.fillRect(tx, 2, tw, 14);
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.fillText(text, tx + 4, 13);
    }
}

/** Time span the painter fits: the configured window while running, the
 * actually captured extent once done (an early stop should not show empty
 * space), floored at 1 µs. Pure — shared by the View and the tests. */
export function fitSpanUs(state) {
    const win = Math.max(1e-6, Number(state?.windowUs) || 0);
    if (state?.status === 'run') return win;
    let last = 0;
    for (const flat of state?.edges ?? []) {
        if (flat.length >= 2) last = Math.max(last, flat[flat.length - 2]);
    }
    const extent = Math.max(last, Number(state?.capturedUs) || 0);
    if (!(extent > 0)) return win; // nothing captured: keep the window frame
    return Math.max(Math.min(win, extent), 1e-6);
}
