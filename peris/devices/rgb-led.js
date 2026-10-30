/*
 * RGB LED — three diodes, each dimmed by its own LEDC channel.
 *
 * Same MMIO approach as pwm-led (pad waveforms are invisible, M0 Q2a;
 * DUTY_R reads are exact, Q2b): each colour role (R/G/B) follows one LEDC
 * channel — auto-discovered from the GPIO-matrix routing (the lowest
 * routed channels map to R, G, B in order) or picked manually. The View
 * mixes the three channels additively on a canvas with interpolated
 * brightness, so firmware colour fades render smoothly.
 */
import {
    parseChannel, channelOptions, discoverLedcPins, readLedcChannel,
    LEDC_RESCAN_BATCHES, quantiseDuty,
    LevelAnimator, makeBulbCanvas, drawBulb, withAlpha, mixHex,
} from './ledc-lib.js';

/** Fixed diode colours of the three roles. */
const ROLE_COLOURS = { r: '#ff4d4d', g: '#4dff6a', b: '#4d6aff' };
const ROLES = ['r', 'g', 'b'];

export class Device {
    static typeId = 'rgb-led';
    static version = '1.0.0';
    static title = 'RGB LED (PWM)';
    static category = 'pwm';
    static description = 'Three-colour LED on three LEDC channels (duty read from MMIO; wiring auto-discovered).';
    static defaultConfig = { name: 'RGB LED', channelR: 'auto', channelG: 'auto', channelB: 'auto' };
    /* See pwm-led: routing is firmware-side GPIO-matrix config, no claims. */
    static pins() { return []; }
    static configSchema = [
        { key: 'channelR', label: 'Red channel', type: 'select', options: channelOptions(6) },
        { key: 'channelG', label: 'Green channel', type: 'select', options: channelOptions(6) },
        { key: 'channelB', label: 'Blue channel', type: 'select', options: channelOptions(6) },
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.mode = { r: null, g: null, b: null };  // 'auto' | channel number
        this.chan = { r: null, g: null, b: null };
        this.pin = { r: null, g: null, b: null };
        this.levels = { r: 0, g: 0, b: 0 };        // quantised 0..1
        this.wired = false;                        // any channel enabled
        this.tick = 0;
    }

    onEmuReady() {
        // fresh emulator instance: routing, duties and enable state are
        // unknown again (all registers read 0 until the firmware runs)
        for (const k of ROLES) {
            if (this.mode[k] === 'auto') this.chan[k] = null;
            this.pin[k] = null;
            this.levels[k] = 0;
        }
        this.wired = false;
        this.ctx.markDirty();
    }

    onBatch() {
        if (this.mode.r === null) {
            const count = this.ctx.mmio?.ledc.channelCount ?? 6;
            for (const k of ROLES) {
                this.mode[k] = parseChannel(this.cfg[`channel${k.toUpperCase()}`], count);
                if (this.mode[k] !== 'auto') this.chan[k] = this.mode[k];
            }
        }
        this.tick++;
        const missing = ROLES.some((k) => this.mode[k] === 'auto' && this.chan[k] == null);
        if (missing || this.tick % LEDC_RESCAN_BATCHES === 0) {
            const pins = discoverLedcPins(this.ctx);
            // auto roles take the lowest routed channels not claimed by a
            // manual role (typical firmware: ch0/ch1/ch2 → R/G/B)
            const manual = new Set(ROLES.filter((k) => this.mode[k] !== 'auto').map((k) => this.mode[k]));
            const free = [...pins.keys()].filter((c) => !manual.has(c)).sort((a, b) => a - b);
            let idx = 0;
            for (const k of ROLES) {
                if (this.mode[k] === 'auto') {
                    this.chan[k] = free[idx] ?? null;
                    idx++;
                }
                this.pin[k] = this.chan[k] == null ? null : pins.get(this.chan[k]) ?? null;
            }
        }
        let wired = false;
        const levels = {};
        for (const k of ROLES) {
            const st = this.chan[k] == null
                ? { enabled: false, fraction: 0 }
                : readLedcChannel(this.ctx, this.chan[k]);
            wired = wired || st.enabled;
            levels[k] = quantiseDuty(st.fraction);
        }
        if (wired !== this.wired || ROLES.some((k) => levels[k] !== this.levels[k])) {
            this.wired = wired;
            this.levels = levels;
            this.ctx.markDirty();
        }
    }

    getState() {
        return {
            r: this.levels.r, g: this.levels.g, b: this.levels.b,
            channels: { ...this.chan }, pins: { ...this.pin }, wired: this.wired,
        };
    }
}

export class View {
    constructor(el, sendCmd) {
        this.el = el;
        this.send = sendCmd;
        this.levels = [0, 0, 0];
        el.className = 'dev-body pwm-body';
        const wrap = document.createElement('div');
        wrap.className = 'led-wrap';
        const { cv, g, size } = makeBulbCanvas(96);
        this.cv = cv; this.g = g; this.size = size;
        wrap.appendChild(cv);
        const cap = document.createElement('div');
        cap.className = 'led-cap';
        this.cap = cap;
        el.appendChild(wrap);
        el.appendChild(cap);
        this.animator = new LevelAnimator((levels) => this._apply(levels));
        this._apply(this.levels);
    }

    /* Compact row icon: mini bulb; the glow layer carries the additive mix
     * colour and its opacity the overall brightness. */
    rowIcon(el) {
        el.title = 'RGB LED (PWM)';
        const dot = document.createElement('span');
        dot.className = 'led-dot';
        const glow = document.createElement('i');
        glow.className = 'dot-glow';
        dot.appendChild(glow);
        el.appendChild(dot);
        this.dot = dot;
        this.glow = glow;
        this._apply(this.levels); // keep icon and bulb in lock-step
    }

    /* The ONE application of the three levels — canvas bulb + outer glow +
     * row icon, all from the same interpolated values. */
    _apply(levels) {
        this.levels = levels;
        const colours = ROLES.map((k) => ROLE_COLOURS[k]);
        const peak = drawBulb(this.g, this.size, colours, levels);
        const mix = mixHex(colours, levels);
        this.cv.style.filter = peak > 0.01
            ? `drop-shadow(0 0 ${4 + 14 * peak}px ${withAlpha(mix, 0.55)})`
            : 'none';
        if (this.dot) this.dot.style.setProperty('--led-color', mix);
        if (this.glow) this.glow.style.opacity = String(peak);
    }

    render(state) {
        this.animator.setTarget([state.r || 0, state.g || 0, state.b || 0]);
        const c = state.channels || {};
        const p = state.pins || {};
        const wired = (k) => c[k] == null ? '–' : `ch${c[k]}→GPIO${p[k] ?? '?'}`;
        this.cap.textContent = `R ${wired('r')} · G ${wired('g')} · B ${wired('b')}`
            + (state.wired ? '' : ' (waiting for firmware LEDC wiring…)');
    }
}
