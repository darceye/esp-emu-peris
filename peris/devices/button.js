/*
 * Push button (momentary) — drives a GPIO *input* level while held.
 * Default wiring is active-low (pressed = 0 V) with a pull-up, the usual
 * ESP32 board style. Verified in M0: gpio_set_input() changes reach the
 * firmware and raise its GPIO interrupts.
 */
export class Device {
    static typeId = 'button';
    static title = 'Push button';
    static category = 'basic';
    static description = 'Momentary button driving a GPIO input (active-low by default).';
    static defaultConfig = { name: 'Button', pin: 9, activeLow: true };
    static pins(cfg) { return [cfg.pin]; }
    static configSchema = [
        { key: 'pin', label: 'GPIO pin', type: 'pin' },
        { key: 'activeLow', label: 'Active low (pull-up wiring)', type: 'checkbox' },
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.pressed = false;
        this._drive();
    }

    /* Active-low wiring (default): idle = pull-up HIGH, pressed = LOW. */
    idleLevel() { return !!this.cfg.activeLow; }
    pressedLevel() { return !this.cfg.activeLow; }

    _drive() {
        this.ctx.setPinInput(this.cfg.pin, this.pressed ? this.pressedLevel() : this.idleLevel());
    }

    onEmuReady() { this._drive(); } // re-drive after a new emulator instance

    onCommand(cmd) {
        if (cmd === 'press' && !this.pressed) {
            this.pressed = true;
        } else if (cmd === 'release' && this.pressed) {
            this.pressed = false;
        } else if (cmd !== 'press' && cmd !== 'release') {
            return;
        }
        this._drive();
        this.ctx.markDirty();
    }

    getState() { return { pressed: this.pressed }; }

    destroy() {
        this.ctx.setPinInput(this.cfg.pin, this.idleLevel());
        this.ctx.unsubscribe();
    }
}

export class View {
    constructor(el, sendCmd) {
        this.send = sendCmd;
        el.className = 'dev-body button-body';
        const btn = document.createElement('button');
        btn.className = 'hw-button';
        btn.textContent = 'PRESS';
        const down = (e) => { e.preventDefault(); sendCmd('press'); btn.classList.add('down'); };
        const up = (e) => { if (e) e.preventDefault(); sendCmd('release'); btn.classList.remove('down'); };
        btn.addEventListener('pointerdown', down);
        btn.addEventListener('pointerup', up);
        btn.addEventListener('pointerleave', up);
        btn.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') down(e); });
        btn.addEventListener('keyup', up);
        this.btn = btn;
        el.appendChild(btn);
    }
    render(state) {
        this.btn.classList.toggle('down', !!state.pressed);
        this.btn.textContent = state.pressed ? 'PRESSED' : 'PRESS';
    }
}
