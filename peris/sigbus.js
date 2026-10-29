/*
 * Pin signal bus (worker side). After every run_batch the worker calls
 * sample(); changed pins are dispatched to the devices watching them.
 * Devices subscribe through a *getter* because they typically call
 * ctx.subscribe() from inside their constructor, before the runtime has
 * the instance registered — the getter is resolved lazily at dispatch.
 * Cost per batch with no changes: one gpio_state() call and four XORs.
 */
export class Sigbus {
    constructor(emu) {
        this.emu = emu;           // WasmEmulator or null before load
        this.subs = new Map();    // pin -> Set<() => device>
        this.lastOut0 = 0; this.lastOut1 = 0;
        this.lastOe0 = 0; this.lastOe1 = 0;
    }

    attach(emu) {
        this.emu = emu;
        this.lastOut0 = this.lastOut1 = this.lastOe0 = this.lastOe1 = 0;
    }

    subscribe(getDev, pins) {
        for (const p of pins) {
            if (!this.subs.has(p)) this.subs.set(p, new Set());
            this.subs.get(p).add(getDev);
        }
    }

    unsubscribe(getDev) {
        for (const set of this.subs.values()) set.delete(getDev);
    }

    setInput(pin, high) {
        if (this.emu) this.emu.gpio_set_input(pin, !!high);
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
        const dispatch = (changed, base, outWord, oeWord) => {
            let bits = changed;
            while (bits) {
                const low = bits & (bits - 1);        // clear lowest set bit
                const bitIdx = 31 - Math.clz32(bits ^ low); // index of that bit
                const pin = base + bitIdx;
                const set = this.subs.get(pin);
                if (set) {
                    const s2 = {
                        out: ((outWord >>> bitIdx) & 1) !== 0,
                        oe: ((oeWord >>> bitIdx) & 1) !== 0,
                        cycles,
                    };
                    for (const getDev of set) {
                        const dev = getDev();
                        if (dev) dev.onPinState?.(pin, s2);
                    }
                }
                bits = low;
            }
        };
        dispatch(chOut0, 0, out0, oe0);
        dispatch(chOut1, 32, out1, oe1);
        dispatch(chOe0, 0, out0, oe0);   // oe changes re-report current out
        dispatch(chOe1, 32, out1, oe1);
    }
}
