/*
 * Toggle switch (slide) — drives a GPIO input level, keeping the level
 * while the emulator runs. Click to flip.
 */
export class Device {
    static typeId = 'toggle-switch';
    static title = 'Toggle switch';
    static category = 'basic';
    static description = 'Latching switch driving a GPIO input level.';
    static defaultConfig = { name: 'Switch', pin: 11, activeLow: false, initial: false };
    static pins(cfg) { return [cfg.pin]; }
    static configSchema = [
        { key: 'pin', label: 'GPIO pin', type: 'pin' },
        { key: 'activeLow', label: 'Active low', type: 'checkbox' },
        { key: 'initial', label: 'Initial ON state', type: 'checkbox' },
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.on = !!cfg.initial;
        this._drive();
    }

    level() { return this.on !== !!this.cfg.activeLow; }

    _drive() {
        this.ctx.setPinInput(this.cfg.pin, this.level());
    }

    onEmuReady() { this._drive(); }

    onCommand(cmd, params) {
        if (cmd === 'set') this.on = !!params?.on;
        else if (cmd === 'toggle') this.on = !this.on;
        else return;
        this._drive();
        this.ctx.markDirty();
    }

    getState() { return { on: this.on }; }

    destroy() {
        this.ctx.setPinInput(this.cfg.pin, !this.cfg.activeLow); // idle level
        this.ctx.unsubscribe();
    }
}

export class View {
    constructor(el, sendCmd) {
        this.send = sendCmd;
        el.className = 'dev-body switch-body';
        const wrap = document.createElement('label');
        wrap.className = 'hw-switch';
        wrap.innerHTML = `<input type="checkbox"><span class="sw-track"><span class="sw-knob"></span></span><span class="sw-text">OFF</span>`;
        const input = wrap.querySelector('input');
        input.addEventListener('change', () => sendCmd('set', { on: input.checked }));
        this.input = input;
        this.text = wrap.querySelector('.sw-text');
        el.appendChild(wrap);
    }
    render(state) {
        this.input.checked = !!state.on;
        this.text.textContent = state.on ? 'ON' : 'OFF';
    }
}
