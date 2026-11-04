/*
 * Unit tests for the M6 bit-bang I2S audio layer (no emulator):
 *   - I2sCodecEngine against a synthetic soft master: Philips framing
 *     (WS toggles on the falling BCLK edge), combined vs separate
 *     WS+BCLK-fall batches, MSB-first slot decode, 16/24-bit sign
 *     extension, mono mode, lost-edge slot drop + WS resync, rate
 *     estimate from WS periods
 *   - microphone inject: queue → DIN bit stream, silence underruns,
 *     extra BCLK clocks holding the last bit, drop-oldest trimming
 *   - helpers: floatToI16 clamp/round, resample length, sineTable
 *   - the bitbang-i2s-audio plugin end-to-end through onPinState (the
 *     sigbus path): metadata/pins validation, DOUT decode into the
 *     drained getState chunks, onCommand('mic') interleaving + the DIN
 *     answer stream, mic queue cap, tone refill, destroy semantics
 * Run: node --test <files> (see package.json — explicit list for Git Bash)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDeviceModule } from '../../build/core/types.js';
import * as i2sa from '../../peris/devices/bitbang-i2s-audio.js';
import * as lib from '../../peris/devices/i2s-lib.js';

// ---------------------------------------------------------------------------
// soft I2S master simulator (engine level)
//
// Drives an I2sCodecEngine the way the P7 firmware does, one batch per
// pin-change group, in program order:
//   per bit:  DOUT settles while BCLK is low → BCLK rises (the master
//             samples DIN here) → BCLK falls (data-change edge; on slot
//             boundaries WS toggles together with the fall — Philips)
// `readDin` observes what the engine drives (the input-pad path).

function makeMaster(engine, readDin, opts = {}) {
    const m = {
        lv: { bclk: false, ws: false, dout: false },
        cycles: 0,
        step(over = {}, dc = 0) {
            Object.assign(m.lv, over);
            m.cycles += dc;
            engine.step(m.lv, m.cycles);
        },
        /** Stream one slot (MSB first); toggles WS at the closing fall. */
        slot(sample, bits = 16) {
            for (let i = bits - 1; i >= 0; i--) {
                m.step({ dout: !!((sample >> i) & 1) });   // data settles, BCLK low
                m.step({ bclk: true });                    // master samples DIN
                m.step({ bclk: false });                   // data-change edge
            }
            if (opts.separateWsStep) {
                m.step({ ws: !m.lv.ws });                  // own batch
            } else {
                m.step({ bclk: false, ws: !m.lv.ws });     // same batch as a fall
            }
        },
        frame(l, r, bits = 16) { m.slot(l, bits); m.slot(r, bits); },
        /** Master reads one DIN slot: sample after every rise, then close. */
        readSlot(bits = 16) {
            let v = 0;
            for (let i = 0; i < bits; i++) {
                m.step({ bclk: true });
                v = (v << 1) | (readDin() ? 1 : 0);
                m.step({ bclk: false });
            }
            m.step({ bclk: false, ws: !m.lv.ws });
            return v;
        },
    };
    return m;
}

function freshEngine(over = {}) {
    let din = 0;
    const e = new lib.I2sCodecEngine({ cyclesPerUs: 160, ...over },
        (bit) => { din = bit; }, () => {}, () => {});
    return { e, readDin: () => din };
}

// ---------------------------------------------------------------------------
// playback decode

test('engine: decodes a Philips stereo stream, combined WS+BCLK-fall batch', () => {
    const { e } = freshEngine();
    const m = makeMaster(e, () => 0);
    const frames = [[100, -200], [12345, -321], [0, 32767], [-32768, 1]];
    for (const [l, r] of frames) m.frame(l, r);
    assert.deepEqual(Array.from(e.drainOut()), [100, -200, 12345, -321, 0, 32767, -32768, 1]);
    assert.equal(e.frames, 4);
    assert.equal(e.drops, 0);
});

test('engine: separate WS batch (fall, then WS) decodes identically', () => {
    const { e } = freshEngine();
    const m = makeMaster(e, () => 0, { separateWsStep: true });
    m.frame(0x0123, 0x4567);
    assert.deepEqual(Array.from(e.drainOut()), [0x123, 0x4567]);
});

test('engine: 24-bit slots normalise MSB-aligned onto Int16', () => {
    const { e } = freshEngine({ bits: 24 });
    const m = makeMaster(e, () => 0);
    m.frame(1 << 23, 0x7fffff, 24);        // extremes of the 24-bit range
    m.frame(0x123456, 1, 24);              // 1 rounds to 0 (below Int16 LSB)
    assert.deepEqual(Array.from(e.drainOut()), [-32768, 32767, 0x1234, 0]);
});

test('engine: mono mode emits one sample per slot', () => {
    const { e } = freshEngine({ channels: 1 });
    const m = makeMaster(e, () => 0);
    for (const v of [11, -22, 33]) m.slot(v);
    assert.deepEqual(Array.from(e.drainOut()), [11, -22, 33]);
});

test('engine: a lost BCLK edge drops only its slot and resyncs on WS', () => {
    const { e } = freshEngine();
    const m = makeMaster(e, () => 0);
    m.frame(0x1111, 0x2222);
    // corrupt the next left slot: clock only 15 of 16 bits — the sigbus
    // loses edges that land inside one fine batch (AGENT.md §2)
    const s = 0x3333;
    for (let i = 15; i >= 1; i--) {
        m.step({ dout: !!((s >> i) & 1) });
        m.step({ bclk: true });
        m.step({ bclk: false });
    }
    m.step({ bclk: false, ws: !m.lv.ws });
    m.frame(0x4444, 0x5555);
    assert.equal(e.drops, 1, 'short slot dropped');
    // pairing follows the WS electrical phase: the orphaned right slot
    // pairs with a zero left, the next left waits for its right
    assert.deepEqual(Array.from(e.drainOut()), [0x1111, 0x2222, 0, 0x4444]);
});

test('engine: rate estimate from the median WS period (ratio-based, M4)', () => {
    const { e } = freshEngine();
    const m = makeMaster(e, () => 0);
    // 8 kHz stereo: one WS period = 160e6/8000 = 20000 cycles, jittered
    const wsPeriods = [20000, 20000, 19000, 21000, 20000, 20000, 20000, 20000, 20000];
    for (const p of wsPeriods) {
        m.frame(0, 0);
        m.cycles += p; // advance emulator time between WS edges
    }
    assert.equal(e.detectedRate(), 8000);
});

// ---------------------------------------------------------------------------
// microphone inject

test('engine: streams queued samples MSB-first on DIN; silence underruns', () => {
    const { e, readDin } = freshEngine();
    const m = makeMaster(e, readDin);
    e.pushMic([0x8001, 0x7ffe]);           // L,R of one stereo frame
    // a DIN slot only loads on a WS edge (stream boundary) — before one,
    // the line idles at silence
    assert.equal(m.readSlot(16), 0, 'no WS edge yet → no slot loaded');
    assert.equal(m.readSlot(16), 0x8001);
    assert.equal(m.readSlot(16), 0x7ffe);
    // readSlot's own closing WS edge already tried the next (empty) load
    assert.equal(e.underruns, 1);
    assert.equal(m.readSlot(16), 0, 'empty queue → silence');
    assert.equal(e.underruns, 2);
});

test('engine: extra BCLK clocks hold the last DIN bit of the slot', () => {
    const { e, readDin } = freshEngine();
    const m = makeMaster(e, readDin);
    e.pushMic([0xffff]);
    m.step({ bclk: false, ws: !m.lv.ws });  // slot boundary loads the MSB
    // clock the slot but keep it OPEN (no closing WS edge yet)
    let v = 0;
    for (let i = 0; i < 16; i++) {
        m.step({ bclk: true });
        v = (v << 1) | (readDin() ? 1 : 0);
        m.step({ bclk: false });
    }
    assert.equal(v, 0xffff);
    // two extra rise/fall pairs inside the same slot: bitIndex clamps,
    // the line keeps holding the final (high) bit — a master that clocks
    // a wider slot reads 1s, not garbage
    let held;
    m.step({ bclk: true }); held = readDin();
    m.step({ bclk: false });
    m.step({ bclk: true }); held = held && readDin();
    m.step({ bclk: false });
    assert.equal(held, 1, 'last bit held through extra clocks');
});

test('engine: trimQueue drops oldest', () => {
    const { e } = freshEngine();
    for (let i = 0; i < 20; i++) e.pushMic([i]);
    e.trimQueue(5);
    assert.deepEqual(e.queue, [15, 16, 17, 18, 19]);
});

// ---------------------------------------------------------------------------
// helpers

test('floatToI16: clamps and rounds asymmetrically', () => {
    const pcm = lib.floatToI16([0, 0.5, -0.5, 1, -1, 2, -2]);
    assert.deepEqual(Array.from(pcm), [0, 16384, -16384, 32767, -32768, 32767, -32768]);
});

test('resample: length scales with the rate ratio, values interpolate', () => {
    const down = lib.resample(new Float32Array([0, 1, 2, 3]), 48000, 8000);
    assert.equal(down.length, 0); // floor(4·8000/48000)
    const up = lib.resample(new Float32Array([0, 4]), 8000, 16000);
    assert.deepEqual(Array.from(up), [0, 2, 4, 4]); // edge holds at the tail
});

test('sineTable: matches round(amp·sin(2πk/n))', () => {
    assert.deepEqual(lib.sineTable(8, 100), [0, 71, 100, 71, 0, -71, -100, -71]);
});

// ---------------------------------------------------------------------------
// plugin (sigbus path)

function makeDevCtx() {
    const inputs = [];
    const leases = { armed: [], fine: [], released: 0 };
    const logs = [];
    let dirty = 0;
    let cycles = 0;
    const ctx = {
        id: 't', chip: 'esp32c3', gpioCount: 22, mmio: null,
        cyclesPerUs: 160,
        setCycles: (c) => { cycles = c; },
        setPinInput: (pin, high) => inputs.push([pin, high]),
        armSampling: (batch) => leases.armed.push(batch),
        fineSampling: (batch, forCycles) => leases.fine.push([batch, forCycles]),
        releaseSampling: () => leases.released++,
        readMem: () => new Uint8Array(0),
        readU32: () => 0,
        cycles: () => cycles,
        pinLevel: () => null,
        subscribe: () => {}, unsubscribe: () => {},
        markDirty: () => { dirty++; },
        log: (text, level) => logs.push([text, level]),
    };
    return { ctx, inputs, leases, logs, dirty: () => dirty };
}

const P = { bclk: 4, ws: 5, dout: 6, din: 7 };

/** Soft master driving the plugin through onPinState (the sigbus path). */
function pluginMaster(dev, dc = 0) {
    const lv = { bclk: false, ws: false, dout: false };
    let cycles = 0;
    const feed = (over) => {
        Object.assign(lv, over);
        cycles += dc;
        for (const k of Object.keys(over)) {
            dev.onPinState(P[k], { out: lv[k], oe: true, cycles });
        }
    };
    return {
        lv,
        slot(sample, bits = 16) {
            for (let i = bits - 1; i >= 0; i--) {
                feed({ dout: !!((sample >> i) & 1) });
                feed({ bclk: true });
                feed({ bclk: false });
            }
            feed({ bclk: false, ws: !lv.ws });
        },
        frame(l, r, bits = 16) { this.slot(l, bits); this.slot(r, bits); },
        wsEdge() { feed({ bclk: false, ws: !lv.ws }); },
        /** Read slot: sample DIN after each rise (gpio_get_level view). */
        readSlot(din, bits = 16) {
            let v = 0;
            for (let i = 0; i < bits; i++) {
                feed({ bclk: true });
                v = (v << 1) | (din() ? 1 : 0);
                feed({ bclk: false });
            }
            feed({ bclk: false, ws: !lv.ws });
            return v;
        },
    };
}

test('plugin: metadata, pins and registry validation', () => {
    assert.equal(validateDeviceModule(i2sa), null);
    assert.deepEqual(i2sa.Device.pins({ bclk: 4, ws: 5, dout: 6, din: 7 }), [4, 5, 6, 7]);
    // the generic editor hands select values back as strings
    assert.deepEqual(i2sa.Device.pins({ bclk: '4', ws: '5', dout: '6', din: '7' }), [4, 5, 6, 7]);
    assert.equal(i2sa.Device.sharedBus, true);
    assert.equal(i2sa.Device.passive, undefined, 'drives DIN — not a passive probe');
});

test('plugin: decodes DOUT into drained getState chunks (TX path)', () => {
    const { ctx, leases } = makeDevCtx();
    const dev = new i2sa.Device(ctx, { id: 'x', type: 'bitbang-i2s-audio' });
    assert.deepEqual(leases.armed, [i2sa.ARM_BATCH], 'standing watch armed');
    const m = pluginMaster(dev);
    m.frame(0x0100, 0xff00);
    m.frame(0x0010, 0x0002);
    const st = dev.getState();
    assert.ok(st.pcm instanceof Int16Array);
    assert.deepEqual(Array.from(st.pcm), [0x100, 0xff00 - 0x10000, 0x10, 2]);
    assert.equal(st.frames, 2);
    assert.equal(st.drops, 0);
    assert.equal(dev.getState().pcm, null, 'chunks drain exactly once per flush');
    assert.ok(leases.fine.length > 0, 'fine sampling requested on edges');
    dev.destroy();
    assert.equal(leases.released, 1);
});

test('plugin: onCommand mic → DIN answer, stereo duplicates mono (RX path)', () => {
    const { ctx, inputs } = makeDevCtx();
    const dev = new i2sa.Device(ctx, { id: 'x', type: 'bitbang-i2s-audio' });
    // read the pad level the way the firmware's gpio_get_level does
    let din = 0;
    const orig = ctx.setPinInput;
    ctx.setPinInput = (pin, high) => { if (pin === P.din) din = high ? 1 : 0; orig(pin, high); };
    dev.onCommand('mic', { pcm: new Int16Array([0x8001]) });

    const m = pluginMaster(dev);
    m.wsEdge(); // slot load: first queued sample, MSB driven
    assert.equal(m.readSlot(() => din, 16), 0x8001, 'left slot = the mic sample');
    assert.equal(m.readSlot(() => din, 16), 0x8001, 'right slot = same sample (interleaved)');
    dev.destroy();

    // distinct samples in mono mode flow through one slot each
    const dev2 = new i2sa.Device(ctx, { id: 'y', type: 'bitbang-i2s-audio', channels: 1 });
    ctx.setPinInput = (pin, high) => { if (pin === P.din) din = high ? 1 : 0; };
    dev2.onCommand('mic', { pcm: new Int16Array([0x8001, -2]) }); // -2 → 0xfffe
    const m2 = pluginMaster(dev2);
    m2.wsEdge();
    assert.equal(m2.readSlot(() => din, 16), 0x8001);
    assert.equal(m2.readSlot(() => din, 16), 0xfffe);
    // the last readSlot's closing edge already hit the empty queue
    assert.equal(dev2.getState().underruns, 1);
    assert.ok(inputs.some(([pin, high]) => pin === P.din && high === true), 'DIN driven');
    dev2.destroy();
});

test('plugin: mic queue is capped (drop-oldest)', () => {
    const { ctx } = makeDevCtx();
    const dev = new i2sa.Device(ctx, { id: 'x', type: 'bitbang-i2s-audio', channels: 1 });
    const big = new Int16Array(i2sa.MIC_QUEUE_MAX + 64).fill(1000);
    dev.onCommand('mic', { pcm: big });
    assert.equal(dev.engine.queue.length, i2sa.MIC_QUEUE_MAX, 'queue bounded');
    const st = dev.getState();
    assert.ok(st.micDropped > 0, 'drops counted');
});

test('plugin: tone refills the queue under its watermark', () => {
    const { ctx } = makeDevCtx();
    const dev = new i2sa.Device(ctx, { id: 'x', type: 'bitbang-i2s-audio', channels: 1 });
    dev.onCommand('tone', { on: true });
    dev.onBatch();
    const depth = dev.engine.queue.length;
    assert.ok(depth > 0, 'tone refilled the queue');
    assert.ok(depth <= i2sa.MIC_QUEUE_MAX / 2 + i2sa.TONE_CHUNK, 'watermark respected');
    assert.equal(dev.getState().tone, true);
    dev.onCommand('tone', { on: false });
    assert.equal(dev.getState().tone, false);
});
