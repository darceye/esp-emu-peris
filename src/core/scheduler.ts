/*
 * Fine-grained batch scheduler (M4). run_batch(N) executes up to N guest
 * instructions, and gpio_state() is sampled once per call — so every edge
 * of a CPU-driven (bit-banged) waveform is only observable when N is small
 * compared with the signal's half period (M0 Q1a; ~99 MIPS at 40-instr
 * batches vs 5000+ MIPS at 50k). Devices therefore lease finer batches:
 *
 *   arm lease  — standing size while the device waits for bus activity
 *                (cheap enough to keep, coarse enough to catch a START);
 *   fine lease — temporary size while a transfer is in flight; expires on
 *                its cycle deadline (devices renew from onPinState/onBatch)
 *                or when the emulator fast-forwards through a CPU sleep
 *                window (M0: waveforms during sleep are not capturable —
 *                no point sampling, so the scheduler drops every fine lease
 *                when one batch's cycle jump exceeds SLEEP_FACTOR × size).
 *
 * The worker (and the smoke test) ask batchSize() once per run_batch; there
 * is no other execution loop, so the lease semantics live in exactly one
 * place. Pure logic — unit-tested against a fake cycle counter.
 */

/** Cycle-jump factor above which a batch counts as a CPU-sleep window. */
export const SLEEP_FACTOR = 16;

/** Leases are clamped into this range (instruction counts per batch). */
export const MIN_BATCH = 20;
export const MAX_BATCH = 100000;

export function clampBatch(n: number): number {
    if (!Number.isFinite(n)) return MAX_BATCH;
    return Math.min(MAX_BATCH, Math.max(MIN_BATCH, Math.round(n)));
}

interface FineLease { batch: number; until: number }

export class FineScheduler {
    /** deviceId → standing armed batch size. */
    private armed = new Map<string, number>();
    /** deviceId → active fine lease (at most one per device). */
    private fine = new Map<string, FineLease>();
    private lastCycles = -1;
    private lastSize = 0;

    /** Standing watch size while idle; called once per device lifetime. */
    arm(id: string, batch: number) {
        this.armed.set(id, clampBatch(batch));
    }

    /**
     * Engage (or renew) a fine window: batches of `batch` instructions for
     * the next `forCycles` emulator cycles. Fine beats armed; the lease is
     * dropped when it expires or the CPU sleeps.
     */
    requestFine(id: string, batch: number, forCycles: number) {
        this.fine.set(id, { batch: clampBatch(batch), until: this.lastCycles + forCycles });
    }

    /** Drop both leases of a device (destroy). */
    release(id: string) {
        this.armed.delete(id);
        this.fine.delete(id);
    }

    /** Drop everything (config rebuild — device ids are about to change). */
    reset() {
        this.armed.clear();
        this.fine.clear();
    }

    /** True while the device holds an unexpired fine lease (test hook). */
    isFine(id: string, cycles = this.lastCycles): boolean {
        const l = this.fine.get(id);
        return l != null && cycles < l.until;
    }

    /**
     * Size for the next run_batch call. `cycles` is the emulator cycle
     * counter right before the call; the returned size is also what the
     * caller must execute so the sleep heuristic stays calibrated.
     */
    nextSize(coarse: number, cycles: number): number {
        if (this.lastSize > 0 && cycles - this.lastCycles > this.lastSize * SLEEP_FACTOR) {
            this.fine.clear(); // time fast-forwarded: CPU slept, nothing to sample
        }
        this.lastCycles = cycles;
        for (const [id, l] of this.fine) if (cycles >= l.until) this.fine.delete(id);

        let size = this.armed.size + this.fine.size === 0
            ? coarse
            : Number.MAX_SAFE_INTEGER;
        for (const l of this.fine.values()) size = Math.min(size, l.batch);
        for (const a of this.armed.values()) size = Math.min(size, a);
        this.lastSize = size;
        return size;
    }
}
