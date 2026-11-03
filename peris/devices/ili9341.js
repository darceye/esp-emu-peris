/*
 * ILI9341 SPI display — renders the firmware's hardware-SPI2 command
 * stream (esp_lcd / Arduino-style ILI9341 drivers) as a canvas.
 *
 * Register-level listener (M5, docs/SPI-M5.md): claims no pads
 * (`static passive = true`) and never drives anything — the GPIO matrix
 * carries SCLK/MOSI invisibly (M0), so the device reads the stream from
 * the SPI registers instead:
 *
 *   - on a DMA-enabled bus (esp_lcd) EVERY transaction — commands
 *     included — goes through GDMA and never touches W (M5: DMA bypasses
 *     the staging window). The GDMA outlink names the first descriptor
 *     and the pointer stays valid after completion, so each transaction
 *     boundary walks the chain lazily (no race). Commands always execute;
 *     data feeds are signature-deduped (esp_lcd reuses the descriptor
 *     chain, so the outlink value alone cannot detect a new frame);
 *   - on a DMA-less bus (Arduino-style drivers) transactions ride the
 *     W0..W15 window instead (spi-lib SpiWindowEngine, one sample per
 *     armed batch — M5 measured catch rate 10/10 at arm 60);
 *   - the D/C line is a plain CPU GPIO (esp_lcd toggles it in software),
 *     so a pin subscription classifies transactions: D/C low = command
 *     byte, D/C high = that command's data. The optional CS subscription
 *     (also a plain GPIO on this IDF, M5) gives exact transaction
 *     boundaries: flush the W window and walk the DMA chain on the CS
 *     rising edge; a D/C level change walks too (covers CS-less wiring).
 *
 * Resolution is configurable (320×240 default — the user's panel decides;
 * the model clamps to 1..480 like the ws2812 grid caps).
 */
import { Ili9341Model, rgb565ToRgba, clampDim } from './ili9341-lib.js';
import { SpiWindowEngine, readDmaPayload, readDmaChainAt } from './spi-lib.js';
import { makeCanvas } from './ws2812-lib.js';

/** Standing arm batch (instructions) — the W load→fire window survives
 * batch 60 (M5: 10/10); same arm as the MAX7219 buses. */
export const ARM_BATCH = 60;
/** Fine batch inside a CS-framed transaction (belt-and-braces for the W
 * window; the scheduler floor). */
export const FINE_BATCH = 20;
/** Fine lease budget (cycles) around a CS-low window. */
export const FINE_HOLD_CYCLES = 4000000;
/** Idle batches after the last new DMA segment before the open window is
 * flushed anyway (transaction ended without a D/C or CS notification). */
export const DMA_IDLE_FLUSH_BATCHES = 600;

const pinNum = (v, dflt) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : dflt;
};
const csFrom = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 ? n : -1;
};

export class Device {
    static typeId = 'ili9341';
    static version = '1.0.0';
    static title = 'ILI9341 SPI Display';
    static category = 'display';
    static description = '320×240-class colour TFT on the hardware SPI2 master (esp_lcd / ILI9341 command stream) — resolution adjustable.';
    static defaultConfig = {
        name: 'ILI9341', bus: 'hwspi', dcPin: 18, csPin: -1, width: 320, height: 240,
    };
    /* A register-level listener: overlaps anything legally, like the
     * logic analyzer probe. */
    static passive = true;
    static pins() {
        return [];
    }
    static configSchema = [
        { key: 'dcPin', label: 'D/C GPIO (command/data)', type: 'pin' },
        { key: 'csPin', label: 'CS GPIO (-1 = none)', type: 'number', min: -1, max: 48, step: 1 },
        { key: 'width', label: 'Width px', type: 'number', min: 1, max: 480, step: 1 },
        { key: 'height', label: 'Height px', type: 'number', min: 1, max: 480, step: 1 },
        { key: 'name', label: 'Label', type: 'text' },
    ];

    constructor(ctx, cfg) {
        this.ctx = ctx;
        this.cfg = cfg;
        this.dc = pinNum(cfg.dcPin, 18);
        this.cs = csFrom(cfg.csPin);
        this.model = new Ili9341Model(cfg.width, cfg.height);
        this.window = new SpiWindowEngine(ctx, (bytes) => this._onTransfer(bytes));
        this.dcLevel = null;          // last D/C pad level (true = data)
        this.dmaChannel = null;       // sticky GDMA channel (spi-lib)
        this.dmaHead = 0;             // cached first-descriptor address
        this.dmaFeeds = 0;
        this.dmaBuf = [];             // segments of the open DMA transaction
        this.frameBufs = [];          // per-segment buffer addresses (frame-buffer hunt)
        this.segAddrs = [];           // parallel to dmaBuf (ordered assembly)
        this.dmaSig = new Set();      // segment signatures already appended
        this.dmaClass = null;         // D/C classification of the open window
        this.dmaIdle = 0;             // batches without a new segment
        this.pushedPixels = -1;
        const pins = [this.dc];
        if (this.cs >= 0) pins.push(this.cs);
        ctx.subscribe(pins);
        ctx.armSampling(ARM_BATCH);
    }

    onEmuReady() {
        this.model.reset();
        this.window.reset();
        this.dcLevel = null;
        this.dmaFeeds = 0;
        this.dmaBuf = [];
        this.dmaSig = new Set();
        this.dmaClass = null;
        this.dmaIdle = 0;
        this.pushedPixels = -1;
        this.ctx.armSampling(ARM_BATCH);
        this.ctx.markDirty();
    }

    onPinState(pin, s) {
        const level = !!(s.out && s.oe);
        if (pin === this.dc) {
            // esp_lcd sets D/C in software around each transaction: a level
            // CHANGE is a transaction boundary — close the previous DMA
            // window (its bytes carry the OLD classification) and open the
            // next one classified by the new level.
            this._flushDmaWindow();
            this.dcLevel = level;
            this.dmaClass = level;
            this.ctx.fineSampling(FINE_BATCH, FINE_HOLD_CYCLES);
            return;
        }
        if (pin === this.cs) {
            if (!level) {
                // transaction started: fine batches so the W window and the
                // D/C classification land tightly around the transfer
                this.ctx.fineSampling(FINE_BATCH, FINE_HOLD_CYCLES);
            } else {
                this._flushDmaWindow();
                this.window.flush();
            }
        }
    }

    onBatch() {
        this.window.sample();
        // Poll the GDMA chain while a DMA window stands open, covering BOTH
        // halves of each segment's life (P6 trace): while the outlink is
        // armed (in flight) AND while it is cleared (the gap after a
        // segment completed, where the cached first-descriptor address
        // still names the chain that just ran — the hal rewrites the
        // descriptor only when arming the next segment). Signature-dedupe
        // stops re-reads; large transfers arrive as many short segments
        // (hal chunks >4 kB DMA) appended until a boundary flushes.
        if (this.dmaClass !== null) {
            const walked = readDmaPayload(this.ctx, this.dmaChannel)
                || (this.dmaHead && readDmaChainAt(this.ctx, this.dmaHead));
            if (walked) {
                if (walked.channel !== undefined) this.dmaChannel = walked.channel;
                this.dmaHead = walked.head;
                const sig = `${walked.bytes.length}:${Array.from(walked.bytes.subarray(0, 16)).join(',')}`;
                if (!this.dmaSig.has(sig)) {
                    this.dmaSig.add(sig);
                    this.dmaBuf.push(walked.bytes);
                    const segBuf = walked.bufs && walked.bufs[0];
                    if (segBuf !== undefined) {
                        this.frameBufs.push(segBuf);
                        this.segAddrs.push(segBuf);
                    }
                    this.dmaIdle = 0;
                    this.ctx.fineSampling(FINE_BATCH, FINE_HOLD_CYCLES);
                }
            } else if (this.dmaBuf.length > 0 && ++this.dmaIdle >= DMA_IDLE_FLUSH_BATCHES) {
                // segments stopped arriving (a gap BETWEEN hal chunks —
                // those gaps run hundreds of fine batches): feed what the
                // window holds but KEEP it open under the same
                // classification, so later segments of the same transaction
                // still land. A real boundary (D/C or CS change) closes it.
                if (!this.model.ramwr) this._flushDmaWindow(true);
            }
        }
    }

    getState() {
        const st = {
            dc: this.dc, cs: this.cs,
            transfers: this.window.transfers,
            dropped: this.window.dropped,
            dmaFeeds: this.dmaFeeds,
            ...this.model.snapshot(),
        };
        if (this.model.pixelsWritten !== this.pushedPixels) {
            // GRAM travels with the state only when it changed (150 KB for
            // 320×240 — the 33 ms flush throttle keeps this bounded)
            st.pixels = this.model.gram.slice();
            this.pushedPixels = this.model.pixelsWritten;
        }
        return st;
    }

    destroy() {
        this.ctx.releaseSampling();
        this.ctx.unsubscribe();
    }

    /* one W-window transaction (no-DMA drivers: Arduino-style command
     * traffic and small pixel writes) — D/C-classified */
    _onTransfer(bytes) {
        if (bytes.length === 0) return;
        const changed = this.dcLevel
            ? this.model.data(bytes)
            : this._commandBytes(bytes);
        if (changed) this.ctx.markDirty();
    }

    _commandBytes(bytes) {
        let changed = this.model.command(bytes[0]);
        if (bytes.length > 1) changed = this.model.data(bytes.subarray(1)) || changed;
        return changed;
    }

    /* Close (or drain) the standing DMA window: concatenate its segments
     * and feed them under the classification the window was opened with
     * (commands always execute — esp_lcd re-issues CASET/RASET/RAMWR every
     * frame with identical bytes; the per-segment signature set already
     * stopped re-reads of a reused descriptor). `keepOpen` drains between
     * hal chunks of one large transaction without closing the window. */
    _flushDmaWindow(keepOpen = false) {
        if (this.dmaClass === null) return;
        if (this.dmaBuf.length === 0 && !keepOpen) {
            /* Nothing caught in flight — 1-byte transactions (commands,
             * COLMOD) complete inside a single fine batch too often. The
             * outlink is already cleared by then (P6 trace), but the
             * cached first-descriptor address still names the chain that
             * just ran: one read recovers the transaction's bytes. Capped
             * at 64 B to keep the misalignment surface (a next transaction
             * already rewritten the descriptor) small; a stale sentinel
             * byte lands in the model as an unknown command — harmless. */
            const w = (this.dmaHead && readDmaChainAt(this.ctx, this.dmaHead))
                || readDmaPayload(this.ctx, this.dmaChannel);
            if (w && w.bytes.length > 0 && w.bytes.length <= 64) {
                if (w.channel !== undefined) this.dmaChannel = w.channel;
                this.dmaBuf.push(w.bytes);
            }
        }
        if (this.dmaBuf.length === 0) {
            if (!keepOpen) this.dmaClass = null;
            return;
        }
        /* Segment triage (P6 trace): the descriptor is read at several
         * moments inside a window, so early segments carry the PREVIOUS
         * transaction's residue (one-beat misalignment) and the hal's
         * 1-byte sentinel (0x42). The transaction's own bytes are the LAST
         * content the descriptor held — for command windows and short
         * parameter windows that is the final 1-byte segment. Large RAMWR
         * bursts bypass segments entirely via the frame-buffer read below. */
        const cls = this.dmaClass;
        let segs = this.dmaBuf.filter((b) => !(b.length === 1 && b[0] === 0x42));
        if (cls && this.model.ramwr) {
            // a pixel stream's real segments are whole chunks; any 1-byte
            // segment inside one is command residue/sentinel (P6 trace) and
            // would misalign the RGB565 stream — drop it
            segs = segs.filter((b) => b.length > 1);
        }
        if (!keepOpen && segs.length > 1) {
            const total = segs.reduce((n, b) => n + b.length, 0);
            const lastOne = [...segs].reverse().find((b) => b.length === 1);
            if (lastOne && (!cls || total <= 16)) segs = [lastOne];
        }
        this.dmaBuf = [];
        this.segAddrs = [];
        this.dmaIdle = 0;
        if (!keepOpen) {
            this.dmaClass = null;
            this.dmaSig.clear();
        }
        if (segs.length === 0) return;
        /* Assemble in FRAME order: chunked drivers push blocks in order,
         * but capture order follows batch boundaries — sort the caught
         * segments by their guest buffer address, then keep only the
         * largest CONTIGUOUS cluster: a window opened before the driver
         * re-arms its descriptors can still read the previous DMA chain
         * (P6 trace: P5's old outlink lingers), and those segments live
         * tens of kB away from the frame's own slices. */
        /* Stale-segment filter: the firmware filled its whole frame buffer
         * before/between transactions, so the CURRENT memory at a segment's
         * address must still match the segment's head. A segment caught
         * where the descriptor still held the PREVIOUS transaction (a block
         * load we missed) fails this check and is dropped — its bytes would
         * otherwise displace a real chunk inside the stream. */
        const pairs = segs
            .map((b, i) => ({ b, a: this.segAddrs[i] ?? 0 }))
            .filter(({ b, a }) => {
                if (b.length < 8 || !(a >>> 0)) return true;
                const now = this.ctx.readMem(a >>> 0, 8);
                for (let k = 0; k < 8; k++) if (now[k] !== b[k]) return false;
                return true;
            })
            .sort((x, y) => x.a - y.a);
        let best = [], run = [];
        for (const p of pairs) {
            if (run.length) {
                const expect = run[run.length - 1].a + run[run.length - 1].b.length;
                if (p.a < expect - 64 || p.a > expect + 64) {  // strict chunk continuity
                    if (run.length > best.length) best = run;
                    run = [];
                }
            }
            run.push(p);
        }
        if (run.length > best.length) best = run;
        const total = best.reduce((n, p) => n + p.b.length, 0);
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const p of best) { bytes.set(p.b, at); at += p.b.length; }
        this.dmaFeeds++;
        let changed;
        if (cls) {
            let feed = bytes;
            if (this.model.ramwr && !keepOpen && total < this._windowBytes()) {
                /* Pixel data incomplete from segments: chunked drivers
                 * (TFT_eSPI-style) land one segment per block transaction
                 * and the concatenation above already carries the whole
                 * window. A single-burst driver (esp_lcd) arms and clears
                 * descriptors faster than any batch can sample, but its
                 * descriptor pool is stable and each segment's buf names a
                 * frame-buffer slice — the LOWEST seen address is the frame
                 * start, and CASET/RASET told us exactly how many bytes to
                 * read (the RAMWR command reset the cursor to the window
                 * origin). */
                const want = this._windowBytes();
                const buf = this._findFrameBase(want) || (this.dmaHead ? this.ctx.readU32(this.dmaHead + 4) : 0);
                if (buf) {
                    const direct = new Uint8Array(want);
                    for (let off = 0; off < want; off += 4096) {
                        // read_memory caps at 4 KiB per call (EMU-API) — chunk it
                        const chunk = this.ctx.readMem((buf + off) >>> 0, Math.min(4096, want - off));
                        direct.set(chunk, off);
                        if (chunk.length < Math.min(4096, want - off)) break;
                    }
                    if (direct.length === want) {
                        feed = direct;
                        this.ctx.log(`RAMWR burst: ${want} B from frame buffer 0x${buf.toString(16)} (segments caught: ${total} B)`, 'info');
                    }
                }
            }
            changed = this.model.data(feed);
        } else {
            changed = this._commandBytes(bytes);
        }
        if (changed) this.ctx.markDirty();
    }

    /**
     * Locate the frame-buffer base from the caught pixel segments. Large
     * buffers land page-aligned often enough to try: walk down from the
     * lowest seen segment address one 4 KiB page at a time and accept the
     * first candidate where EVERY caught segment's content reappears at
     * exactly (segment address − candidate) inside the window read —
     * self-consistent proof, not a guess. Returns 0 when nothing fits.
     */
    _findFrameBase(want) {
        if (!this.segAddrs.length) return 0;
        const lo = Math.min(...this.segAddrs);
        const segs = this.dmaBuf.map((b, i) => ({ b, a: this.segAddrs[i] ?? 0 }))
            .filter((p) => p.b.length > 1);
        if (!segs.length) return 0;
        for (let page = 0; page <= 64; page++) {
            const base = (lo & ~0xfff) - page * 0x1000;
            if (base < 0x3fc00000) break;
            let ok = true;
            for (const { b, a } of segs) {
                const off = a - base;
                if (off < 0 || off + b.length > want) { ok = false; break; }
                // verify a slice of the segment against the candidate base
                const at = off + (b.length >> 1);
                const probe = this.ctx.readMem((base + at) >>> 0, 8);
                let m = true;
                for (let k = 0; k < 8; k++) {
                    if (probe[k] !== b[(b.length >> 1) + k]) { m = false; break; }
                }
                if (!m) { ok = false; break; }
            }
            if (ok) return base;
        }
        return 0;
    }

    /** Bytes one full RAMWR window carries at the current COLMOD. */
    _windowBytes() {
        const m = this.model;
        const px = (m.win.x1 - m.win.x0 + 1) * (m.win.y1 - m.win.y0 + 1);
        const bpp = (m.colmodSet ? m.colmod : 0x55) === 0x55 ? 2 : 3;
        return px * bpp;
    }
}

export class View {
    constructor(el, sendCmd) {
        this.el = el;
        this.send = sendCmd;
        this.cfg = { width: 320, height: 240 };
        this.state = null;
        el.className = 'dev-body mx-body';
        const wrap = document.createElement('div');
        wrap.className = 'mx-wrap';
        this.wrap = wrap;
        const cap = document.createElement('div');
        cap.className = 'mx-cap';
        this.cap = cap;
        el.appendChild(wrap);
        el.appendChild(cap);
        this.cv = null; this.g = null;
        this._rebuild(320, 240);
    }

    /* Compact row icon: a live miniature of the panel (same painter). */
    rowIcon(el) {
        el.title = 'ILI9341 display';
        const { cv, g } = makeCanvas(22, 22, 'mx-icon');
        this.iconCv = cv; this.iconG = g;
        el.appendChild(cv);
        this._apply(this.state);
    }

    _rebuild(w, h) {
        if (this.cv) this.cv.remove();
        const { cv, g } = makeCanvas(w, h, 'mx-canvas lcd-canvas');
        cv.style.maxWidth = '100%';
        cv.style.imageRendering = 'pixelated';
        this.cv = cv; this.g = g;
        this.wrap.appendChild(cv);
    }

    /* The ONE application of a display state — canvas + row icon. */
    _apply(state) {
        this.state = state;
        if (!state) return;
        if (state.width !== this.cfg.width || state.height !== this.cfg.height) {
            this.cfg.width = state.width;
            this.cfg.height = state.height;
            this._rebuild(state.width, state.height);
        }
        if (state.pixels && this.g) {
            const rgba = rgb565ToRgba(state.pixels, state.width, state.height);
            const img = new ImageData(rgba, state.width, state.height);
            this.g.putImageData(img, 0, 0);
            if (this.iconG) this._applyIcon();
        }
        this.cap.textContent = `D/C GPIO${state.dc}${state.cs >= 0 ? ` · CS GPIO${state.cs}` : ''}`
            + ` · ${state.width}×${state.height}`
            + ` · ${state.frames} frames · ${state.cmdCount} cmds · ${state.dmaFeeds} DMA feeds`
            + (state.sleep ? ' · sleep' : '')
            + (!state.displayOn ? ' · display off' : '');
    }

    _applyIcon() {
        const g = this.iconG;
        g.clearRect(0, 0, 22, 22);
        g.imageSmoothingEnabled = false;
        g.drawImage(this.cv, 0, 0, 22, 22);
    }

    render(state) {
        this._apply(state);
    }

    setConfig(cfg) {
        const w = clampDim(cfg.width, this.cfg.width);
        const h = clampDim(cfg.height, this.cfg.height);
        if (w !== this.cfg.width || h !== this.cfg.height) {
            this.cfg.width = w; this.cfg.height = h;
            this._rebuild(w, h);
            this._apply(this.state); // state still old-sized: blank until next push
        }
    }
}
