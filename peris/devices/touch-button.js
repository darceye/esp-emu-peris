/*
 * Touch button — a capacitive-touch styled input pad. Electrically it is
 * the same as the push button: it drives a GPIO input level.
 *
 * NOTE: the esp-emulator does not emulate the touch-pad peripheral, so
 * firmware written against the touch driver will not see this. Use GPIO
 * input handling in firmware (see tests/firmware for an example).
 */
import { Device as ButtonDevice } from './button.js';

export class Device extends ButtonDevice {
    static typeId = 'touch-button';
    static title = 'Touch button';
    static category = 'basic';
    static description = 'Touch-style pad driving a GPIO input (touch peripheral itself is not emulated — firmware must read it as GPIO).';
    static defaultConfig = { name: 'Touch', pin: 10, activeLow: true };
    static pins(cfg) { return [cfg.pin]; }
    static configSchema = ButtonDevice.configSchema;
    // idleLevel/pressedLevel inherited from button.js (verified levels).
}

export class View {
    constructor(el, sendCmd) {
        this.send = sendCmd;
        el.className = 'dev-body touch-body';
        const pad = document.createElement('div');
        pad.className = 'touch-pad';
        pad.setAttribute('role', 'button');
        pad.tabIndex = 0;
        pad.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
            <path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11m0-2.5a1.5 1.5 0 0 1 3 0V11m0-1a1.5 1.5 0 0 1 3 0v4c0 3.9-2.6 6.5-6 6.5s-5.2-1.4-6.6-3.8l-1.8-3.1a1.6 1.6 0 0 1 2.7-1.7L8 13V6.5"/>
        </svg><span class="touch-label">TOUCH</span>`;
        const down = (e) => { e.preventDefault(); sendCmd('press'); pad.classList.add('active'); };
        const up = (e) => { if (e) e.preventDefault(); sendCmd('release'); pad.classList.remove('active'); };
        pad.addEventListener('pointerdown', down);
        pad.addEventListener('pointerup', up);
        pad.addEventListener('pointerleave', up);
        pad.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') down(e); });
        pad.addEventListener('keyup', up);
        this.pad = pad;
        el.appendChild(pad);
    }
    render(state) {
        this.pad.classList.toggle('active', !!state.pressed);
    }
}
