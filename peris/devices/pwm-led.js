/*
 * PWM LED — a single LED dimmed by one LEDC channel.
 *
 * The pad-level PWM waveform never reaches gpio_state() (it goes through
 * the GPIO matrix — M0 Q2a FAIL), so the duty is read from the LEDC DUTY_R
 * register every batch (M0 Q2b PASS) and the channel→pin wiring is
 * discovered from the GPIO_FUNCn_OUT_SEL_CFG registers; the channel can
 * also be picked manually. The View interpolates brightness on a canvas so
 * firmware breathing ramps render smoothly despite ~30fps state pushes.
 */
import {
    parseChannel, channelOptions, discoverLedcPins, readLedcChannel,
    LEDC_RESCAN_BATCHES, quantiseDuty,
    LevelAnimator, makeBulbCanvas, drawBulb, withAlpha,
} from './ledc-lib.js';

export class Device {
    static typeId = 'pwm-led';
    static version = '1.0.0';
    static title = 'PWM LED';
    static category = 'pwm';
    static description = 'LED dimmed by an LEDC PWM channel (duty read from MMIO; wiring auto-discovered).';
    static defaultConfig = { name: 'PWM LED', channel: 'auto', color: '#ffb340' };
    /* The LEDC→pad routing is configured by the firmware's GPIO-matrix
     * setup, so the plugin claims no GPIO of its own (no conflict set). */
    static pins() { return []; }
    static configSchema = [
        // option count = C3 LEDC channels (per-chip tables in src/core/mmio)
        { key: 'channel', label: 'LEDC channel', type: 'select', options: channelOptions(6) },
        { key: 'color', label: 'Colour', type: 'color' },
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.mode = null;        // 'auto' | channel number (resolved on first batch)
        this.chan = null;        // bound channel (null = not wired yet)
        this.pin = null;         // discovered pad of this channel
        this.duty = 0;           // quantised 0..1
        this.wired = false;      // channel enabled by the firmware
        this.tick = 0;
    }

    onEmuReady() {
        // fresh emulator instance: routing, duty and enable state are
        // unknown again (all registers read 0 until the firmware runs)
        if (this.mode === 'auto') this.chan = null;
        this.pin = null;
        this.duty = 0;
        this.wired = false;
        this.ctx.markDirty();
    }

    onBatch() {
        if (this.mode === null) {
            this.mode = parseChannel(this.cfg.channel, this.ctx.mmio?.ledc.channelCount ?? 6);
            if (this.mode !== 'auto') this.chan = this.mode;
        }
        this.tick++;
        // Discover (and keep following) the firmware's wiring: until bound,
        // then periodically so a rewiring is picked up.
        if (this.chan == null || this.pin == null || this.tick % LEDC_RESCAN_BATCHES === 0) {
            const pins = discoverLedcPins(this.ctx);
            if (this.mode === 'auto') {
                // first LEDC-routed channel in numeric order
                const ch = pins.size ? Math.min(...pins.keys()) : null;
                if (ch !== this.chan) this.chan = ch;
            }
            this.pin = this.chan == null ? null : pins.get(this.chan) ?? null;
        }
        const st = this.chan == null
            ? { enabled: false, fraction: 0 }
            : readLedcChannel(this.ctx, this.chan);
        const duty = quantiseDuty(st.fraction);
        if (duty !== this.duty || st.enabled !== this.wired) {
            this.duty = duty;
            this.wired = st.enabled;
            this.ctx.markDirty();
        }
    }

    getState() {
        return { duty: this.duty, channel: this.chan, pin: this.pin, wired: this.wired };
    }
}

export class View {
    constructor(el, sendCmd, host) {
        this.el = el;
        this.send = sendCmd;
        this.host = host; // host.updateConfig({color}) powers the row icon picker
        this.colour = '#ffb340';
        this.levels = [0];
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
        // one animation clock drives the canvas bulb AND the row icon
        this.animator = new LevelAnimator((levels) => this._apply(levels));
        this._apply(this.levels);
    }

    /* Compact row icon: mini bulb whose glow layer is opacity-driven by the
     * duty; clicking opens the colour picker (writes into the config). */
    rowIcon(el) {
        el.title = 'PWM LED — click to change colour';
        const dot = document.createElement('span');
        dot.className = 'led-dot';
        const glow = document.createElement('i');
        glow.className = 'dot-glow';
        dot.appendChild(glow);
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.className = 'led-dot-picker';
        picker.addEventListener('change', () => {
            if (this.host) this.host.updateConfig({ color: picker.value });
            else this.setColour(picker.value);
        });
        dot.appendChild(picker);
        dot.addEventListener('click', () => { picker.value = this.colour; picker.click(); });
        el.appendChild(dot);
        this.dot = dot;
        this.glow = glow;
        this.setColour(this.colour); // keep icon and bulb in lock-step
    }

    /* The ONE colour setter — feeds the canvas paint colour and the row
     * dot's --led-color. Never style either of them anywhere else. */
    setColour(color) {
        this.colour = color || '#ffb340';
        if (this.dot) this.dot.style.setProperty('--led-color', this.colour);
        this._apply(this.levels);
    }

    /* The ONE brightness application — canvas bulb + outer glow + row icon
     * glow, all from the same interpolated level. */
    _apply(levels) {
        this.levels = levels;
        const peak = drawBulb(this.g, this.size, [this.colour], levels);
        this.cv.style.filter = peak > 0.01
            ? `drop-shadow(0 0 ${4 + 14 * peak}px ${withAlpha(this.colour, 0.55)})`
            : 'none';
        if (this.glow) this.glow.style.opacity = String(levels[0]);
    }

    render(state) {
        this.animator.setTarget([state.wired ? state.duty : 0]);
        this.cap.textContent = state.channel == null
            ? 'waiting for firmware LEDC wiring…'
            : `LEDC ch${state.channel} → GPIO${state.pin ?? '?'} · duty ${Math.round((state.duty || 0) * 100)}%`
              + (state.wired ? '' : ' (channel idle)');
    }

    setConfig(cfg) {
        this.setColour(cfg.color);
    }
}
