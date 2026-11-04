/*
 * Unit tests for the M5 hardware-SPI layer (no emulator):
 *   - spi-lib: signal map + wiring discovery on fake MMIO, the W-window
 *     engine (load/wipe/dedup/timeout), the GDMA chain walk (outlink low-20
 *     rebuild, multi-descriptor concat, cached-head reads)
 *   - ili9341-lib: CASET/RASET window forms and clamping, RAMWR pixel
 *     stream (RGB565/RGB666, cross-transaction carry, cursor wrap, frame
 *     counting), COLMOD fallback, SWRESET keeping GRAM
 *   - max7219 plugin hwspi mode: pad-free pin contract, P6 register-write
 *     sequence decoded through the W window into the register model
 * Run: node --test <files> (see package.json — explicit list for Git Bash)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esp32c3 as C3_MMIO } from '../../build/core/mmio/c3.js';
import { esp32s3 as S3_MMIO } from '../../build/core/mmio/s3.js';
import { mmioFor } from '../../build/core/mmio.js';
import { rmtTxBusy } from '../../peris/devices/ws2812-lib.js';
import * as spiLib from '../../peris/devices/spi-lib.js';
import * as lcdLib from '../../peris/devices/ili9341-lib.js';
import * as mx from '../../peris/devices/max7219.js';

// ---------------------------------------------------------------- helpers ---
/** Fake device ctx over a Map<addr,u32> (same shape as devices.test.mjs). */
function makeSpiCtx() {
    const regs = new Map();
    const subs = { armed: [], pins: [] };
    return {
        regs, subs,
        ctx: {
            id: 't', chip: 'esp32c3', gpioCount: 22, mmio: C3_MMIO,
            setPinInput: () => {},
            readMem: (addr, len) => {
                const b = new Uint8Array(len);
                for (let i = 0; i < len; i += 4) {
                    const v = regs.get((addr + i) >>> 0) ?? 0;
                    b[i] = v & 0xff; b[i + 1] = (v >>> 8) & 0xff;
                    b[i + 2] = (v >>> 16) & 0xff; b[i + 3] = (v >>> 24) & 0xff;
                }
                return b;
            },
            readU32: (addr) => regs.get(addr >>> 0) ?? 0,
            armSampling: (n) => { subs.armed.push(n); },
            fineSampling: () => {}, releaseSampling: () => {},
            cycles: () => 0, cyclesPerUs: 160,
            pinLevel: () => null,
            subscribe: (pins) => { subs.pins = pins; },
            unsubscribe: () => {},
            markDirty: () => {}, log: () => {},
        },
    };
}

/** Load W words + MS_DLEN into the fake register map (one no-DMA TX). */
function loadWindow(regs, bytes) {
    const words = Math.ceil(bytes.length / 4);
    for (let w = 0; w < words; w++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v |= ((bytes[w * 4 + k] ?? 0) & 0xff) << (8 * k);
        regs.set(C3_MMIO.spi.wBase + 4 * w, v >>> 0);
    }
    regs.set(C3_MMIO.spi.msDlen, (bytes.length * 8 - 1) & 0x3ffff);
}
const wipeWindow = (regs) => regs.set(C3_MMIO.spi.wBase, spiLib.SPI_WIPE);

/** Build one lldesc {w0,len,buf,next} in the fake map; returns its address. */
function putDesc(regs, addr, { len, buf, next = 0, eof = true }) {
    const w0 = ((len & 0xfff) << 12) | (eof ? 1 << 30 : 0) | (1 << 31);
    regs.set(addr, w0 >>> 0);
    regs.set(addr + 4, buf >>> 0);
    regs.set(addr + 8, next >>> 0);
    return addr;
}
/** Write a payload buffer into the fake map (u32 granularity). */
function putBuf(regs, addr, bytes) {
    for (let i = 0; i < bytes.length; i += 4) {
        let v = 0;
        for (let k = 0; k < 4; k++) v |= ((bytes[i + k] ?? 0) & 0xff) << (8 * k);
        regs.set(addr + i, v >>> 0);
    }
}

// ---------------------------------------------------------------- spi-lib ---

test('spi-lib: signal map covers the C3 FSPI roles', () => {
    const m = spiLib.spiSignalMap(C3_MMIO);
    assert.equal(m.get(63), 'sclk');
    assert.equal(m.get(65), 'mosi');
    assert.equal(m.get(64), 'miso');
    assert.equal(m.get(68), 'cs0');
    assert.equal(m.get(73), 'cs5');
    assert.equal(spiLib.spiSignalMap(null).size, 0, 'no table → empty map');
});

test('spi-lib: wiring discovery scans FUNC_OUT_SEL (0x80 = plain GPIO)', () => {
    const { regs, ctx } = makeSpiCtx();
    const F = (pin) => C3_MMIO.gpio.funcOutSelBase + 4 * pin;
    regs.set(F(11), 63);        // FSPICLK
    regs.set(F(12), 65);        // FSPID (MOSI)
    regs.set(F(13), 64);        // FSPIQ_OUT routed (oe off) — MISO pad
    regs.set(F(14), 68);        // FSPICS0
    regs.set(F(9), 0x2d);       // LEDC ch0 — not SPI
    regs.set(F(10), 0x80);      // plain GPIO — not SPI
    const w = spiLib.discoverSpiWiring(ctx);
    assert.deepEqual(w, { sclk: 11, mosi: 12, miso: 13, cs: [14] });
});

test('spi-lib: S3 table registered; wiring scan handles the 9-bit field', () => {
    assert.equal(mmioFor('esp32s3'), S3_MMIO);
    assert.equal(mmioFor('esp32c3'), C3_MMIO);
    const { regs, ctx } = makeSpiCtx();
    ctx.mmio = S3_MMIO;
    ctx.chip = 'esp32s3';
    ctx.gpioCount = 49;
    const F = (pin) => S3_MMIO.gpio.funcOutSelBase + 4 * pin;
    regs.set(F(13), 101);       // FSPICLK
    regs.set(F(21), 103);       // FSPID (MOSI) — duel_of_8 wiring
    regs.set(F(14), 110);       // FSPICS0
    regs.set(F(8), 0x100);      // S3 plain GPIO (9-bit field) — not SPI
    regs.set(F(9), 73);         // S3 LEDC ch0 — not SPI
    const w = spiLib.discoverSpiWiring(ctx);
    assert.deepEqual(w, { sclk: 13, mosi: 21, miso: null, cs: [14] });
});

test('mmio: RMT TX-busy uses the per-chip state shift', () => {
    const mk = (mmio, status) => ({
        readU32: () => status,
        mmio,
    });
    assert.equal(rmtTxBusy(mk(C3_MMIO, 1 << 9), 0), true, 'C3 state lives at bits[11:9]');
    assert.equal(rmtTxBusy(mk(C3_MMIO, 0), 0), false);
    assert.equal(rmtTxBusy(mk(S3_MMIO, 1 << 22), 0), true, 'S3 state lives at bits[24:22]');
    assert.equal(rmtTxBusy(mk(S3_MMIO, 1 << 9), 0), false, 'the C3 position is other bits on S3');
});

test('spi-lib: wordsToBytes unpacks byte i at bits [8i+7:8i]', () => {
    const bytes = spiLib.wordsToBytes([0x5a00ffa0 >>> 0, 0xaa553cc3 >>> 0], 8);
    assert.deepEqual(Array.from(bytes), [0xa0, 0xff, 0x00, 0x5a, 0xc3, 0x3c, 0x55, 0xaa]);
    assert.equal(spiLib.wordsToBytes([0x12345678], 2)[0], 0x78);
});

test('spi-lib: window engine — load then wipe emits one transfer', () => {
    const { regs, ctx } = makeSpiCtx();
    const got = [];
    const eng = new spiLib.SpiWindowEngine(ctx, (b, bits) => got.push({ b: Array.from(b), bits }));
    eng.sample();                       // baseline (power-on W0=0)
    loadWindow(regs, [0xa0, 0xff, 0x00, 0x5a]);
    eng.sample();                       // load observed
    assert.equal(got.length, 0);
    assert.equal(eng.busy, true);
    wipeWindow(regs);
    eng.sample();                       // completion wipe
    assert.deepEqual(got, [{ b: [0xa0, 0xff, 0x00, 0x5a], bits: 32 }]);
    assert.equal(eng.transfers, 1);
    assert.equal(eng.dropped, 0);
});

test('spi-lib: window engine — a swallowed wipe flushes and counts dropped', () => {
    const { regs, ctx } = makeSpiCtx();
    const got = [];
    const eng = new spiLib.SpiWindowEngine(ctx, (b) => got.push(Array.from(b)));
    eng.sample();
    loadWindow(regs, [1, 2]);
    eng.sample();
    loadWindow(regs, [3, 4]);           // next load with no wipe between
    eng.sample();
    wipeWindow(regs);
    eng.sample();
    assert.deepEqual(got, [[1, 2], [3, 4]]);
    assert.equal(eng.transfers, 2);
    assert.equal(eng.dropped, 1);
});

test('spi-lib: window engine — pending ages out after teardown', () => {
    const { regs, ctx } = makeSpiCtx();
    const got = [];
    const eng = new spiLib.SpiWindowEngine(ctx, (b) => got.push(Array.from(b)));
    eng.sample();
    loadWindow(regs, [0x0f, 0x00]);     // final frame, bus freed, no wipe
    eng.sample();
    for (let i = 0; i < spiLib.PENDING_TIMEOUT_BATCHES + 1; i++) eng.sample();
    assert.deepEqual(got, [[0x0f, 0x00]], 'the loaded transfer must still flush');
});

test('spi-lib: GDMA walk — outlink names the chain via low-20 rebuild', () => {
    const { regs, ctx } = makeSpiCtx();
    putBuf(regs, 0x3fc88000, [1, 2, 3, 4, 5, 6, 7, 8]);
    putDesc(regs, 0x3fc90000, { len: 8, buf: 0x3fc88000 });
    regs.set(C3_MMIO.spi.gdma.outLink[0], 0x90000);       // low 20 bits
    const w = spiLib.readDmaPayload(ctx, null);
    assert.deepEqual(Array.from(w.bytes), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(w.channel, 0);
    assert.equal(w.head, 0x3fc90000);
});

test('spi-lib: GDMA walk — multi-descriptor chain concatenates in order', () => {
    const { regs, ctx } = makeSpiCtx();
    putBuf(regs, 0x3fc88000, [1, 1, 1, 1]);
    putBuf(regs, 0x3fc88100, [2, 2, 2, 2]);
    putDesc(regs, 0x3fc90000, { len: 4, buf: 0x3fc88000, next: 0x3fc90010, eof: false });
    putDesc(regs, 0x3fc90010, { len: 4, buf: 0x3fc88100, eof: true });
    regs.set(C3_MMIO.spi.gdma.outLink[1], 0x90000);
    const w = spiLib.readDmaPayload(ctx, 0);          // sticky ch0 empty → ch1
    assert.deepEqual(Array.from(w.bytes), [1, 1, 1, 1, 2, 2, 2, 2]);
    assert.equal(w.channel, 1);
});

test('spi-lib: readDmaChainAt walks a cached head; rejects non-DRAM', () => {
    const { regs, ctx } = makeSpiCtx();
    putBuf(regs, 0x3fc88040, [9, 9]);
    putDesc(regs, 0x3fc90040, { len: 2, buf: 0x3fc88040 });
    const w = spiLib.readDmaChainAt(ctx, 0x3fc90040);
    assert.deepEqual(Array.from(w.bytes), [9, 9]);
    assert.equal(w.head, 0x3fc90040);
    assert.equal(spiLib.readDmaChainAt(ctx, 0x60024000), null, 'MMIO is not DRAM');
    assert.equal(spiLib.readDmaPayload(ctx, null), null, 'no outlink armed');
});

// ------------------------------------------------------------ ili9341-lib ---

test('ili9341: CASET/RASET accept 4-byte big-endian and 2-byte forms', () => {
    const m = new lcdLib.Ili9341Model(320, 240);
    m.command(0x2A);
    m.data(new Uint8Array([0, 10, 0x01, 0x2C]));           // x0=10 x1=300
    assert.equal(m.win.x0, 10);
    assert.equal(m.win.x1, 300);
    m.command(0x2B);
    m.data(new Uint8Array([0x00, 0x05]));                  // y0 = y1 = 5
    assert.equal(m.win.y0, 5);
    assert.equal(m.win.y1, 5);
    m.command(0x2A);
    m.data(new Uint8Array([0, 0, 0xFF, 0xFF]));            // clamps to width-1
    assert.equal(m.win.x1, 319);
});

test('ili9341: RAMWR RGB565 stream fills the window and wraps (frame counted)', () => {
    const m = new lcdLib.Ili9341Model(320, 240);
    m.command(0x3A); m.data(new Uint8Array([0x55]));
    m.command(0x2A); m.data(new Uint8Array([0, 0, 0, 2])); // x 0..2
    m.command(0x2B); m.data(new Uint8Array([0, 0, 0, 1])); // y 0..1
    m.command(0x2C);
    const px = (v) => new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
    m.data(px(0xf800)); m.data(px(0x07e0)); m.data(px(0x001f));
    m.data(px(0xffff)); m.data(px(0x0000)); m.data(px(0xa5a5));
    assert.equal(m.gram[0], 0xf800);      // (0,0)
    assert.equal(m.gram[1], 0x07e0);      // (1,0)
    assert.equal(m.gram[2], 0x001f);      // (2,0) — last column of row 0
    assert.equal(m.gram[320], 0xffff);    // (0,1) — wrapped to next row
    assert.equal(m.gram[322], 0xa5a5);
    assert.equal(m.frames, 1);            // last window pixel filled → frame
    assert.equal(m.pixelsWritten, 6);
    assert.equal(m.cursor.x, 0);          // wrapped back to the window origin
    assert.equal(m.cursor.y, 0);
});

test('ili9341: a pixel split across two data transactions carries over', () => {
    const m = new lcdLib.Ili9341Model(8, 8);
    m.command(0x3A); m.data(new Uint8Array([0x55]));
    m.command(0x2C);
    m.data(new Uint8Array([0xf8]));       // high byte only
    m.data(new Uint8Array([0x00]));       // low byte completes the pixel
    assert.equal(m.gram[0], 0xf800);
});

test('ili9341: RGB666 (COLMOD 0x66) packs three bytes per pixel', () => {
    const m = new lcdLib.Ili9341Model(8, 8);
    m.command(0x3A); m.data(new Uint8Array([0x66]));
    m.command(0x2C);
    m.data(new Uint8Array([0xff, 0x00, 0x00]));
    assert.equal(m.gram[0], 0xf800, 'red byte → RRRRRGGG GGGBBBBB high bits');
});

test('ili9341: missing COLMOD decodes the RAMWR stream as RGB565 (esp_lcd convention)', () => {
    const m = new lcdLib.Ili9341Model(8, 8);
    m.command(0x2C);                      // no COLMOD ever arrived
    m.data(new Uint8Array([0xf8, 0x00]));
    assert.equal(m.gram[0], 0xf800);
    assert.equal(m.colmod, 0x66);         // POR value untouched, decode fell back
});

test('ili9341: SWRESET restores the interface state but keeps GRAM', () => {
    const m = new lcdLib.Ili9341Model(8, 8);
    m.command(0x3A); m.data(new Uint8Array([0x55]));
    m.command(0x2A); m.data(new Uint8Array([0, 2, 0, 4]));
    m.command(0x2C); m.data(new Uint8Array([0xf8, 0x00]));
    m.command(0x01);                      // SWRESET
    assert.equal(m.gram[2], 0xf800, 'GRAM survives (window x0=2 → pixel lands at (2,0))');
    assert.deepEqual(m.win, { x0: 0, x1: 7, y0: 0, y1: 7 }, 'window restored');
    assert.equal(m.sleep, true);
});

test('ili9341: rgb565ToRgba expands with bit replication', () => {
    const rgba = lcdLib.rgb565ToRgba(new Uint16Array([0xf800, 0x0000]), 2, 1);
    assert.deepEqual(Array.from(rgba.subarray(0, 4)), [0xff, 0, 0, 0xff]);
    assert.deepEqual(Array.from(rgba.subarray(4, 8)), [0, 0, 0, 0xff]);
});

// ----------------------------------------------------------- max7219 hwspi ---

test('max7219: hwspi bus claims no pads and arms the W window', () => {
    const { ctx, subs } = makeSpiCtx();
    const dev = new mx.Device(ctx, { id: 't', type: 'max7219', bus: 'hwspi' });
    assert.deepEqual(mx.Device.pins({ bus: 'hwspi' }), []);
    assert.deepEqual(mx.Device.pins({}), [21, 13, 14], 'default stays bit-bang');
    assert.equal(subs.armed.length, 1);
    assert.ok(subs.armed[0] <= 60, 'arm batch at most 60 (M5 window)');
    assert.deepEqual(subs.pins, [], 'no pin subscription in hwspi mode');
});

test('max7219: hwspi replays the P6 register-write sequence into the model', () => {
    const { regs, ctx } = makeSpiCtx();
    const dev = new mx.Device(ctx, { id: 't', type: 'max7219', bus: 'hwspi' });
    // the P6 firmware's writes (register, data) — one 2-byte transfer each
    const writes = [
        [0x0c, 0x01], [0x09, 0xff], [0x0b, 0x07], [0x0a, 0x05],
        ...[0, 1, 2, 3, 4, 5, 6, 7].map((d) => [0x01 + d, d]),
        [0x0f, 0x01], [0x0f, 0x00],
    ];
    for (const [r, d] of writes) {
        loadWindow(regs, [r, d]);
        dev.onBatch();
        wipeWindow(regs);
        dev.onBatch();
    }
    const st = dev.getState();
    assert.equal(st.bus, 'hwspi');
    assert.deepEqual(st.digits, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(st.decodeMode, 0xff);
    assert.equal(st.intensity, 5);
    assert.equal(st.scanLimit, 7);
    assert.equal(st.shutdown, false);
    assert.equal(st.test, false, 'the trailing test-off frame must land');
    assert.ok(st.transfers >= writes.length - 1, 'every write decoded (the trailing one may flush on timeout)');
    assert.equal(st.dropped, 0);
    dev.destroy();
});

test('max7219: hwspi DMA feeds — dedupe identical, decode new content (S3)', () => {
    // duel_of_8-style firmware: spi_bus_initialize(SPI_DMA_CH_AUTO) → the
    // payload rides the GDMA chain, W0 never moves
    const { regs, ctx } = makeSpiCtx();
    ctx.mmio = S3_MMIO;
    ctx.chip = 'esp32s3';
    const dev = new mx.Device(ctx, { id: 't', type: 'max7219', bus: 'hwspi' });
    const arm = (bytes) => {
        putBuf(regs, 0x3fc88000, bytes);
        putDesc(regs, 0x3fc90000, { len: bytes.length, buf: 0x3fc88000 });
        regs.set(S3_MMIO.spi.gdma.outLink[0], 0x90000);
        dev.onBatch(); dev.onBatch();   // two polls: the torn-read gate
    };
    arm([0x0b, 0x07]);          // scan limit 7
    arm([0x09, 0xff]);          // decode mode
    arm([0x09, 0xff]);          // periodic heal: identical frame → deduped
    arm([0x0c, 0x01]);          // shutdown off
    arm([0x01, 0x7f]);          // digit 0 = 0x7f
    arm([0x01, 0x06]);          // digit 0 = 6 (changed)
    arm([0x01, 0x7f]);          // back to the EARLIER glyph — must feed again
    const st = dev.getState();
    assert.equal(st.scanLimit, 7);
    assert.equal(st.decodeMode, 0xff);
    assert.equal(st.shutdown, false);
    assert.equal(st.digits[0], 0x7f, 'returning to earlier content re-latches');
    assert.equal(st.dmaFeeds, 6, 'only the identical repeat deduped');
    assert.equal(st.transfers, 0, 'no-DMA W window stays idle');
    assert.equal(st.dropped, 0);
    assert.equal(dev.dmaChannel, 0, 'the GDMA channel went sticky');
    dev.destroy();
});

test('max7219: torn DMA buffer reads never feed (two-poll confirmation)', () => {
    // During a heal burst the CPU rewrites the 2-byte DMA buffer per
    // transaction; a poll between the two stores reads a torn frame —
    // measured on duel_of_8 as intensity=7 / scan-limit=0 ghosts. A torn
    // state survives one poll at most; real transactions span hundreds of
    // batches, so requiring a second consecutive identical signature keeps
    // every real frame and drops every torn one.
    const { regs, ctx } = makeSpiCtx();
    ctx.mmio = S3_MMIO;
    ctx.chip = 'esp32s3';
    const dev = new mx.Device(ctx, { id: 't', type: 'max7219', bus: 'hwspi' });
    const arm = (bytes) => {
        putBuf(regs, 0x3fc88000, bytes);
        putDesc(regs, 0x3fc90000, { len: bytes.length, buf: 0x3fc88000 });
        regs.set(S3_MMIO.spi.gdma.outLink[0], 0x90000);
        dev.onBatch();
    };
    arm([0x0b, 0x07]);          // first sighting…
    let st = dev.getState();
    assert.equal(st.scanLimit, 0, 'a single poll must not feed yet');
    arm([0x0b, 0x07]);          // …second poll confirms
    st = dev.getState();
    assert.equal(st.scanLimit, 7);
    // torn flapping between the real frame and ghosts never confirms
    for (let i = 0; i < 8; i++) {
        arm([0x0b, 0x07]);
        arm([0x0b, 0x00]);      // torn [reg, foreign byte] ghost
        arm([0x0b, 0x04]);
        arm([0x0b, 0x00]);
    }
    st = dev.getState();
    assert.equal(st.scanLimit, 7, 'ghosts never latched');
    assert.equal(st.dropped, 0);
    // a sustained real change still lands after two polls
    arm([0x0a, 0x05]); arm([0x0a, 0x05]);
    st = dev.getState();
    assert.equal(st.intensity, 5);
    dev.destroy();
});
