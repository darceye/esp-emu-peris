/*
 * Logic analyzer — multi-channel GPIO waveform capture for firmware-driven
 * (bit-banged) signals: up to MAX_CHANNELS arbitrary GPIOs, one trigger
 * (channel + edge, or immediate), a guest-time capture window and an
 * optional auto re-arm. The waveform UI is a large, draggable + resizable
 * floating window (non-modal: the page underneath keeps working); the row
 * icon and the expanded details show a live mini-preview that opens the
 * window on click.
 *
 * Sampling rides the M4 scheduler like the other bit-bang devices:
 * armed → a standing ARM_BATCH watch (any single edge is notified whatever
 * the batch size, so the trigger always resolves); recording → a fine lease
 * (FINE_BATCHES[resolution]) renewed on every edge and from onBatch while
 * edges keep flowing, expiring on its deadline or a CPU-sleep fast-forward.
 * Two flips inside one batch merge into one visible edge — the resolution
 * preset picks how fine that is (M0 Q1a; 'fine' = the scheduler floor,
 * resolving back-to-back gpio_set_level pulses).
 *
 * Levels are 1/0 while the guest drives the pad and -1 (Z) when it releases
 * it (oe drops) — the pad's pulled level is unknowable from gpio_state().
 * Times are GUEST µs from the cycle counter (the guest clock is not
 * wall-accurate, M4). Capture data is pushed in full only when the buffer
 * freezes (status 'done') — during 'run' the state carries progress +
 * per-channel edge counts, keeping the ~30 fps pushes tiny.
 */
import {
    parsePins, MAX_CHANNELS, MAX_EDGES, ARM_BATCH, FINE_BATCHES, FINE_HOLD_CYCLES,
    drawWaveform, fitSpanUs, makeFloatingWindow, resizeCanvas, fmtUs, fmtHz,
    viewXform, clampView, zoomAt, pulseAround, pwmOf, levelChar, LA_COLORS,
} from './la-lib.js';
import { makeCanvas } from './ws2812-lib.js';

/* re-exported so tests and the plugin import one place (ws2812-lib pattern) */
export { MAX_CHANNELS, MAX_EDGES, ARM_BATCH, FINE_BATCHES, FINE_HOLD_CYCLES };

/** Progress push cadence while recording (guest cycles between markDirty). */
const PROGRESS_CYCLES = 2000000;

const clampNum = (v, dflt, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export class Device {
    static typeId = 'logic-analyzer';
    static version = '1.0.0';
    static title = 'Logic analyzer';
    static category = 'instrument';
    static description = 'Multi-GPIO waveform capture — click the row icon (or the preview) for the draggable analyzer window; trigger, window and resolution configurable.';
    static defaultConfig = {
        name: 'LA', pins: [], durationMs: 50, resolution: 'normal', trigCh: -1, trigEdge: 'any',
    };
    /* A probe taps lines without driving them: sharing pads with other bus
     * devices (I2C lines, MAX7219 buses, other analyzers) is legal wiring. */
    static sharedBus = true;
    static pins(cfg) { return parsePins(cfg.pins); }
    static configSchema = [
        { key: 'durationMs', label: 'Window (ms)', type: 'number', min: 1, max: 1000, step: 1 },
        { key: 'resolution', label: 'Resolution', type: 'select', options: [
            { value: 'fine', label: 'Fine — tightest pulses (slowest)' },
            { value: 'normal', label: 'Normal (default)' },
            { value: 'coarse', label: 'Coarse — fastest' },
        ] },
        { key: 'name', label: 'Label', type: 'text' },
        // channels (pins), trigger channel/edge are edited in the analyzer
        // window (they need the channel picker); they live in defaultConfig
        // so normaliseConfig keeps them across config round-trips
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.pins = parsePins(cfg.pins);
        this.windowMs = clampNum(cfg.durationMs, 50, 1, 1000);
        this.fine = FINE_BATCHES[cfg.resolution] ?? FINE_BATCHES.normal;
        const tc = Number(cfg.trigCh);
        this.trigCh = Number.isInteger(tc) && tc >= 0 && tc < this.pins.length ? tc : -1;
        this.trigEdge = ['any', 'rise', 'fall'].includes(cfg.trigEdge) ? cfg.trigEdge : 'any';
        this.autoRun = false;   // session control (Arm button), not config

        this.status = 'idle';   // idle | armed | run | done
        this.triggered = false;
        this.overflow = false;
        this.capId = 0;         // bumped at every _start — the View resets
                                //   its zoom/cursors when it changes
        this.t0 = 0;            // capture start (cycles)
        this.windowCycles = 0;
        this.edges = this.pins.map(() => []);   // per channel [tUs, level, …]
        this.initial = this.pins.map(() => null);
        this.capturedUs = 0;
        this.lastEdgeCycles = -1;
        this.lastMarkCycles = 0;
        this.cpus = ctx.cyclesPerUs || 160;
        if (this.pins.length) ctx.subscribe(this.pins);
    }

    onEmuReady() {
        // fresh emulator: no waveform history survives, leases are gone
        this._resetData();
        this.status = 'idle';
        this.autoRun = false;
        this.capId = 0;
        this.cpus = this.ctx.cyclesPerUs || 160;
        this.ctx.markDirty();
    }

    onPinState(pin, s) {
        const level = s.oe ? (s.out ? 1 : 0) : -1;
        if (this.status === 'armed') {
            // trigger watch: the edge must sit on the trigger channel and
            // match the direction (rising arrives as level 1; a release to
            // Z counts as falling, the open-drain idiom)
            if (pin !== this.pins[this.trigCh]) return;
            if (this.trigEdge === 'rise' && level !== 1) return;
            if (this.trigEdge === 'fall' && level !== 0 && level !== -1) return;
            this._start(s.cycles, { pin, level });
            return;
        }
        if (this.status !== 'run') return;
        const idx = this.pins.indexOf(pin);
        if (idx < 0) return;
        const tUs = (s.cycles - this.t0) / this.cpus;
        if (tUs < 0) return;
        this.edges[idx].push(tUs, level);
        this.lastEdgeCycles = s.cycles;
        this.ctx.fineSampling(this.fine, FINE_HOLD_CYCLES);
        if (this.edges.reduce((n, a) => n + a.length, 0) > MAX_EDGES * 2) {
            this._finish(true); // buffer full — freeze what we have
        }
    }

    onBatch() {
        if (this.status !== 'run') return;
        const now = this.ctx.cycles();
        if (now - this.t0 >= this.windowCycles) {
            this._finish(false);
            return;
        }
        // renew the fine lease only while edges keep flowing — a quiet line
        // falls back to the arm batch, and the NEXT isolated edge still
        // lands (single flips are notified at any batch size)
        if (this.lastEdgeCycles >= 0 && now - this.lastEdgeCycles <= FINE_HOLD_CYCLES) {
            this.ctx.fineSampling(this.fine, FINE_HOLD_CYCLES);
        }
        if (now - this.lastMarkCycles >= PROGRESS_CYCLES) {
            this.lastMarkCycles = now;
            this.ctx.markDirty(); // progress readout while recording
        }
    }

    onCommand(cmd, params) {
        if (cmd === 'arm') {
            if (this.status === 'run' || this.status === 'armed') return;
            this.autoRun = !!(params && params.auto);
            this.overflow = false;
            if (this.trigCh >= 0 && this.pins.length) {
                this.status = 'armed';
                this.ctx.armSampling(ARM_BATCH);
            } else {
                this._start(this.ctx.cycles(), null); // immediate
            }
            this.ctx.markDirty();
        } else if (cmd === 'stop') {
            if (this.status === 'run') this._finish(false);
            else if (this.status === 'armed') {
                this.status = 'idle';
                this.autoRun = false;
                this.ctx.releaseSampling();
                this.ctx.markDirty();
            }
        } else if (cmd === 'clear') {
            this._resetData();
            this.status = 'idle';
            this.autoRun = false;
            this.ctx.releaseSampling();
            this.ctx.markDirty();
        }
    }

    getState() {
        const live = this.status === 'run';
        const capturedUs = live
            ? Math.min(this.windowMs * 1000, Math.max(0, (this.ctx.cycles() - this.t0) / this.cpus))
            : this.capturedUs;
        const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
        return {
            status: this.status,
            auto: this.autoRun,
            overflow: this.overflow,
            capId: this.capId,
            channels: this.pins.slice(),
            windowUs: this.windowMs * 1000,
            capturedUs,
            triggered: this.triggered,
            // full waveform only once frozen — the ~30 fps run pushes carry
            // progress + live per-channel edge counts instead
            edges: live
                ? this.pins.map(() => [])
                : this.edges.map((a) => a.map(r3)),
            initial: live ? this.pins.map(() => null) : this.initial.slice(),
            counts: this.edges.map((a) => a.length / 2),
            totalEdges: this.edges.reduce((n, a) => n + a.length / 2, 0),
        };
    }

    destroy() {
        this.ctx.releaseSampling();
        this.ctx.unsubscribe();
    }

    _resetData() {
        this.edges = this.pins.map(() => []);
        this.initial = this.pins.map(() => null);
        this.capturedUs = 0;
        this.triggered = false;
        this.overflow = false;
        this.lastEdgeCycles = -1;
    }

    /** Begin recording at `cycles` (the trigger edge's own sample time when
     * triggered; the command time for an immediate start). */
    _start(cycles, trig) {
        this.t0 = cycles;
        this.windowCycles = this.windowMs * 1000 * this.cpus;
        this._resetData();
        this.status = 'run';
        this.capId++; // fresh capture → the View re-fits zoom/cursors
        this.lastMarkCycles = cycles;
        // channel levels at capture start; the trigger channel's pre-edge
        // level is the edge's complement, every other pad is snapshotted
        // (pinLevel speaks booleans — the waveform speaks 1/0/-1)
        for (let i = 0; i < this.pins.length; i++) {
            const lvl = this.ctx.pinLevel(this.pins[i]);
            this.initial[i] = lvl == null ? null : lvl ? 1 : 0;
        }
        if (trig) {
            const idx = this.pins.indexOf(trig.pin);
            if (idx >= 0) {
                if (trig.level === 1 || trig.level === 0) this.initial[idx] = trig.level ? 0 : 1;
                this.edges[idx].push(0, trig.level); // the trigger edge itself
                this.lastEdgeCycles = cycles;
            }
        }
        this.triggered = !!trig;
        this.ctx.armSampling(ARM_BATCH); // single flips stay visible while idle-ish
        this.ctx.fineSampling(this.fine, FINE_HOLD_CYCLES);
        this.ctx.markDirty();
    }

    _finish(overflow) {
        this.status = 'done';
        this.overflow = overflow;
        this.capturedUs = Math.min(this.windowMs * 1000,
            Math.max(0, (this.ctx.cycles() - this.t0) / this.cpus));
        if (this.autoRun) {
            if (this.trigCh >= 0 && this.pins.length) {
                this.status = 'armed'; // wait for the next trigger
                this.ctx.armSampling(ARM_BATCH);
            } else {
                // auto + Immediate would restart instantly and overwrite the
                // frozen buffer before any push could show it — pointless
                // churn, so auto quietly disarms instead
                this.autoRun = false;
                this.ctx.releaseSampling();
                this.ctx.log('logic-analyzer: auto re-arm needs a trigger channel — staying idle', 'warn');
            }
        } else {
            this.ctx.releaseSampling();
        }
        this.ctx.markDirty();
    }
}

/* ---------------------------------------------------------------------------
 * Page side. Three visuals, one painter (AGENT.md §3.8): the row icon, the
 * details mini-preview and the floating analyzer window all call
 * drawWaveform on the same captured state.
 * ------------------------------------------------------------------------- */

export class View {
    constructor(el, sendCmd, host) {
        this.el = el;
        this.send = sendCmd;
        this.host = host;
        this.cfg = { name: 'LA', pins: [], durationMs: 50, resolution: 'normal', trigCh: -1, trigEdge: 'any' };
        this.state = null;
        this.autoUI = false;  // session Auto re-arm checkbox (an Arm control)
        this.hover = null;
        this.win = null;
        // Saleae-style plot model: zoomable view, hover measurement, A/B
        // cursors, selected channel (edge jumps act on it)
        this.view = null;                 // {t0, spanUs}; null = fit
        this.capSeen = -1;                // capId the view was built for
        this.cursors = { a: null, b: null };
        this.selCh = null;
        this.measure = null;              // {lane, from, to} painter highlight
        this.measureInfo = null;          // {ch, pulse, pwm} for the bar
        this.drag = null;                 // active pan / cursor drag
        this.cursorTimer = null;          // click-vs-dblclick debounce
        this.plotW = 10;

        el.className = 'dev-body la-body';
        const mini = document.createElement('div');
        mini.className = 'la-mini';
        this.miniWrap = mini;
        const { cv, g } = makeCanvas(300, 64, 'la-mini-cv');
        this.miniCv = cv; this.miniG = g;
        mini.appendChild(cv);
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'la-open';
        open.textContent = '⤢ open analyzer window';
        open.title = 'Open the draggable analyzer window (drag header to move, corner to resize; the page keeps working underneath)';
        const cap = document.createElement('div');
        cap.className = 'la-cap';
        this.cap = cap;
        mini.addEventListener('click', () => this.openWin());
        open.addEventListener('click', () => this.openWin());
        el.appendChild(mini);
        el.appendChild(open);
        el.appendChild(cap);
    }

    rowIcon(el) {
        el.title = 'Logic analyzer — click to open the analyzer window';
        const { cv, g } = makeCanvas(22, 22, 'la-icon');
        this.iconCv = cv; this.iconG = g;
        cv.addEventListener('click', () => this.openWin());
        el.appendChild(cv);
        this._apply();
    }

    /* One application of a captured state → icon + mini + window. */
    _apply() {
        const st = this.state;
        const optsMini = { gutter: 40, axis: false };
        if (this.iconG) {
            this.iconG.clearRect(0, 0, 22, 22);
            if (st && st.channels.length) {
                drawWaveform(this.iconG, 22, 22, st, { gutter: 0, axis: false });
            } else {
                this.iconG.strokeStyle = 'rgba(255,255,255,0.3)';
                this.iconG.lineWidth = 1.5;
                this.iconG.beginPath();
                this.iconG.moveTo(3, 15); this.iconG.lineTo(8, 15); this.iconG.lineTo(8, 7);
                this.iconG.lineTo(14, 7); this.iconG.lineTo(14, 15); this.iconG.lineTo(19, 15);
                this.iconG.stroke();
            }
            if (st) {
                // status dot: armed=warn, run=ok, done=muted
                this.iconG.fillStyle = st.status === 'armed' ? '#ffb340'
                    : st.status === 'run' ? '#7ad17a' : 'rgba(255,255,255,0.35)';
                this.iconG.beginPath();
                this.iconG.arc(18, 4, 2.4, 0, Math.PI * 2);
                this.iconG.fill();
            }
        }
        if (this.miniG) drawWaveform(this.miniG, 300, 64, st, optsMini);
        this._renderCaption();
        if (this.win) this._renderWin();
    }

    _renderCaption() {
        const st = this.state;
        if (!st || !st.channels.length) {
            this.cap.textContent = 'no channels — open the window and pick GPIOs to probe';
            return;
        }
        const parts = [st.channels.map((p) => `GPIO${p}`).join(', '),
            st.status === 'run' ? `capturing ${fmtUs(st.capturedUs)} / ${fmtUs(st.windowUs)}`
                : st.capturedUs > 0 ? fmtUs(st.capturedUs) : '—',
            `${st.totalEdges} edges`];
        this.cap.textContent = parts.join(' · ') + (st.overflow ? ' · buffer full' : '');
    }

    render(state) {
        this.state = state;
        this._apply();
    }

    setConfig(cfg) {
        this.cfg = {
            name: String(cfg.name ?? 'LA'),
            pins: parsePins(cfg.pins),
            durationMs: clampNum(cfg.durationMs, 50, 1, 1000),
            resolution: FINE_BATCHES[cfg.resolution] ? cfg.resolution : 'normal',
            trigCh: Number.isInteger(Number(cfg.trigCh)) ? Number(cfg.trigCh) : -1,
            trigEdge: ['any', 'rise', 'fall'].includes(cfg.trigEdge) ? cfg.trigEdge : 'any',
        };
        if (this.win) {
            this.winTitle.textContent = `⌁ Logic analyzer — ${this.cfg.name}`;
            this._syncWinControls();
            this._renderChans();
        }
        this._apply();
    }

    destroy() {
        this.destroyWin();
    }

    /* ---- the floating analyzer window ------------------------------------- */

    openWin() {
        if (this.win) {
            this.win.raise(); // bring an existing window above its siblings
            return;
        }
        const win = makeFloatingWindow({
            title: `⌁ Logic analyzer — ${this.cfg.name}`,
            cls: 'la-win',
            storeKey: 'peris.la.win.v1',
            w: 680, h: 440, minW: 360, minH: 240,
            onResize: () => this._fitCanvas(),
        });
        this.win = win;
        this.winTitle = win.head.querySelector('.float-win-title');
        win.close.addEventListener('click', () => this.destroyWin());

        const bar = document.createElement('div');
        bar.className = 'la-bar';
        this.armBtn = this._btn('la-arm', '● Arm', 'Start capturing (immediately, or when the trigger fires)',
            () => this.send('arm', { auto: this.autoUI }));
        this.stopBtn = this._btn('la-stop', '■ Stop', 'Stop the running capture / disarm',
            () => this.send('stop'));
        this.clearBtn = this._btn('la-clear', 'clear', 'Erase the captured waveform',
            () => this.send('clear'));
        bar.appendChild(this.armBtn);
        bar.appendChild(this.stopBtn);
        bar.appendChild(this.clearBtn);

        const trigLab = document.createElement('span');
        trigLab.className = 'la-lab';
        trigLab.textContent = 'Trigger';
        this.trigSel = document.createElement('select');
        this.trigSel.title = 'Capture starts on this channel\'s edge (Immediate = start at Arm)';
        this.trigSel.addEventListener('change', () =>
            this.host.updateConfig({ trigCh: Number(this.trigSel.value) }));
        this.edgeSel = document.createElement('select');
        for (const [v, l] of [['any', 'any edge'], ['rise', 'rising'], ['fall', 'falling']]) {
            const o = document.createElement('option');
            o.value = v; o.textContent = l;
            this.edgeSel.appendChild(o);
        }
        this.edgeSel.addEventListener('change', () =>
            this.host.updateConfig({ trigEdge: this.edgeSel.value }));
        bar.appendChild(trigLab);
        bar.appendChild(this.trigSel);
        bar.appendChild(this.edgeSel);

        const winLab = document.createElement('span');
        winLab.className = 'la-lab';
        winLab.textContent = 'Window';
        this.winInput = document.createElement('input');
        this.winInput.type = 'number';
        this.winInput.min = '1'; this.winInput.max = '1000'; this.winInput.step = '1';
        this.winInput.title = 'Capture window length in guest milliseconds (emulator time is not wall time)';
        this.winInput.addEventListener('change', () =>
            this.host.updateConfig({ durationMs: clampNum(this.winInput.value, 50, 1, 1000) }));
        const winMs = document.createElement('span');
        winMs.className = 'la-lab';
        winMs.textContent = 'ms';
        bar.appendChild(winLab);
        bar.appendChild(this.winInput);
        bar.appendChild(winMs);

        this.resSel = document.createElement('select');
        for (const [v, l] of [['fine', 'fine'], ['normal', 'normal'], ['coarse', 'coarse']]) {
            const o = document.createElement('option');
            o.value = v; o.textContent = l;
            this.resSel.appendChild(o);
        }
        this.resSel.title = 'Sampling resolution: edges closer together than the batch size merge';
        this.resSel.addEventListener('change', () =>
            this.host.updateConfig({ resolution: this.resSel.value }));
        bar.appendChild(this.resSel);

        this.autoCb = document.createElement('input');
        this.autoCb.type = 'checkbox';
        this.autoCb.id = `la-auto-${Math.random().toString(36).slice(2, 8)}`;
        this.autoCb.title = 'Re-arm automatically after each capture (pick a trigger channel — Immediate ignores auto)';
        this.autoCb.addEventListener('change', () => {
            this.autoUI = this.autoCb.checked;
        });
        const autoLab = document.createElement('label');
        autoLab.className = 'la-auto';
        autoLab.htmlFor = this.autoCb.id;
        autoLab.appendChild(this.autoCb);
        const t = document.createElement('span');
        t.textContent = 'auto';
        autoLab.appendChild(t);
        bar.appendChild(autoLab);

        // view cluster: zoom in/out/fit + edge jumps of the selected channel
        const spacer = document.createElement('span');
        spacer.className = 'la-bar-spacer';
        bar.appendChild(spacer);
        this.zoomInBtn = this._btn('la-zbtn', '＋', 'Zoom in (wheel up / +)', () => this._zoomCenter(1 / 1.35));
        this.zoomOutBtn = this._btn('la-zbtn', '－', 'Zoom out (wheel down / -)', () => this._zoomCenter(1.35));
        this.fitBtn = this._btn('la-zbtn', '⤢', 'Zoom to fit (F / double-click the plot)', () => this._fit());
        this.prevEdgeBtn = this._btn('la-zbtn', '‹', 'Jump to the previous edge of the selected channel (←). Click a channel label in the plot to select.',
            () => this._jumpEdge(-1));
        this.nextEdgeBtn = this._btn('la-zbtn', '›', 'Jump to the next edge of the selected channel (→)',
            () => this._jumpEdge(1));
        bar.appendChild(this.zoomInBtn);
        bar.appendChild(this.zoomOutBtn);
        bar.appendChild(this.fitBtn);
        bar.appendChild(this.prevEdgeBtn);
        bar.appendChild(this.nextEdgeBtn);

        const chans = document.createElement('div');
        chans.className = 'la-chans';
        this.chansEl = chans;

        const wrap = document.createElement('div');
        wrap.className = 'la-plot';
        wrap.tabIndex = 0; // keyboard: ←/→ edge jump, +/- zoom, F fit
        const { cv } = makeCanvas(10, 10, 'la-cv');
        this.plotCv = cv;
        this.plotG = cv.getContext('2d');
        wrap.appendChild(cv);
        this.hint = document.createElement('div');
        this.hint.className = 'la-hint';
        this.hint.textContent = 'tick GPIOs above to add channels';
        wrap.appendChild(this.hint);
        this.plotWrap = wrap;
        this._wirePlot(wrap);

        // measurement bar: hover readout (pulse/period/frequency/duty) and
        // the A/B cursor delta — Saleae's two signature measurements
        this.measureBar = document.createElement('div');
        this.measureBar.className = 'la-measure';
        this.mHover = document.createElement('span');
        this.mHover.className = 'm-hover';
        this.mCurs = document.createElement('span');
        this.mCurs.className = 'm-curs';
        this.mClear = this._btn('la-cursor-clear', '✕ cursors', 'Remove both measurement cursors', () => {
            this.cursors = { a: null, b: null };
            this._renderWin();
        });
        this.measureBar.appendChild(this.mHover);
        this.measureBar.appendChild(this.mCurs);
        this.measureBar.appendChild(this.mClear);

        this.foot = document.createElement('div');
        this.foot.className = 'la-foot';

        win.body.appendChild(bar);
        win.body.appendChild(chans);
        win.body.appendChild(wrap);
        win.body.appendChild(this.measureBar);
        win.body.appendChild(this.foot);

        this.ro = new ResizeObserver(() => this._fitCanvas());
        this.ro.observe(wrap);

        this._syncWinControls();
        this._renderChans();
        this._fitCanvas();
        this._renderWin();
    }

    destroyWin() {
        if (this.cursorTimer != null) { clearTimeout(this.cursorTimer); this.cursorTimer = null; }
        this.drag = null;
        this.ro?.disconnect();
        this.ro = null;
        this.win?.destroy();
        this.win = null;
        this.hover = null;
        this.measure = null;
        this.measureInfo = null;
    }

    _btn(cls, text, title, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `la-btn ${cls}`;
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    _syncWinControls() {
        if (!this.win) return;
        const c = this.cfg;
        this.trigSel.innerHTML = '';
        const imm = document.createElement('option');
        imm.value = '-1'; imm.textContent = 'Immediate';
        this.trigSel.appendChild(imm);
        for (let i = 0; i < c.pins.length; i++) {
            const o = document.createElement('option');
            o.value = String(i);
            o.textContent = `GPIO${c.pins[i]}`;
            this.trigSel.appendChild(o);
        }
        const tc = c.trigCh >= 0 && c.trigCh < c.pins.length ? c.trigCh : -1;
        this.trigSel.value = String(tc);
        this.edgeSel.value = c.trigEdge;
        this.winInput.value = String(c.durationMs);
        this.resSel.value = c.resolution;
        this.autoCb.checked = this.autoUI;
    }

    /* Channel chips from the panel's candidate-aware pin info — pins used by
     * other non-bus devices are disabled, shared bus pads stay pickable. */
    _renderChans() {
        if (!this.win) return;
        const el = this.chansEl;
        el.innerHTML = '';
        const info = this.host?.pinInfo?.();
        const valid = info ? info.valid : this.cfg.pins.slice();
        const used = info ? info.used : new Set();
        for (const p of valid) {
            const on = this.cfg.pins.includes(p);
            const taken = !on && used.has(p);
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'la-chan' + (on ? ' on' : '');
            chip.textContent = String(p);
            chip.title = taken
                ? `GPIO${p} — used by another device`
                : `GPIO${p} — click to ${on ? 'remove' : 'add'}`;
            if (taken) chip.disabled = true;
            else chip.addEventListener('click', () => {
                const pins = this.cfg.pins.filter((x) => x !== p);
                if (!on) {
                    if (pins.length >= MAX_CHANNELS) return;
                    pins.push(p);
                    pins.sort((a, b) => a - b);
                }
                this.host.updateConfig({ pins });
            });
            el.appendChild(chip);
        }
        this.hint.style.display = this.cfg.pins.length ? 'none' : '';
    }

    _fitCanvas() {
        if (!this.win || !this.plotWrap) return;
        const r = this.plotWrap.getBoundingClientRect();
        this.plotW = Math.max(10, r.width);
        this.plotG = resizeCanvas(this.plotCv, this.plotW, Math.max(10, r.height));
        this._renderWin();
    }

    _renderWin() {
        if (!this.win) return;
        const st = this.state;
        // a fresh capture re-fits the view and drops the cursors (their
        // absolute times belong to the previous capture)
        if (st && st.capId !== this.capSeen) {
            this.capSeen = st.capId;
            this.view = null;
            this.cursors = { a: null, b: null };
        }
        if (this.plotG) {
            const r = this.plotCv.getBoundingClientRect();
            drawWaveform(this.plotG, r.width, r.height, st, {
                gutter: 56, axis: true,
                view: this._view(),
                hover: this.hover,
                measure: this.measure,
                cursors: this.cursors,
                selectedLane: this.selCh,
            });
        }
        this._renderMeasure();
        // controls reflect the live status
        const s = st?.status ?? 'idle';
        this.armBtn.disabled = s === 'run' || s === 'armed';
        this.stopBtn.disabled = s === 'idle' || s === 'done';
        this.clearBtn.disabled = s === 'run';
        this.mClear.style.display = this.cursors.a != null || this.cursors.b != null ? '' : 'none';
        const dot = this.win.el.querySelector('.float-win-title');
        dot.dataset.status = s;

        let text;
        if (s === 'idle') text = 'idle — Arm to capture';
        else if (s === 'armed') text = `armed — waiting for trigger: GPIO${this.cfg.pins[this.cfg.trigCh] ?? '?'} ${this.cfg.trigEdge}`;
        else if (s === 'run') text = `capturing… ${fmtUs(st.capturedUs)} / ${fmtUs(st.windowUs)} · ${st.totalEdges} edges`;
        else text = `done · ${fmtUs(st.capturedUs)} · ${st.totalEdges} edges` + (st.overflow ? ' · buffer full (stopped early)' : '');
        this.foot.textContent = text
            + (st?.auto && s !== 'idle' && s !== 'done' ? ' · auto' : '')
            + ` · view ${fmtUs(this._view().spanUs)}`;
    }

    /* ---- Saleae-style plot interaction -------------------------------------- */

    /** Visible window; lazily fit to the current capture. */
    _view() {
        if (!this.view) {
            this.view = clampView({ t0: 0, spanUs: fitSpanUs(this.state) }, this.state);
        }
        return this.view;
    }

    _fit() {
        this.view = null;
        this._renderWin();
    }

    _zoomCenter(factor) {
        const v = this._view();
        this.view = zoomAt(v, v.t0 + v.spanUs / 2, factor, this.state);
        this._renderWin();
    }

    _xToUs(x) {
        return viewXform(this.plotW, 56, this._view()).xToUs(x);
    }

    _usToX(us) {
        return viewXform(this.plotW, 56, this._view()).usToX(us);
    }

    /** Lane index at a plot y (mirrors the painter's lane geometry). */
    _laneAt(y) {
        const st = this.state;
        const n = Math.max(1, st?.channels?.length ?? 1);
        const h = this.plotCv.getBoundingClientRect().height;
        const axisH = Math.max(14, Math.round(h * 0.08));
        const laneH = Math.max(8, h - axisH) / n;
        return Math.min(n - 1, Math.max(0, Math.floor(y / laneH)));
    }

    /**
     * All plot interaction in one place: wheel zoom (anchored at the
     * cursor), left/middle-drag pan, drag the A/B cursor lines, click to
     * drop a cursor, click a lane label to select the edge-jump channel,
     * double-click to fit, keyboard (←/→ edges, +/- zoom, F fit).
     */
    _wirePlot(wrap) {
        const GUTTER = 56;
        wrap.addEventListener('wheel', (e) => {
            e.preventDefault();
            const r = this.plotCv.getBoundingClientRect();
            const anchor = this._xToUs(e.clientX - r.left);
            const f = e.deltaY > 0 ? 1.35 : 1 / 1.35;
            this.view = zoomAt(this._view(), anchor, f, this.state);
            this._renderWin();
        }, { passive: false });

        wrap.addEventListener('pointerdown', (e) => {
            if (e.button === 1) e.preventDefault(); // middle-drag pans, no autoscroll
            wrap.focus({ preventScroll: true });
            const r = this.plotCv.getBoundingClientRect();
            const x = e.clientX - r.left;
            const near = (t) => t != null && Math.abs(this._usToX(t) - x) <= 5;
            let mode = 'pan';
            if (x > GUTTER && near(this.cursors.a)) mode = 'curA';
            else if (x > GUTTER && near(this.cursors.b)) mode = 'curB';
            this.drag = { mode, x0: x, y0: e.clientY - r.top, t0v: this._view().t0, moved: false, button: e.button };
            const move = (ev) => {
                const d = this.drag;
                if (!d) return;
                const mx = ev.clientX - r.left;
                if (Math.abs(mx - d.x0) > 3) d.moved = true;
                if (d.mode === 'pan') {
                    const v = this._view();
                    const dtUs = -((mx - d.x0) / Math.max(1, this.plotW - GUTTER)) * v.spanUs;
                    this.view = clampView({ t0: d.t0v + dtUs, spanUs: v.spanUs }, this.state);
                } else {
                    this.cursors[d.mode === 'curA' ? 'a' : 'b'] = this._xToUs(mx);
                }
                this._renderWin();
            };
            const up = (ev) => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                const d = this.drag;
                this.drag = null;
                if (!d || d.moved || d.button !== 0) return;
                const ux = ev.clientX - r.left;
                const uy = ev.clientY - r.top;
                if (ux <= GUTTER) {
                    // label gutter: select the channel edge jumps act on
                    this.selCh = this._laneAt(uy);
                } else if (d.mode === 'pan') {
                    this._scheduleCursor(this._xToUs(ux));
                }
                this._renderWin();
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
        });

        wrap.addEventListener('pointermove', (e) => {
            if (this.drag) return; // a drag owns the pointer
            const r = this.plotCv.getBoundingClientRect();
            const x = e.clientX - r.left, y = e.clientY - r.top;
            this.hover = { x };
            this._updateMeasure(x, y);
            this._renderWin();
        });
        wrap.addEventListener('pointerleave', () => {
            this.hover = null;
            this.measure = null;
            this.measureInfo = null;
            this._renderWin();
        });

        wrap.addEventListener('dblclick', () => {
            if (this.cursorTimer != null) { clearTimeout(this.cursorTimer); this.cursorTimer = null; }
            this._fit();
        });

        wrap.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); this._jumpEdge(-1); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); this._jumpEdge(1); }
            else if (e.key === 'f' || e.key === 'F') this._fit();
            else if (e.key === '+' || e.key === '=') this._zoomCenter(1 / 1.35);
            else if (e.key === '-') this._zoomCenter(1.35);
        });
    }

    /** Hover measurement for the lane under the cursor (pulse + PWM cycle). */
    _updateMeasure(x, y) {
        const st = this.state;
        if (!st || !st.channels.length || x <= 56) {
            this.measure = null;
            this.measureInfo = null;
            return;
        }
        const ch = this._laneAt(y);
        const t = this._xToUs(x);
        const flat = st.edges[ch] ?? [];
        const pulse = pulseAround(flat, st.initial?.[ch], t);
        const pwm = pwmOf(flat, t);
        this.measureInfo = { ch, pulse, pwm };
        const from = pulse.tStart, to = pulse.tEnd;
        const v = this._view();
        this.measure = from != null || to != null
            ? { lane: ch, from: from ?? 0, to: to ?? Math.max(t, v.t0 + v.spanUs) }
            : null;
    }

    /** Click → cursor A, then B, then the nearest (debounced vs dblclick). */
    _scheduleCursor(t) {
        if (this.cursorTimer != null) clearTimeout(this.cursorTimer);
        this.cursorTimer = setTimeout(() => {
            this.cursorTimer = null;
            if (this.cursors.a == null) this.cursors.a = t;
            else if (this.cursors.b == null) this.cursors.b = t;
            else if (Math.abs(t - this.cursors.a) <= Math.abs(t - this.cursors.b)) this.cursors.a = t;
            else this.cursors.b = t;
            this._renderWin();
        }, 220);
    }

    /** Pan to the previous/next edge of the selected channel (zoom kept). */
    _jumpEdge(dir) {
        const st = this.state;
        if (!st || !st.channels.length) return;
        let ch = this.selCh;
        if (ch == null || ch < 0 || ch >= st.channels.length) {
            ch = this.cfg.trigCh >= 0 && this.cfg.trigCh < st.channels.length ? this.cfg.trigCh : 0;
        }
        const flat = st.edges[ch] ?? [];
        const times = [];
        for (let k = 0; k + 1 < flat.length; k += 2) times.push(flat[k]);
        const v = this._view();
        const centre = v.t0 + v.spanUs / 2;
        const t = dir > 0
            ? times.find((x) => x > centre)
            : times.slice().reverse().find((x) => x < centre);
        if (t == null) return;
        this.selCh = ch;
        this.view = clampView({ t0: t - v.spanUs / 2, spanUs: v.spanUs }, st);
        this._renderWin();
    }

    /** The measurement bar: hover readout + A/B cursor delta. */
    _renderMeasure() {
        if (!this.win) return;
        const st = this.state;
        const info = this.measureInfo;
        // hover half
        const parts = [];
        if (info && st) {
            const pin = st.channels[info.ch];
            const lvl = document.createElement('b');
            lvl.textContent = `GPIO${pin}`;
            lvl.style.color = LA_COLORS[info.ch % LA_COLORS.length];
            this.mHover.replaceChildren(lvl);
            const p = info.pulse;
            this.mHover.appendChild(document.createTextNode(
                ` ${levelChar(p.level)} · pulse ${p.widthUs != null ? fmtUs(p.widthUs) : '—'}`));
            if (info.pwm) {
                parts.push(`period ${fmtUs(info.pwm.periodUs)} · ${fmtHz(info.pwm.freqHz)}`
                    + ` · duty ${(info.pwm.duty * 100).toFixed(1)}%`);
            }
            for (const t of parts) this.mHover.appendChild(document.createTextNode(' · ' + t));
        } else {
            this.mHover.textContent = st && st.channels.length
                ? 'hover a channel to measure · wheel zoom · drag pan · click drops A/B cursors · double-click fits'
                : '—';
        }
        // cursor half
        const { a, b } = this.cursors;
        if (a != null || b != null) {
            const bits = [`A ${a != null ? fmtUs(a) : '—'}`, `B ${b != null ? fmtUs(b) : '—'}`];
            if (a != null && b != null) {
                const d = Math.abs(b - a);
                bits.push(`Δ ${fmtUs(d)} · ${fmtHz(1e6 / d)}`);
            }
            this.mCurs.textContent = bits.join(' · ');
        } else {
            this.mCurs.textContent = '';
        }
    }
}
