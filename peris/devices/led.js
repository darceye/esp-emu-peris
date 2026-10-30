/*
 * LED — single colour LED on a GPIO output.
 * Reads the pad via the sigbus (out + output-enable), so it lights exactly
 * when the firmware drives the pin (and shows "floating" when it does not).
 */
export class Device {
    static typeId = 'led';
    static version = '1.1.1';
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
    constructor(el, sendCmd, host) {
        this.el = el;
        this.send = sendCmd;
        this.host = host; // host.updateConfig({color}) powers the row icon picker
        this.colour = '#ff4d4d';
        this.dot = null;
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

    /* Compact row icon: a mini bulb that lights with the state; clicking it
     * opens the colour picker and writes the choice back into the config. */
    rowIcon(el) {
        el.title = 'LED — click to change colour';
        const dot = document.createElement('span');
        dot.className = 'led-dot';
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
        this.setColour(this.colour); // keep icon and bulb in lock-step
    }

    /* The ONE colour setter — applies to every LED visual (details bulb +
     * row dot). Never style one of them anywhere else. */
    setColour(color) {
        this.colour = color || '#ff4d4d';
        const bulb = this.halo ? this.halo.parentElement : null;
        for (const t of [bulb, this.dot]) {
            if (t) t.style.setProperty('--led-color', this.colour);
        }
    }

    render(state) {
        const bulb = this.halo.parentElement;
        bulb.classList.toggle('lit', !!state.on);
        bulb.classList.toggle('floating', state.driven === false);
        this.cap.textContent = state.driven === false ? 'not driven by firmware' : (state.on ? 'ON' : 'OFF');
        if (this.dot) this.dot.classList.toggle('lit', !!state.on);
    }

    setConfig(cfg) {
        this.setColour(cfg.color);
    }
}
