/*
 * Peripherals runtime (worker side): owns device instances, wires them to
 * the emulator (sigbus + MMIO reads + input drive), and pushes throttled
 * state updates to the page.
 */
import { Sigbus } from './sigbus.js';
import type { EmuGpio } from './sigbus.js';
import { loadRegistry } from './registry.js';
import type { Registry } from './registry.js';
import { PERIS_READY, PERIS_STATE, PERIS_LOG } from './protocol.js';
import type { PerisReadyMsg, PerisStateMsg, PerisLogMsg } from './protocol.js';
import { gpioCount, absentPins } from './chips.js';
import type { DeviceCtx, DeviceConfig, DeviceLike, DeviceMeta, PerisConfig } from './types.js';

const STATE_FLUSH_MS = 33; // ~30 fps per device

export type RuntimePost = (msg: PerisReadyMsg | PerisStateMsg | PerisLogMsg) => void;

interface DeviceEntry {
    instance: DeviceLike;
    meta: DeviceMeta;
    cfg: DeviceConfig;
}

interface CtxHolder { dev?: DeviceLike }

export class PerisRuntime {
    private registry: Registry | null = null;
    private sigbus: Sigbus;
    private emu: EmuGpio | null = null;
    private chip = 'esp32c3';
    private devices = new Map<string, DeviceEntry>();
    private dirty = new Set<string>();
    private lastFlush = 0;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    /** overridable for tests; the worker passes self.postMessage */
    post: RuntimePost = (msg) => { (globalThis as { postMessage?: (m: unknown) => void }).postMessage?.(msg); };

    constructor() {
        this.sigbus = new Sigbus(null);
    }

    async init(): Promise<void> {
        this.registry = await loadRegistry();
    }

    attachEmu(emu: EmuGpio | null, chip?: string) {
        this.emu = emu;
        if (chip) this.chip = chip;
        this.sigbus.attach(emu);
        for (const { instance } of this.devices.values()) instance.onEmuReady?.();
    }

    /** Validate + instantiate a full config. Always answers PERIS_READY. */
    async applyConfig(config: PerisConfig | undefined): Promise<void> {
        // A config can arrive before initWasm finished loading the device
        // registry (page reload with a saved config) — wait for it once.
        if (!this.registry) {
            try { await this.init(); } catch { /* reported below */ }
        }
        const errors: string[] = [];
        const usedPins = new Map<number, string>();

        for (const { instance } of this.devices.values()) {
            try { instance.destroy?.(); } catch { /* ignore */ }
        }
        this.devices.clear();
        this.sigbus = new Sigbus(this.emu);

        const devices = Array.isArray(config?.devices) ? config.devices : [];
        for (const cfg of devices) {
            const id = typeof cfg?.id === 'string' ? cfg.id : '';
            if (!id || !cfg?.type) { errors.push('device entry missing id/type'); continue; }
            const meta = this.registry?.meta(cfg.type);
            if (!this.registry || !meta) {
                errors.push(`${id}: unknown type "${String(cfg.type)}"`);
                continue;
            }
            try {
                // holder lets ctx.subscribe() find the instance even when
                // called from inside the device constructor.
                const holder: CtxHolder = {};
                const instance = new meta(this.ctxFor(id, holder), cfg);
                holder.dev = instance;

                // Pin conflict check (v1: one device per pin, any direction).
                const pins = meta.pins(cfg);
                for (const p of pins) {
                    if (typeof p !== 'number' || p < 0 || p >= gpioCount(this.chip) || absentPins(this.chip).has(p)) {
                        errors.push(`${id}: pin ${String(p)} is not a valid ${this.chip} GPIO`);
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
                errors.push(`${id}: ${(e as Error).message}`);
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

    command(id: string, cmd: string, params?: Record<string, unknown>) {
        this.devices.get(id)?.instance.onCommand?.(cmd, params);
    }

    /** Called by the worker after every run_batch. */
    onBatchEnd() {
        this.sigbus.sample();
        this.flushStates(false);
    }

    flushStates(force: boolean) {
        const now = Date.now();
        if (!force) {
            if (this.dirty.size === 0) return;
            if (now - this.lastFlush < STATE_FLUSH_MS) {
                // Throttled: never drop the last dirty state — schedule a
                // trailing flush so the page always converges.
                if (this.flushTimer == null) {
                    this.flushTimer = setTimeout(() => {
                        this.flushTimer = null;
                        this.flushStates(true);
                    }, STATE_FLUSH_MS);
                }
                return;
            }
        }
        if (this.flushTimer != null) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        this.lastFlush = now;
        for (const id of this.dirty) {
            const d = this.devices.get(id);
            if (!d) continue;
            let state: Record<string, unknown>;
            try { state = d.instance.getState ? d.instance.getState() : {}; }
            catch (e) { state = { error: (e as Error).message }; }
            this.post({ type: PERIS_STATE, id, state });
        }
        this.dirty.clear();
    }

    log(text: string, level: 'info' | 'warn' | 'error' = 'info') {
        this.post({ type: PERIS_LOG, level, text });
    }

    private ctxFor(id: string, holder: CtxHolder): DeviceCtx {
        const rt = this;
        const self = () => holder.dev ?? rt.devices.get(id)?.instance;
        const subFn = () => self(); // sigbus resolves the instance lazily
        return {
            id,
            get chip() { return rt.chip; },
            get gpioCount() { return gpioCount(rt.chip); },
            setPinInput: (pin, high) => rt.sigbus.setInput(pin, high),
            readMem: (addr, len) => rt.emu ? rt.emu.read_memory(addr >>> 0, len) : new Uint8Array(0),
            readU32(addr) {
                if (!rt.emu) return 0;
                const b = rt.emu.read_memory(addr >>> 0, 4);
                return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
            },
            cycles: () => rt.emu ? rt.emu.cycles() : 0,
            subscribe: (pins) => rt.sigbus.subscribe(subFn, pins),
            unsubscribe: () => rt.sigbus.unsubscribe(subFn),
            markDirty: () => { rt.dirty.add(id); },
            log: (text, level) => rt.log(text, level),
        };
    }

    /** Test/introspection helper: is a device id instantiated? */
    has(id: string): boolean {
        return this.devices.has(id);
    }
}
