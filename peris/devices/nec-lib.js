/*
 * nec-lib — shared helpers for the IR NEC device (M4): burst envelope
 * assembly from pin edges, frame decode from {on, off} segments, and the
 * RMT symbol-RAM → segments conversion. One semantic, one implementation
 * (AGENT.md §3.8): the plugin and the unit tests import this module; it is
 * not listed in manifest.json and must stay importable from Node (no
 * page-only code).
 *
 * Two capture paths feed the same decoder:
 *   - bit-bang pin capture (fine-batch sampling): edges → bursts. Inside a
 *     38 kHz burst edges are ≤ ~26 µs apart; a gap > 80 µs closes a burst,
 *     so every NEC burst (560 µs … 9 ms) becomes one {on, off} segment.
 *   - RMT channel RAM (post-transmission): each RMT word IS one segment
 *     (duration0 = high run, duration1 = low run); the RMT tick length is
 *     firmware-chosen, so the segments are normalised against the 9 ms
 *     leader before decoding.
 */

/** NEC timing constants in µs (tolerances absorb carrier-measured bursts). */
export const NEC_TIMING = {
    leaderOn: 9000,
    leaderOff: 4500,
    repeatOff: 2250,
    burst: 560,
    bit0Off: 560,
    bit1Off: 1690,
};

/** Close a burst when edges are farther apart than this (µs). */
export const BURST_GAP_US = 80;

/**
 * Assemble rising/falling edges into burst segments.
 * edges = [{ up: boolean, us: number }] in arrival order; a burst runs
 * from its first rising edge to its last rising edge (carrier duty makes
 * that ≈ the true burst minus one carrier half period — inside tolerance).
 * A burst closes at the NEXT rising edge more than gapUs later — during a
 * gap the line simply stays low, so there is no edge to close on. Returns
 * [{ on, off }] — off is the gap to the next burst; the trailing burst's
 * gap is unknown and left 0.
 */
export function edgesToSegments(edges, gapUs = BURST_GAP_US) {
    const segs = [];
    let startUs = -1;
    let endUs = -1;
    const close = (atUs) => {
        segs.push({ on: endUs - startUs, off: Math.max(0, atUs - endUs) });
        startUs = -1;
        endUs = -1;
    };
    for (const e of edges) {
        if (!e.up) continue;
        if (startUs >= 0 && e.us - endUs > gapUs) close(e.us);
        if (startUs < 0) { startUs = e.us; }
        endUs = e.us;
    }
    if (startUs >= 0) close(endUs);
    return segs;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * Decode one NEC frame from burst segments (µs). Returns null for anything
 * that is not a complete frame, else
 *   { repeat, addr, invAddr, cmd, invCmd, addr16, valid }
 * addr/cmd are the 8-bit fields; addr16 is the extended-address reading;
 * valid is true when both inverse fields match (standard NEC).
 *
 * Every threshold is a RATIO, never an absolute duration: the emulator's
 * guest clock is not wall-accurate (M4 measured esp_rom_delay_us advancing
 * emulator time at ~50% of nominal — a "9 ms" leader reads 4.5 ms), so the
 * decoder only relies on NEC's fixed shape: the leader burst dwarfs every
 * other burst (16:1), its trailing gap is 1/2 (normal) or 1/4 (repeat) of
 * its run, and a bit's gap-to-burst ratio is ≈1 (0) or ≈3 (1).
 */
export function decodeNec(segments) {
    if (!Array.isArray(segments) || segments.length < 2) return null;
    const lead = segments[0];
    // leader dominance: no other burst anywhere near the leader's run
    for (let i = 1; i < segments.length; i++) {
        if (segments[i].on > lead.on / 5) return null;
    }
    const gapRatio = lead.off / lead.on;

    if (near(gapRatio, 0.5, 0.14)) { // normal frame: 4500/9000
        if (segments.length < 34) return null;
        const bits = [];
        for (let i = 1; i <= 32; i++) {
            const s = segments[i];
            const r = s.off / s.on; // 560/560 = 1 → 0;  1690/560 ≈ 3 → 1
            if (near(r, 1, 0.55)) bits.push(0);
            else if (near(r, 3.0, 0.9)) bits.push(1);
            else return null;
        }
        // stop burst ≈ the bit bursts
        if (segments[33].on < segments[1].on * 0.4 || segments[33].on > segments[1].on * 2.5) return null;
        // NEC shifts LSB first within each byte
        const byte = (k) => {
            let v = 0;
            for (let i = 0; i < 8; i++) v |= bits[k * 8 + i] << i;
            return v;
        };
        const addr = byte(0), invAddr = byte(1), cmd = byte(2), invCmd = byte(3);
        return {
            repeat: false,
            addr, invAddr, cmd, invCmd,
            addr16: (invAddr << 8) | addr,
            valid: (addr ^ invAddr) === 0xff && (cmd ^ invCmd) === 0xff,
        };
    }

    if (near(gapRatio, 0.25, 0.08)) { // repeat frame: 2250/9000
        return { repeat: true, addr: null, invAddr: null, cmd: null, invCmd: null, addr16: null, valid: true };
    }
    return null;
}

/* ---- RMT capture path (channel RAM) ---------------------------------------- */

/**
 * Post-transmission channel-RAM words → µs segments. The copy encoder
 * writes one word per burst (duration0 = high run, duration1 = low run,
 * level0 = 1); an all-zero word terminates the stream. The tick length is
 * firmware-chosen, so segments are scaled by 9000µs / leader-ticks.
 * Returns null when the RAM does not start with a plausible leader.
 */
export function rmtWordsToSegments(words) {
    const segs = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (w === 0) break; // transmit terminator (measured, M3)
        const d0 = w & 0x7fff;
        const d1 = (w >>> 16) & 0x7fff;
        if (((w >>> 15) & 1) !== 1) return null; // unexpected level — not a TX stream
        segs.push({ on: d0, off: d1 });
        if (segs.length > 60) break; // longer than any NEC frame
    }
    if (segs.length < 2) return null;
    const leadTicks = segs[0].on;
    if (leadTicks < 3000 || leadTicks > 20000) return null; // leader 9ms ±: tick-agnostic window
    const scale = NEC_TIMING.leaderOn / leadTicks;
    return segs.map((s) => ({ on: s.on * scale, off: s.off * scale }));
}

/** Segments (µs) for a standard frame — test helper and example encoder. */
export function necFrameSegments(addr, cmd) {
    const t = NEC_TIMING;
    const segs = [{ on: t.leaderOn, off: t.leaderOff }];
    const bytes = [addr & 0xff, ~addr & 0xff, cmd & 0xff, ~cmd & 0xff];
    for (const b of bytes) {
        for (let i = 0; i < 8; i++) {
            segs.push({ on: t.burst, off: (b >> i) & 1 ? t.bit1Off : t.bit0Off });
        }
    }
    segs.push({ on: t.burst, off: 0 });
    return segs;
}
