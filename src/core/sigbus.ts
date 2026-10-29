/*
 * Pin signal bus (worker side). After every run_batch the worker calls
 * sample(); changed pins are dispatched to the devices watching them.
 * Devices subscribe through a *getter* because they typically call
 * ctx.subscribe() from inside their constructor, before the runtime has
 * the instance registered — the getter is resolved lazily at dispatch.
 * Cost per batch with no changes: one gpio_state() call and four XORs.
 */
import type { DeviceLike, PinState } from './types.js';

/** Minimal emulator surface the runtime needs (WasmEmulator satisfies this). */
export interface EmuGpio {
    gpio_state(): ArrayLike<number>;
    gpio_set_input(pin: number, high: boolean): void;
    read_memory(addr: number, len: number): Uint8Array;
    cycles(): number;
}

export class Sigbus {
    private emu: EmuGpio | null;
    /** pin -> Set of lazy device getters */
    private subs = new Map<number, Set<() => DeviceLike | undefined>>();
    private lastOut0 = 0; private lastOut1 = 0;
    private lastOe0 = 0; private lastOe1 = 0;

    constructor(emu: EmuGpio | null) {
        this.emu = emu;
    }

    attach(emu: EmuGpio | null) {
        this.emu = emu;
        this.lastOut0 = this.lastOut1 = this.lastOe0 = this.lastOe1 = 0;
    }

    subscribe(getDev: () => DeviceLike | undefined, pins: number[]) {
        for (const p of pins) {
            let set = this.subs.get(p);
            if (!set) { set = new Set(); this.subs.set(p, set); }
            set.add(getDev);
        }
    }

    unsubscribe(getDev: () => DeviceLike | undefined) {
        for (const set of this.subs.values()) set.delete(getDev);
    }

    setInput(pin: number, high: boolean) {
        if (this.emu) this.emu.gpio_set_input(pin, high);
    }

    /** Read gpio_state() and notify subscribers of changed pins. */
    sample() {
        if (this.subs.size === 0 || !this.emu) return;
        const s = this.emu.gpio_state();
        const out0 = s[0] >>> 0, out1 = s[1] >>> 0, oe0 = s[2] >>> 0, oe1 = s[3] >>> 0;
        const chOut0 = out0 ^ this.lastOut0, chOut1 = out1 ^ this.lastOut1;
        const chOe0 = oe0 ^ this.lastOe0, chOe1 = oe1 ^ this.lastOe1;
        this.lastOut0 = out0; this.lastOut1 = out1;
        this.lastOe0 = oe0; this.lastOe1 = oe1;
        if ((chOut0 | chOut1 | chOe0 | chOe1) === 0) return;

        const cycles = this.emu.cycles();
        // Union mask per word: a pin is notified at most once per sample,
        // with the current out/oe regardless of which of the two changed.
        const dispatch = (changed: number, base: number, outWord: number, oeWord: number) => {
            let bits = changed;
            while (bits) {
                const low = bits & (bits - 1);              // clear lowest set bit
                const bitIdx = 31 - Math.clz32(bits ^ low); // index of that bit
                const pin = base + bitIdx;
                const set = this.subs.get(pin);
                if (set) {
                    const st: PinState = {
                        out: ((outWord >>> bitIdx) & 1) !== 0,
                        oe: ((oeWord >>> bitIdx) & 1) !== 0,
                        cycles,
                    };
                    for (const getDev of set) {
                        const dev = getDev();
                        if (dev) dev.onPinState?.(pin, st);
                    }
                }
                bits = low;
            }
        };
        dispatch(chOut0 | chOe0, 0, out0, oe0);
        dispatch(chOut1 | chOe1, 32, out1, oe1);
    }
}
