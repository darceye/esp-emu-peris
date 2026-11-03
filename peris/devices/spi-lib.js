/*
 * spi-lib — shared helpers for register-level hardware-SPI devices (M5).
 *
 * One semantic, one implementation (AGENT.md §3.8): wiring discovery, the
 * no-DMA W-window TX capture and the GDMA descriptor walk live here; the
 * plugins (max7219 hw-SPI mode, ili9341, future sniffers) and the unit
 * tests import this module. Not in manifest.json → never a device itself.
 * No page-only code at import time (Node tests import the file).
 *
 * M5 facts this encodes (docs/SPI-M5.md, wasm v0.51.0, C3):
 *   - GP-SPI2 is modelled; transfers complete and the register file is
 *     readable through read_memory(). Matrix wiring is discoverable by
 *     scanning GPIO_FUNCn_OUT_SEL for the FSPI signal ids — same method
 *     as LEDC/RMT (ledc-lib.js).
 *   - No-DMA transfers: the hal loads TX into W0..W15, fires CMD, and the
 *     model overwrites W with the RX result (all 1s) at completion — so a
 *     batch-boundary watcher sees the TX exactly between load and fire.
 *     Measured catch rate at run_batch sizes: 10 → 9/9, 20 → 10/10,
 *     60 → 10/10, 100 → 1/9. Devices therefore arm at ≤60.
 *   - MS_DLEN bits[17:0] = transfer length in bits − 1, readable in the
 *     same window (hal writes it before loading W).
 *   - DMA transfers bypass W; the payload sits in guest RAM and the GDMA
 *     outlink register names the first descriptor — low 20 bits, DRAM at
 *     0x3FC00000 | value — and the pointer stays valid after completion,
 *     so the chain can be walked lazily (no race). The emulator does NOT
 *     implement GDMA PERI_SEL semantics (reads the default 63 while SPI2
 *     transfers run), so a channel is identified by stickiness + descriptor
 *     validation, never by PERI_SEL.
 */

/* ---------------------------------------------------------------- wiring --- */

/**
 * SPI signal-id → role map for the chip's mmio table (sclk / mosi / miso /
 * cs0..cs5). Empty when the chip has no SPI table — devices must idle.
 */
export function spiSignalMap(mmio) {
    const map = new Map(); // sig id → role
    if (!mmio || !mmio.spi || !mmio.signals) return map;
    const roles = [
        ['sclk', 'spiClk'], ['mosi', 'spiD'], ['miso', 'spiQ'],
        ['cs0', 'spiCs0'], ['cs1', 'spiCs1'], ['cs2', 'spiCs2'],
        ['cs3', 'spiCs3'], ['cs4', 'spiCs4'], ['cs5', 'spiCs5'],
    ];
    for (const [role, key] of roles) {
        const sig = mmio.signals[key];
        if (sig !== undefined) map.set(sig, role);
    }
    return map;
}

/**
 * Scan every pad's GPIO_FUNCn_OUT_SEL for FSPI routing — the same scan as
 * discoverLedcPins, with the chip's signal table deciding the candidates.
 * Returns { sclk, mosi, miso, cs } (pin numbers or null; cs = array of
 * pads routed to a hardware CS signal) or null when the chip has no SPI
 * table. One readU32 per pad — call it sparsely (rescan cadence), never
 * per batch.
 */
export function discoverSpiWiring(ctx) {
    const mmio = ctx.mmio;
    const want = spiSignalMap(mmio);
    if (want.size === 0) return null;
    const { funcOutSelBase, funcOutSelStride } = mmio.gpio;
    const out = { sclk: null, mosi: null, miso: null, cs: [] };
    for (let pin = 0; pin < ctx.gpioCount; pin++) {
        const sel = ctx.readU32(funcOutSelBase + funcOutSelStride * pin);
        const role = want.get(sel & 0xff); // C3: 8-bit field (M5; 0x80 = plain GPIO)
        if (role === undefined) continue;
        if (role.startsWith('cs')) out.cs.push(pin);
        else out[role] = pin;
    }
    return out;
}

/* --------------------------------------------------- W-window TX capture --- */

/** The RX residue the model writes over W at transfer completion (M5). */
export const SPI_WIPE = 0xffffffff;

/**
 * Batches a loaded-but-unflushed transfer may age before the engine
 * force-flushes it: the driver fires CMD immediately after loading W, so
 * an unflushed pending only means the completion wipe never became
 * observable (e.g. the bus was torn down right after the last transfer —
 * measured in P6: the final MAX7219 frame). Force-flushing then is
 * always correct.
 */
export const PENDING_TIMEOUT_BATCHES = 300;

/** Unpack W words into bytes (byte i of a word sits at bits [8i+7:8i]). */
export function wordsToBytes(words, byteLen) {
    const n = Math.min(byteLen, words.length * 4);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = (words[i >> 2] >>> (8 * (i & 3))) & 0xff;
    return out;
}

/**
 * No-DMA TX capture, fed one sample per run_batch from the device's
 * onBatch(). Reads W0 while idle (one readU32); a change away from the
 * residue means the driver loaded TX — the whole window plus MS_DLEN is
 * snapshotted immediately. The next change (the model's completion wipe,
 * or the next load) flushes the pending transfer to `onTransfer`.
 *
 * onTransfer(bytes: Uint8Array, bits: number) — bits is the MS_DLEN+1
 * transfer length; bytes carries ceil(bits/8) TX bytes.
 *
 * Misses (a load and its wipe inside one batch gap) are counted in
 * `dropped` — same contract as max7219's bit-bang engine: never show
 * garbage, drivers that re-push registers self-heal. Known residual limit:
 * two IDENTICAL back-to-back transfers inside one batch gap merge into a
 * single event (the second load leaves W0 unchanged) — display-style
 * frame streams never hit this; periodic register re-pushes self-heal.
 */
export class SpiWindowEngine {
    constructor(ctx, onTransfer) {
        this.ctx = ctx;
        this.onTransfer = onTransfer;
        this.reset();
    }

    reset() {
        this.pending = null;   // {words:[u32 x16], bits} — loaded, not yet sent
        this.age = 0;          // batches the pending has been waiting
        this.lastW0 = null;    // previous batch's W0 (null = first sample)
        this.transfers = 0;
        this.dropped = 0;
    }

    /** True while a TX sits loaded but not yet flushed (fine-lease hint). */
    get busy() {
        return this.pending != null;
    }

    /** One sample — call from onBatch() every batch while armed. */
    sample() {
        const spi = this.ctx.mmio && this.ctx.mmio.spi;
        if (!spi) return;
        const w0 = this.ctx.readU32(spi.wBase);
        if (w0 !== this.lastW0) {
            const first = this.lastW0 === null;
            this.lastW0 = w0;
            if (first) {
                // power-on residue is 0 (skip); any other live value means
                // the observer attached after the firmware had already
                // loaded a transfer — treat it as a load
                if (w0 !== 0 && w0 !== SPI_WIPE) this._load(spi, w0);
                return;
            }
            if (w0 === SPI_WIPE) {
                // completion of the pending transfer (or stray residue)
                if (this.pending) this._flush();
                this.age = 0;
                return;
            }
            // a TX load — possibly over a wipe we never observed
            if (this.pending) {
                // the previous transfer still went out (a new load implies
                // it fired); the completion event was swallowed by one batch
                // gap
                this._flush();
                this.dropped++;
            }
            this._load(spi, w0);
            this.age = 0;
            return;
        }
        // unchanged W: age out a pending whose wipe never showed (bus torn
        // down right after the last transfer — the driver always fires CMD
        // immediately after loading W, so the transfer did go out)
        if (this.pending && ++this.age >= PENDING_TIMEOUT_BATCHES) this._flush();
    }

    /** Force the pending transfer out (transaction boundary from outside). */
    flush() {
        if (this.pending) this._flush();
    }

    _load(spi, w0) {
        const words = new Array(spi.wWords);
        words[0] = w0;
        for (let i = 1; i < spi.wWords; i++) words[i] = this.ctx.readU32(spi.wBase + 4 * i);
        const bits = (this.ctx.readU32(spi.msDlen) & 0x3ffff) + 1;
        this.pending = { words, bits };
    }

    _flush() {
        const { words, bits } = this.pending;
        this.pending = null;
        this.transfers++;
        this.onTransfer(wordsToBytes(words, Math.ceil(bits / 8)), bits);
    }
}

/* ---------------------------------------------------------- GDMA payload --- */

/** Descriptor caps: walk at most this many nodes / bytes (sanity guards). */
const MAX_DESCS = 64;
const MAX_BYTES = 1 << 20;

/**
 * Walk the GDMA out-descriptor chain and return the concatenated payload,
 * or null when no channel has an outlink. Channel choice: `sticky` first
 * (the channel that produced the previous payload — the emulator does not
 * implement PERI_SEL, so stickiness + descriptor validation is the only
 * binding), then the rest. Descriptors whose buffer is not DRAM or whose
 * length field is zero reject the channel (validation doubles as a filter
 * against other peripherals' DMA, e.g. WiFi).
 */
export function readDmaPayload(ctx, sticky) {
    const spi = ctx.mmio && ctx.mmio.spi;
    if (!spi) return null;
    const mask = (1 << spi.gdma.addrBits) - 1;
    const order = [];
    if (sticky != null && sticky >= 0 && sticky < spi.gdma.outLink.length) order.push(sticky);
    for (let i = 0; i < spi.gdma.outLink.length; i++) if (i !== sticky) order.push(i);
    for (const ch of order) {
        const raw = ctx.readU32(spi.gdma.outLink[ch]);
        const addr = raw & mask;
        if (addr === 0) continue;
        const head = spi.gdma.dramBase | addr;
        const walked = readDmaChainAt(ctx, head);
        if (walked) return { ...walked, channel: ch };
    }
    return null;
}

/**
 * Walk the descriptor chain starting at a KNOWN first-descriptor address
 * (cached from a previous in-flight read). Needed because the driver/hal
 * clears the outlink between transactions (P6 trace), while the descriptor
 * struct in guest RAM still describes the transaction that just ended —
 * the only recovery path for 1-byte command transactions whose in-flight
 * window is shorter than one fine batch. Returns null when the chain does
 * not validate.
 */
export function readDmaChainAt(ctx, head) {
    const spi = ctx.mmio && ctx.mmio.spi;
    if (!spi || !(head >>> 0) || !isDram(ctx, head, spi)) return null;
    let desc = head;
    const parts = [];
    let total = 0, n = 0;
    while (n < MAX_DESCS && total < MAX_BYTES) {
        const w0 = ctx.readU32(desc);
        const len = (w0 >>> 12) & 0xfff;
        const buf = ctx.readU32(desc + 4);
        const next = ctx.readU32(desc + 8);
        if (len === 0 || !isDram(ctx, buf, spi)) return null;
        parts.push([buf, len]);
        total += len;
        n++;
        const eof = (w0 >>> 30) & 1;
        if (eof || next === 0 || !isDram(ctx, next, spi)) break;
        desc = next;
    }
    if (n === 0) return null;
    // concatenate in <=4 KiB read_memory chunks (the wasm API cap)
    const out = new Uint8Array(total);
    let at = 0;
    for (const [buf, len] of parts) {
        let left = len;
        while (left > 0) {
            const take = Math.min(left, 4096);
            out.set(readChunk(ctx, buf + (len - left), take), at);
            at += take;
            left -= take;
        }
    }
    return { bytes: out, head, bufs: parts.map(([b]) => b) };
}

function isDram(ctx, addr, spi) {
    const lo = spi.gdma.dramBase, hi = spi.gdma.dramBase + (1 << spi.gdma.addrBits);
    return addr >>> 0 >= lo && addr >>> 0 < hi;
}

function readChunk(ctx, addr, len) {
    const b = ctx.readMem(addr >>> 0, len);
    // readMem may return fewer bytes at the DRAM end — pad with zeros
    if (b.length === len) return b;
    const out = new Uint8Array(len);
    out.set(b.subarray(0, Math.min(b.length, len)));
    return out;
}
