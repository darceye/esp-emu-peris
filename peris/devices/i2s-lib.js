/*
 * i2s-lib — shared helpers for the bit-bang I2S audio codec device (M6).
 * One semantic, one implementation (AGENT.md §3.8): the wire-protocol
 * engine (Philips I2S framing over four firmware bit-banged GPIOs) lives
 * here; the plugin and the unit tests import this module. Not listed in
 * manifest.json → never loaded as a device itself. No page-only helpers
 * here (Node tests must be able to import the file).
 *
 * Why "bit-bang": the esp-emulator wasm has no I2S model at all (M6
 * evidence chain in docs/FEASIBILITY.md — zero `i2s` strings, no periph
 * module, zero register-block constants in any encoding, block reads 0),
 * so only CPU-driven GPIO_OUT flips on BCLK/WS/DOUT are observable and
 * only gpio_set_input can feed DIN back — the same M4 basis as the
 * bit-bang I2C slave.
 *
 * Wire model (matches gpio_state() and a paced soft master):
 *   - the firmware is the I2S *master*: it toggles BCLK and WS (WS
 *     changes on the falling BCLK edge, Philips convention) and drives
 *     DOUT as a push-pull output; step() receives end-of-batch level
 *     snapshots {bclk, ws, dout};
 *   - playback decode: DOUT is sampled on the rising BCLK edge, MSB
 *     first, one slot per WS half-period. The slot ending when WS rises
 *     ran under WS low = LEFT (Philips, fixed mapping — an inverted-WS
 *     master only swaps channels). The bit count is validated against
 *     `bits` at each WS edge — a mismatch means edges were lost inside
 *     one fine batch (AGENT.md §2): the slot is dropped and decoding
 *     resynchronises on the next WS edge;
 *   - microphone inject: the engine drives DIN through driveDin(bit) —
 *     the slot's MSB right after a WS edge, the next bit on every
 *     falling BCLK edge (the data-change edge); the master samples DIN
 *     on the following rising edge one or more batches later — the M4
 *     answer cadence, same as the I2C ACK pull. When a WS edge and the
 *     coinciding BCLK fall land in the same batch snapshot, that fall IS
 *     the slot load (no extra advance — otherwise the MSB would be
 *     skipped). An empty queue drives silence; a full queue drops
 *     oldest (the device sets the cap);
 *   - timing is ratio-based only (M4 rule): the frame rate is estimated
 *     from the median WS period in emulator cycles — never from
 *     wall-clock or absolute-us measurements (guest delays run ~50%).
 *
 * The engine is fed one levels snapshot per pin change and is a no-op
 * when nothing changed — it tolerates being stepped twice with the same
 * end-of-batch levels when several pins moved inside one batch. Edges
 * are only guaranteed to be seen while the device holds a fine sampling
 * lease (ctx.fineSampling); the pacing requirement (BCLK half-period ≥
 * the fine batch size in instructions) is documented on the plugin.
 */

/** WS periods kept for the rate median. */
export const RATE_WINDOW = 8;

/**
 * Level-driven I2S codec engine. Constructor takes:
 *   opts.bits          slot width in bits (16 default; 24/32 shift further)
 *   opts.channels      1 (one sample per WS period) or 2 (Philips stereo:
 *                      one slot per WS half-period — the default)
 *   opts.cyclesPerUs   chip clock for the rate estimate (device supplies)
 *   driveDin(bit)      electrical callback for the DIN input path
 *   onOut(n)           n new samples appended to the decoded out buffer
 *   onDropped(bits)    a slot was dropped (edge count mismatch)
 * Decoded audio accumulates interleaved in `out` — drainOut() takes it.
 */
export class I2sCodecEngine {
    constructor(opts = {}, driveDin = () => {}, onOut = () => {}) {
        this.bits = opts.bits === 24 || opts.bits === 32 ? opts.bits : 16;
        this.channels = opts.channels === 1 ? 1 : 2;
        this.cyclesPerUs = opts.cyclesPerUs || 0;
        this.driveDin = driveDin;
        this.onOut = onOut;
        this.onDropped = opts.onDropped || (() => {});
        this.reset();
    }

    reset() {
        this.prev = { bclk: false, ws: false, dout: false };
        // TX decode state
        this.slot = 0;          // shift accumulator (current slot, MSB-first)
        this.slotBits = 0;      // bits sampled into the current slot
        this.pendingL = null;   // completed left slot awaiting its pair
        this.out = [];          // decoded audio, interleaved (see channels)
        this.frames = 0;        // completed frames (mono: slots)
        this.drops = 0;         // slots lost to edge-count mismatches
        // rate estimate state
        this._periods = [];
        this._lastWsCycle = null;
        // RX inject state
        this.bitIndex = 0;      // bit position inside the current DIN slot
        this.curWord = 0;       // current DIN slot being shifted out
        this.queue = [];        // pending mic samples (interleaved)
        this.underruns = 0;     // slots started with an empty queue
        this.driveDin(0);
    }

    /** True while a stream is flowing (fine lease hint for the device). */
    get busy() {
        return this.slotBits > 0 || this.queue.length > 0;
    }

    /**
     * One levels snapshot of the bus. Returns true when an edge was
     * consumed. `cycles` (optional, emulator cycles of this observation)
     * feeds the rate estimate.
     */
    step(levels, cycles) {
        const bclk = !!levels.bclk, ws = !!levels.ws, dout = !!levels.dout;
        let consumed = false;
        let wsEdge = false;
        if (ws !== this.prev.ws) {
            consumed = true;
            wsEdge = true;
            this._wsEdge(ws, cycles);
        }
        if (bclk !== this.prev.bclk) {
            consumed = true;
            if (bclk) {
                // rising edge: the master samples DOUT (and DIN)
                this._sample(dout);
            } else if (!wsEdge) {
                // falling edge: data changes. The fall coinciding with a
                // WS edge already happened inside _wsEdge (slot load) —
                // advancing here would skip the MSB.
                this._advanceDin();
            }
        }
        this.prev = { bclk, ws, dout };
        return consumed;
    }

    /* ---- playback decode (DOUT → out buffer) ------------------------------- */

    _sample(dout) {
        this.slot = ((this.slot << 1) | (dout ? 1 : 0)) >>> 0;
        this.slotBits++;
    }

    _wsEdge(wsNow, cycles) {
        if (cycles != null && cycles > 0) {
            if (this._lastWsCycle != null) {
                const period = cycles - this._lastWsCycle;
                if (period > 0) {
                    this._periods.push(period);
                    if (this._periods.length > RATE_WINDOW) this._periods.shift();
                }
            }
            this._lastWsCycle = cycles;
        }
        // a WS edge closes the slot clocked in the ending half-period
        if (this.slotBits === this.bits) {
            this._emitSlot(wsNow);
        } else if (this.slotBits > 0) {
            this.drops++;
            this.onDropped(this.slotBits);
        }
        this.slot = 0;
        this.slotBits = 0;
        // and starts a new DIN slot
        this._loadDinSlot();
    }

    _emitSlot(wsNow) {
        const v = this.slot;
        // normalise every slot width onto the Int16 transport (the state
        // chunks and the DIN inject are 16-bit): MSB-aligned — a 24-bit
        // sample keeps its top 16 bits, mirroring a DAC's behaviour and
        // the left-justified DIN path in _loadDinSlot
        let s;
        if (this.bits === 16) s = (v << 16) >> 16;           // sign-extend
        else if (this.bits === 24) s = ((v << 8) >> 8) >> 8; // /256, signed
        else s = (v | 0) >> 16;                              // /65536, signed
        // the slot just closed ran under WS = !wsNow; WS low = LEFT
        const isLeft = wsNow;
        if (this.channels === 1) {
            this.frames++;
            this.out.push(s);
            this.onOut(1);
        } else if (isLeft) {
            this.pendingL = s;
        } else {
            this.frames++;
            this.out.push(this.pendingL ?? 0, s);
            this.onOut(2);
            this.pendingL = null;
        }
    }

    /** Median WS period in emulator cycles (0 until measurable). One WS
     *  period = one frame (both channels / one mono sample). */
    wsPeriodCycles() {
        if (this._periods.length < 2) return 0;
        const sorted = this._periods.slice().sort((a, b) => a - b);
        return sorted[sorted.length >> 1];
    }

    /** Detected frame rate in Hz (0 until measurable). */
    detectedRate() {
        const p = this.wsPeriodCycles();
        if (!p || !this.cyclesPerUs) return 0;
        return Math.round((this.cyclesPerUs * 1e6) / p);
    }

    /** Take everything decoded since the last drain (Int16Array chunk). */
    drainOut() {
        if (!this.out.length) return null;
        const chunk = Int16Array.from(this.out);
        this.out.length = 0;
        return chunk;
    }

    /* ---- microphone inject (queue → DIN) ----------------------------------- */

    /** Append mic samples (interleaved when stereo — the device decides). */
    pushMic(samples) {
        for (let i = 0; i < samples.length; i++) this.queue.push(samples[i] | 0);
    }

    /** Bound the queue: drop oldest so at most `max` samples remain. */
    trimQueue(max) {
        while (this.queue.length > max) this.queue.shift();
    }

    _loadDinSlot() {
        if (this.queue.length === 0) {
            this.underruns++;
            this.curWord = 0;
        } else {
            const v = this.queue.shift();
            // left-justify into 32 bits so the MSB comes out first
            this.curWord = ((v & 0xffff) << (32 - this.bits)) >>> 0;
        }
        this.bitIndex = 0;
        this._driveCurrentBit(); // bit 0 of the slot = bit 31 of curWord
    }

    _advanceDin() {
        // curWord is left-justified in 32 bits: sample bit k sits at bit
        // 31-k. Hold the final bit through extra clocks in the same slot.
        if (this.bitIndex + 1 >= this.bits) return;
        this.bitIndex++;
        this._driveCurrentBit();
    }

    _driveCurrentBit() {
        const shift = 31 - this.bitIndex;
        this.driveDin((this.curWord >>> shift) & 1);
    }
}

/* ---- pure helpers (unit-tested bit-exactly) -------------------------------- */

/** Convert Float32 [-1,1] to Int16 (clamp + round, asymmetric like SDL). */
export function floatToI16(input) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
        const v = Math.max(-1, Math.min(1, input[i]));
        out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    }
    return out;
}

/** Linear resample of a Float32Array from inRate to outRate (mono). */
export function resample(input, inRate, outRate) {
    if (inRate === outRate || input.length === 0) return input;
    const n = Math.floor(input.length * outRate / inRate);
    const out = new Float32Array(n);
    const step = inRate / outRate;
    for (let i = 0; i < n; i++) {
        const p = i * step;
        const i0 = Math.floor(p);
        const i1 = Math.min(i0 + 1, input.length - 1);
        out[i] = input[i0] + (input[i1] - input[i0]) * (p - i0);
    }
    return out;
}

/**
 * Reference sine table matching the P7 probe firmware: sample k of N is
 * round(amp * sin(2π·k/N)) — the firmware builds the identical int32
 * table; the smoke test decodes the DOUT stream and compares.
 */
export function sineTable(n, amp) {
    const out = [];
    for (let k = 0; k < n; k++) {
        out.push(Math.round(amp * Math.sin(2 * Math.PI * k / n)));
    }
    return out;
}
