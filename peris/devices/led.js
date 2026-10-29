/*
 * LED — single colour LED on a GPIO output.
 * Reads the pad via the sigbus (out + output-enable), so it lights exactly
 * when the firmware drives the pin (and shows "floating" when it does not).
 */
export class Device {
    static typeId = 'led';
    static version = '1.0.0';
    static title = 'LED';
    static category = 'basic';
    static description = 'Single-colour LED wired to a GPIO output.';
    static defaultConfig = { name: 'LED', pin: 8, color: '#ff4d4d', invert: false };
    static pins(cfg) { return [cfg.pin]; }
    static configSchema = [
        { key: 'pin', label: 'GPIO pin', type: 'pin' },
        { key: 'color', label: 'Colour', type: 'color' },
        { key: 'invert', label: 'Active low', type: 'checkbox' },
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.on = false;
        this.driven = false;
        ctx.subscribe([cfg.pin]);
    }

    onPinState(pin, s) {
        const on = s.oe && (s.out !== !!this.cfg.invert);
        if (on !== this.on || s.oe !== this.driven) {
            this.on = on;
            this.driven = s.oe;
            this.ctx.markDirty();
        }
    }

    getState() {
        return { on: this.on, driven: this.driven };
    }

    destroy() {
        this.ctx.unsubscribe();
    }
}

export class View {
    constructor(el, sendCmd) {
        this.el = el;
        el.className = 'dev-body led-body';
        const bulb = document.createElement('div');
        bulb.className = 'led-bulb';
        this.halo = document.createElement('div');
        this.halo.className = 'led-halo';
        bulb.appendChild(this.halo);
        const cap = document.createElement('div');
        cap.className = 'led-cap';
        this.cap = cap;
        const wrap = document.createElement('div');
        wrap.className = 'led-wrap';
        wrap.appendChild(bulb);
        el.appendChild(wrap);
        el.appendChild(cap);
    }
    render(state) {
        const bulb = this.halo.parentElement;
        bulb.classList.toggle('lit', !!state.on);
        bulb.classList.toggle('floating', state.driven === false);
        this.cap.textContent = state.driven === false ? 'not driven by firmware' : (state.on ? 'ON' : 'OFF');
    }
    setConfig(cfg) {
        this.halo.parentElement.style.setProperty('--led-color', cfg.color || '#ff4d4d');
    }
}
