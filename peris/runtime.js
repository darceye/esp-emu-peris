/*
 * Peripherals runtime (worker side): owns device instances, wires them to
 * the emulator (sigbus + MMIO reads + input drive), and pushes throttled
 * state updates to the page.
 */
import { Sigbus } from './sigbus.js';
import { loadRegistry } from './registry.js';
import { PERIS_READY, PERIS_STATE, PERIS_LOG } from './protocol.js';
import { gpioCount, GPIO_ABSENT } from './chips.js';

const STATE_FLUSH_MS = 33; // ~30 fps per device

export class PerisRuntime {
    constructor() {
        this.registry = null;
        this.sigbus = new Sigbus(null);
        this.emu = null;
        this.chip = 'esp32c3';
        this.devices = new Map();   // id -> { instance, meta, cfg }
        this.dirty = new Set();
        this.lastFlush = 0;
        this.post = (msg) => postMessage(msg); // overridable for tests
    }

    async init() {
        this.registry = await loadRegistry(import.meta.url);
    }

    attachEmu(emu, chip) {
        this.emu = emu;
        this.chip = chip || this.chip;
        this.sigbus.attach(emu);
        for (const { instance } of this.devices.values()) instance.onEmuReady?.();
    }

    /** Validate + instantiate a full config. Always answers PERIS_READY. */
    async applyConfig(config) {
        // A config can arrive before initWasm finished loading the device
        // registry (page reload with a saved config) — wait for it once.
        if (!this.registry) {
            try { await this.init(); } catch (e) { /* reported below */ }
        }
        const errors = [];
        const usedPins = new Map(); // pin -> deviceId (conflict detection)
        for (const { instance } of this.devices.values()) {
            try { instance.destroy?.(); } catch (e) { /* ignore */ }
        }
        this.devices.clear();
        this.sigbus = new Sigbus(this.emu);

        const devices = Array.isArray(config?.devices) ? config.devices : [];
        for (const cfg of devices) {
            const id = cfg.id;
            if (!id || !cfg.type) { errors.push('device entry missing id/type'); continue; }
            if (!this.registry || !this.registry.has(cfg.type)) {
                errors.push(`${id}: unknown type "${cfg.type}"`);
                continue;
            }
            const meta = this.registry.meta(cfg.type);
            try {
                // holder lets ctx.subscribe() find the instance even when
                // called from inside the device constructor.
                const holder = {};
                const instance = new (this.registry.Device(cfg.type))(this.ctxFor(id, holder), cfg);
                holder.dev = instance;
                // Pin conflict check (v1: one device per pin, any direction).
                const pins = meta.pins ? meta.pins(cfg) : [];
                for (const p of pins) {
                    if (typeof p !== 'number' || p < 0 || p >= gpioCount(this.chip) ||
                        (GPIO_ABSENT[this.chip] || new Set()).has(p)) {
                        errors.push(`${id}: pin ${p} is not a valid ${this.chip} GPIO`);
                        continue;
                    }
                    if (usedPins.has(p)) {
                        errors.push(`${id}: pin ${p} already used by ${usedPins.get(p)}`);
                        continue;
                    }
                    usedPins.set(p, id);
                }
                this.devices.set(id, { instance, meta, cfg });
                instance.onEmuReady?.();
            } catch (e) {
                errors.push(`${id}: ${e.message}`);
            }
        }

        this.post({
            type: PERIS_READY,
            ok: errors.length === 0,
            errors,
            devices: [...this.devices.values()].map(({ meta, cfg }) => ({
                id: cfg.id, type: cfg.type, title: meta.title,
            })),
        });

        // Push each device's initial state so views render before the
        // first pin change.
        for (const id of this.devices.keys()) this.dirty.add(id);
        this.flushStates(true);
    }

    command(id, cmd, params) {
        this.devices.get(id)?.instance.onCommand?.(cmd, params);
    }

    /** Called by the worker after every run_batch. */
    onBatchEnd() {
        this.sigbus.sample();
        this.flushStates(false);
    }

    flushStates(force) {
        const now = Date.now();
        if (!force && (this.dirty.size === 0 || now - this.lastFlush < STATE_FLUSH_MS)) return;
        this.lastFlush = now;
        for (const id of this.dirty) {
            const d = this.devices.get(id);
            if (!d) continue;
            let state;
            try { state = d.instance.getState ? d.instance.getState() : {}; }
            catch (e) { state = { error: e.message }; }
            this.post({ type: PERIS_STATE, id, state });
        }
        this.dirty.clear();
    }

    log(text, level = 'info') {
        this.post({ type: PERIS_LOG, level, text });
    }

    ctxFor(id, holder) {
        const rt = this;
        const self = () => holder.dev || rt.devices.get(id)?.instance;
        const subFn = () => self(); // sigbus resolves the instance lazily
        return {
            id,
            get chip() { return rt.chip; },
            get gpioCount() { return gpioCount(rt.chip); },
            setPinInput(pin, high) { rt.sigbus.setInput(pin, high); },
            readMem(addr, len) { return rt.emu ? rt.emu.read_memory(addr >>> 0, len) : new Uint8Array(0); },
            readU32(addr) {
                if (!rt.emu) return 0;
                const b = rt.emu.read_memory(addr >>> 0, 4);
                return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
            },
            cycles() { return rt.emu ? rt.emu.cycles() : 0; },
            subscribe(pins) { rt.sigbus.subscribe(subFn, pins); },
            unsubscribe() { rt.sigbus.unsubscribe(subFn); },
            markDirty() { rt.dirty.add(id); },
            log: (text, level) => rt.log(text, level),
        };
    }
}
