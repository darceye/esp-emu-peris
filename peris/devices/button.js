/*
 * Push button (momentary) — drives a GPIO *input* level while held.
 * Default wiring is active-low (pressed = 0 V) with a pull-up, the usual
 * ESP32 board style. Verified in M0: gpio_set_input() changes reach the
 * firmware and raise its GPIO interrupts.
 */
export class Device {
    static typeId = 'button';
    static version = '1.1.0';
    static title = 'Push button';
    static category = 'basic';
    static description = 'Momentary button driving a GPIO input (active-low by default).';
    static defaultConfig = { name: 'Button', pin: 9, activeLow: true };
    static pins(cfg) { return [cfg.pin]; }
    static configSchema = [
        { key: 'pin', label: 'GPIO pin', type: 'pin' },
        // chip:'pull' → the row shows V (pull-up) when activeLow, G otherwise
        { key: 'activeLow', label: 'Active low (pull-up wiring)', type: 'checkbox', chip: 'pull', pullWhenChecked: 'high' },
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

    /* Compact row icon: press-and-hold, same press/release commands. */
    rowIcon(el) {
        el.title = 'Push — press and hold';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'icon-press';
        b.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12"><circle cx="8" cy="8" r="5" fill="currentColor"/></svg>';
        const down = (e) => { e.preventDefault(); this.send('press'); b.classList.add('down'); };
        const up = (e) => { if (e) e.preventDefault(); this.send('release'); b.classList.remove('down'); };
        b.addEventListener('pointerdown', down);
        b.addEventListener('pointerup', up);
        b.addEventListener('pointerleave', up);
        b.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') down(e); });
        b.addEventListener('keyup', up);
        el.appendChild(b);
        this.iconBtn = b;
    }

    render(state) {
        this.btn.classList.toggle('down', !!state.pressed);
        this.btn.textContent = state.pressed ? 'PRESSED' : 'PRESS';
        if (this.iconBtn) this.iconBtn.classList.toggle('down', !!state.pressed);
    }
}
