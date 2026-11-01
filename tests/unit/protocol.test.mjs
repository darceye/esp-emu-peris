/*
 * Unit tests for the M4 protocol layer (no emulator):
 *   - FineScheduler lease policy (arm/fine/expiry/CPU-sleep escape)
 *   - I2C slave engine against a synthetic soft master (ACK path, write
 *     pointer, sequential read, address mismatch, repeated START, STOP)
 *   - 24C02 / BME280 register models incl. the factory calibration block
 *   - Bosch compensation (T hand-derived; P/H pinned constants)
 *   - NEC: envelope assembly, frame decode, RMT symbol-RAM path
 *   - device plugins: bitbang-i2c-slave end-to-end via the master sim,
 *     ir-nec gpio capture + rmt RAM decode against fake MMIO
 *   - MAX7219: Code B font, register model (datasheet tables 2-8), wire
 *     shift engine (MSB-first, LOAD latch, misaligned frames), daisy-chain
 *     word picking, the max7219 plugin end-to-end through the sigbus path
 * Run: node --test <files> (see package.json — explicit list for Git Bash)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FineScheduler, SLEEP_FACTOR, clampBatch } from '../../build/core/scheduler.js';
import { validateDeviceModule } from '../../build/core/types.js';
import { esp32c3 as C3_MMIO } from '../../build/core/mmio/c3.js';
import * as i2c from '../../peris/devices/bitbang-i2c-slave.js';
import * as ir from '../../peris/devices/ir-nec.js';
import * as mx from '../../peris/devices/max7219.js';
import * as i2cLib from '../../peris/devices/i2c-lib.js';
import * as necLib from '../../peris/devices/nec-lib.js';
import * as mxLib from '../../peris/devices/max7219-lib.js';
import * as ledMod from '../../peris/devices/led.js';

// ---------------------------------------------------------------------------
// FineScheduler

test('scheduler: no leases → coarse passthrough', () => {
    const s = new FineScheduler();
    assert.equal(s.nextSize(50000, 0), 50000);
    assert.equal(s.nextSize(50000, 123456), 50000);
});

test('scheduler: armed lease holds a standing batch size', () => {
    const s = new FineScheduler();
    s.arm('dev', 2000);
    assert.equal(s.nextSize(50000, 0), 2000);
    assert.equal(s.nextSize(50000, 999999), 2000, 'armed survives idle time');
});

test('scheduler: fine beats armed; multiple fine leases take the min', () => {
    const s = new FineScheduler();
    s.arm('a', 2000);
    s.requestFine('a', 400, 10000);
    assert.equal(s.nextSize(50000, 0), 400);
    s.requestFine('b', 250, 10000);
    assert.equal(s.nextSize(50000, 100), 250);
});

test('scheduler: fine lease expires at its cycle deadline, armed stays', () => {
    const s = new FineScheduler();
    s.arm('a', 2000);
    assert.equal(s.nextSize(50000, 0), 0 + 2000); // also primes lastCycles=0
    s.requestFine('a', 400, 10000); // until cycle 10000 (exclusive)
    assert.equal(s.isFine('a', 9999), true);
    assert.equal(s.nextSize(50000, 9999), 400);
    assert.equal(s.nextSize(50000, 10000), 2000, 'expired → armed');
    assert.equal(s.isFine('a', 10000), false);
});

test('scheduler: CPU-sleep fast-forward drops fine leases, not armed', () => {
    const s = new FineScheduler();
    s.arm('a', 2000);
    s.requestFine('a', 400, 10_000_000);
    assert.equal(s.nextSize(50000, 0), 400);
    // one batch jumped far beyond size×SLEEP_FACTOR → emulator slept
    const size = s.nextSize(50000, 0 + 400 * SLEEP_FACTOR + 1);
    assert.equal(size, 2000, 'fine cleared by the sleep escape');
    assert.equal(s.isFine('a'), false);
});

test('scheduler: release/reset/clamp', () => {
    const s = new FineScheduler();
    s.arm('a', 2000);
    s.release('a');
    assert.equal(s.nextSize(50000, 0), 50000);
    s.arm('a', 2000);
    s.reset();
    assert.equal(s.nextSize(50000, 0), 50000);
    assert.equal(clampBatch(1), 20);
    assert.equal(clampBatch(1e9), 100000);
    assert.equal(clampBatch(1234.7), 1235);
});

// ---------------------------------------------------------------------------
// soft master simulator (open-drain idiom, like the probe firmware)

/**
 * Drives an I2cSlaveEngine the way the P4 firmware does: drive-low =
 * master asserts, release = the line follows the slave's drive (readLine).
 * Data/ownership changes only while SCL is LOW (a level change fed in at
 * an SCL-high step would read as START/STOP — exactly what real wiring
 * avoids), so releases get their own low-phase step.
 */
function makeMaster(readLine, engine) {
    const m = {
        start() {
            // universal for initial and repeated START: ensure SDA released
            // while SCL is low, raise SCL, then drop SDA while SCL is high
            engine.step(false, true);
            engine.step(true, true);
            engine.step(true, false); // SDA falls while SCL high
            engine.step(false, false); // SCL low
        },
        stop() {
            engine.step(false, false); // SCL low, SDA driven low
            engine.step(true, false);
            engine.step(true, true); // SDA released while SCL high = STOP
        },
        writeBit(b) {
            engine.step(false, b); // fall + master drives the bit
            engine.step(true, b); // rise: slave samples
        },
        readBit() {
            engine.step(false, readLine()); // fall: slave drives the next bit
            engine.step(false, readLine()); // master releases while SCL low
            engine.step(true, readLine()); // rise: master samples
            return readLine();
        },
        txByte(v) {
            for (let i = 7; i >= 0; i--) m.writeBit((v >> i) & 1);
            // ACK clock: SCL falls (slave may pull low), master releases
            // during the low phase, then samples on the rise
            engine.step(false, (v & 1) === 1);
            engine.step(false, readLine());
            engine.step(true, readLine());
            return !readLine(); // true = ACK
        },
        rxByte(ack) {
            let v = 0;
            for (let i = 0; i < 8; i++) v = (v << 1) | (m.readBit() ? 1 : 0);
            m.writeBit(ack ? 0 : 1); // master ACK = drive low
            return v;
        },
    };
    return m;
}

function makeEngine(model, addr = 0x50) {
    const events = [];
    let line = true; // current level the slave drives (true = released)
    const engine = new i2cLib.I2cSlaveEngine(addr, model, (h) => { line = h; }, (e) => events.push(e));
    const m = makeMaster(() => line, engine);
    return { engine, m, events, line: () => line };
}

test('engine: addressed write lands in the model and is ACKed', () => {
    const model = new i2cLib.Eeprom24c02();
    const { m } = makeEngine(model);
    m.start();
    assert.equal(m.txByte(0x50 << 1), true, 'address ACKed');
    assert.equal(m.txByte(0x10), true, 'pointer byte ACKed');
    assert.equal(m.txByte(0xA5), true, 'data byte ACKed');
    assert.equal(m.txByte(0x3C), true);
    m.stop();
    assert.equal(model.mem[0x10], 0xa5);
    assert.equal(model.mem[0x11], 0x3c);
});

test('engine: sequential read returns the bytes the slave drove', () => {
    const model = new i2cLib.Eeprom24c02();
    model.load(0x40, [0x12, 0x34, 0x56]);
    const { m } = makeEngine(model);
    m.start();
    assert.equal(m.txByte(0x50 << 1), true);
    assert.equal(m.txByte(0x40), true);
    m.start(); // repeated START
    assert.equal(m.txByte(0x50 << 1 | 1), true, 'read address ACKed');
    assert.equal(m.rxByte(true), 0x12, 'byte 0 (MSB first from the slave)');
    assert.equal(m.rxByte(true), 0x34);
    assert.equal(m.rxByte(false), 0x56); // final byte NACKed by the master
    m.stop();
});

test('engine: address mismatch → no ACK, bytes ignored', () => {
    const model = new i2cLib.Eeprom24c02();
    const { m, engine } = makeEngine(model);
    m.start();
    assert.equal(m.txByte(0x51 << 1), false, 'foreign address NACKed');
    assert.equal(m.txByte(0x77), false);
    m.stop();
    assert.equal(model.writes, 0);
    assert.equal(engine.phase, 'idle');
});

test('engine: STOP releases the SDA drive', () => {
    const model = new i2cLib.Eeprom24c02();
    const { m, line } = makeEngine(model);
    m.start();
    m.txByte(0x50 << 1);
    m.stop();
    assert.equal(line(), true, 'SDA released after STOP');
});

test('engine: BME280 forced measurement advances the signal', () => {
    const model = new i2cLib.Bme280Model();
    const { m } = makeEngine(model, 0x76);
    const readReg = (reg) => {
        m.start();
        m.txByte(0x76 << 1);
        m.txByte(reg);
        m.start();
        m.txByte(0x76 << 1 | 1);
        const v = m.rxByte(false);
        m.stop();
        return v;
    };
    assert.equal(readReg(0xD0), 0x60, 'chip id');
    assert.equal(readReg(0xF4), 0, 'ctrl_meas reset value');
    // forced trigger: write 0xF4 = 0x25
    m.start();
    m.txByte(0x76 << 1);
    m.txByte(0xF4);
    m.txByte(0x25);
    m.stop();
    assert.equal(model.n, 1);
    assert.equal(readReg(0xF4), 0x25, 'shadow register kept');
    // measurement registers decode back to the fake adc triple
    const ms = model.measurement();
    const bytes = [readReg(0xF7), readReg(0xF8), readReg(0xF9)];
    const adcP = (bytes[0] << 12) | (bytes[1] << 4) | (bytes[2] >> 4);
    assert.equal(adcP, ms.adcP & 0xfffff, 'adc_P round-trip through 0xF7..F9');
});

// ---------------------------------------------------------------------------
// models + compensation

test('eeprom: erased fill, pointer wrap, load', () => {
    const e = new i2cLib.Eeprom24c02();
    assert.equal(e.mem[0], 0xff, 'factory-erased');
    e.setPointer(0xfe);
    e.writeByte(1);
    e.writeByte(2);
    assert.equal(e.mem[0xfe], 1);
    assert.equal(e.mem[0xff], 2);
    assert.equal(e.ptr, 0, 'wrapped');
    e.reset();
    assert.equal(e.mem[0xfe], 1, 'non-volatile across reset');
});

test('bme280: factory calibration block matches the pinned dig values', () => {
    const m = new i2cLib.Bme280Model();
    const d = m.dig;
    assert.equal(d.T1, 28100);
    assert.equal(d.T2, 23593);
    assert.equal(d.P1, 36477);
    assert.equal(d.P6, -7);
    assert.equal(d.H4, 322, 'H4 low nibble = 0xE5 high nibble');
    assert.equal(d.H5, 383, 'H5 low nibble = 0xE5 low nibble');
    assert.equal(d.H6, 30);
    // the probe firmware prints the mod-256 sum of the 33 calib bytes
    let sum = 0;
    for (let a = 0x88; a <= 0xA1; a++) sum = (sum + m.regs[a]) & 0xff;
    for (let a = 0xE1; a <= 0xE7; a++) sum = (sum + m.regs[a]) & 0xff;
    assert.equal(sum, 0x9c);
});

test('bme280 compensation: T hand-derived, P/H pinned (C reference parity)', () => {
    const m = new i2cLib.Bme280Model();
    // T(adc 524288): var1 = ((524288>>3) - 2*28100)*23593>>11 = 107549 …
    // hand: 65536-56200=9336; 9336*23593=220264048; >>11=107549; T=(537645+128)>>8
    // but the engine pins the lib's own numbers — verified against the C
    // build by tests/m1_smoke.mjs S10 (bit-exact cross-check).
    const pins = [
        [0, 524288, 1006500, 30000, 2101, 102772, 48035],
        [1, 528384, 1006700, 34096, 2216, 91849, 69917],
        [2, 532480, 1006900, 38192, 2331, 80896, 91772],
    ];
    for (const [n, rt, rp, rh, T, P, H] of pins) {
        m.n = n;
        const ms = m.measurement();
        assert.deepEqual([ms.adcT, ms.adcP, ms.adcH], [rt, rp, rh], `raw n=${n}`);
        const c = i2cLib.bme280Compensate(rt, rp, rh, m.dig);
        assert.deepEqual([c.tCx100, c.pPa, c.hRx1024], [T, P, H], `compensated n=${n}`);
    }
});

// ---------------------------------------------------------------------------
// NEC decode

test('nec: standard frame round-trip (LSB-first bytes, inverse fields)', () => {
    const f = necLib.decodeNec(necLib.necFrameSegments(0x00FF, 0x11));
    assert.equal(f.repeat, false);
    assert.equal(f.addr, 0xff);
    assert.equal(f.invAddr, 0x00);
    assert.equal(f.cmd, 0x11);
    assert.equal(f.invCmd, 0xee);
    assert.equal(f.valid, true);
    assert.equal(f.addr16, 0x00ff);
});

test('nec: 16-bit address frames decode with valid=false when inverses break', () => {
    const segs = necLib.necFrameSegments(0x00FF, 0x11);
    segs[9].off = necLib.NEC_TIMING.bit1Off; // flip one invAddr bit (0 → 1)
    const f = necLib.decodeNec(segs);
    assert.notEqual(f, null);
    assert.equal(f.valid, false, 'inverse check fails, frame still readable');
    assert.equal(f.invAddr, 0x01);
});

test('nec: repeat frame', () => {
    const t = necLib.NEC_TIMING;
    const f = necLib.decodeNec([
        { on: t.leaderOn, off: t.repeatOff },
        { on: t.burst, off: 0 },
    ]);
    assert.equal(f.repeat, true);
});

test('nec: garbage and truncated inputs reject', () => {
    assert.equal(necLib.decodeNec([]), null);
    assert.equal(necLib.decodeNec([{ on: 5000, off: 5000 }, { on: 600, off: 600 }]), null, 'leader too short');
    const short = necLib.necFrameSegments(0x11, 0x22).slice(0, 20);
    assert.equal(necLib.decodeNec(short), null, 'missing bits');
    const badBit = necLib.necFrameSegments(0x11, 0x22);
    badBit[5].off = 3000; // not 0-ish nor 1-ish
    assert.equal(necLib.decodeNec(badBit), null);
});

test('nec: carrier edges fold into the right envelope', () => {
    // 38 kHz carrier: rising edges 26 µs apart inside bursts
    const edges = [];
    const burst = (startUs, lenUs) => {
        for (let t = 0; t <= lenUs - 13; t += 26) edges.push({ up: true, us: startUs + t });
    };
    const t = necLib.NEC_TIMING;
    burst(0, t.leaderOn);
    // bit-0 (560 gap), bit-1 (1690 gap), then the stop burst
    let at = t.leaderOn + t.leaderOff;
    burst(at, t.burst);
    at += t.burst + t.bit0Off;
    burst(at, t.burst);
    at += t.burst + t.bit1Off;
    burst(at, t.burst);
    const segs = necLib.edgesToSegments(edges);
    assert.equal(segs.length, 4);
    assert.ok(Math.abs(segs[0].on - (t.leaderOn - 26)) < 30, 'leader ≈ 9 ms');
    assert.ok(Math.abs(segs[0].off - t.leaderOff) < 40, 'leader gap (edge quantised)');
    assert.ok(Math.abs(segs[1].off - t.bit0Off) < 40, 'gap to next burst start');
    assert.ok(Math.abs(segs[2].off - t.bit1Off) < 40);
    assert.equal(segs[3].off, 0, 'trailing gap unknown');
});

test('nec: RMT symbol words decode (tick-agnostic via leader normalisation)', () => {
    // 1 µs ticks like the probe firmware's RMT ch1
    const t = necLib.NEC_TIMING;
    const segs = necLib.necFrameSegments(0x1234, 0xAB).map((s) => ({
        on: Math.round(s.on), off: Math.round(s.off),
    }));
    const words = segs.map((s) => s.on | (1 << 15) | (s.off << 16));
    words.push(0); // transmit terminator
    const conv = necLib.rmtWordsToSegments(words);
    assert.notEqual(conv, null);
    const f = necLib.decodeNec(conv);
    assert.equal(f.addr, 0x34);
    assert.equal(f.cmd, 0xab);
    assert.equal(f.valid, true);
    // scaled ticks (a 0.5 µs resolution) decode identically
    const scaled = words.map((w) => {
        const d0 = (w & 0x7fff) * 2, d1 = ((w >>> 16) & 0x7fff) * 2;
        return d0 | (1 << 15) | (d1 << 16);
    });
    const f2 = necLib.decodeNec(necLib.rmtWordsToSegments(scaled));
    assert.deepEqual([f2.addr, f2.cmd, f2.valid], [0x34, 0xab, true]);
    // junk RAM rejected
    assert.equal(necLib.rmtWordsToSegments(new Uint32Array(48)), null);
    const notTx = new Uint32Array(48).fill((5 << 16) | 5); // level0 = 0
    assert.equal(necLib.rmtWordsToSegments(notTx), null);
});

// ---------------------------------------------------------------------------
// device plugins

/** Fake runtime ctx with scheduler-lease + input recording. `levels` maps
 * pin → driven level for ctx.pinLevel (the logic-analyzer start snapshot). */
function makeDevCtx({ regs, levels = {} } = {}) {
    const inputs = [];
    const leases = { armed: [], fine: [], released: 0 };
    const logs = [];
    let dirty = 0;
    let cycles = 0;
    const ctx = {
        id: 't', chip: 'esp32c3', gpioCount: 22, mmio: regs ? C3_MMIO : null,
        cyclesPerUs: 160,
        setCycles: (c) => { cycles = c; }, // test-only knob
            setPinInput: (pin, high) => inputs.push([pin, high]),
            armSampling: (batch) => leases.armed.push(batch),
            fineSampling: (batch, forCycles) => leases.fine.push([batch, forCycles]),
            releaseSampling: () => leases.released++,
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
            cycles: () => cycles,
            pinLevel: (pin) => (pin in levels ? levels[pin] : null),
            subscribe: () => {}, unsubscribe: () => {},
            markDirty: () => { dirty++; },
            log: (text, level) => logs.push([text, level]),
    };
    return { ctx, inputs, leases, logs, dirty: () => dirty };
}

test('m4 device modules pass meta validation and claim pins', () => {
    assert.equal(validateDeviceModule(i2c), null);
    assert.equal(validateDeviceModule(ir), null);
    assert.deepEqual(i2c.Device.pins({ scl: 1, sda: 2 }), [1, 2]);
    assert.deepEqual(ir.Device.pins({ pin: 5, source: 'gpio' }), [5]);
    assert.deepEqual(ir.Device.pins({ pin: 5, source: 'rmt' }), [], 'rmt mode claims no GPIO');
});

test('bitbang-i2c-slave: full transaction through the device (ACK + log)', () => {
    const { ctx, inputs, leases } = makeDevCtx();
    const dev = new i2c.Device(ctx, { id: 'x', type: 'bitbang-i2c-slave', scl: 1, sda: 2, model: 'eeprom24c02' });
    assert.deepEqual(leases.armed, [i2c.ARM_BATCH], 'standing watch armed');
    // tap the device's engine drive callback so the master can read the
    // line, and feed wire levels through onPinState (the sigbus path) so
    // the fine-sampling request logic runs too
    let line = true;
    const origDrive = dev.engine.driveSda;
    dev.engine.driveSda = (h) => { line = h; origDrive(h); };
    const m = makeMaster(() => line, {
        step: (scl, sda) => {
            dev.onPinState(1, { out: !!scl, oe: true, cycles: 0 });
            dev.onPinState(2, { out: sda == null ? line : !!sda, oe: true, cycles: 0 });
        },
    });

    m.start();
    assert.equal(m.txByte(0x50 << 1), true);
    m.txByte(0x10);
    m.txByte(0xA5);
    m.txByte(0x3C);
    m.stop();

    const st = dev.getState();
    assert.equal(st.stats.starts, 1);
    assert.equal(st.stats.stops, 1);
    assert.equal(st.model, 'eeprom24c02');
    assert.deepEqual(st.mem.slice(0x10, 0x12), [0xa5, 0x3c]);
    assert.equal(st.log.length, 1);
    assert.equal(st.log[0].rw, 0);
    assert.equal(st.log[0].ptr, 0x10);
    assert.deepEqual(st.log[0].bytes, [0xa5, 0x3c]);
    assert.ok(inputs.some(([pin, high]) => pin === 2 && high === false), 'ACK pulled SDA low');
    assert.ok(leases.fine.length > 0, 'fine sampling requested during the transfer');

    dev.onCommand('eeprom-load', { addr: 0x80, bytes: [0xde, 0xad] });
    assert.deepEqual(dev.getState().mem.slice(0x80, 0x82), [0xde, 0xad]);
    dev.destroy();
    assert.equal(leases.released, 1);
});

test('bitbang-i2c-slave: bme280 state exposes the compensated readout', () => {
    const { ctx } = makeDevCtx();
    const dev = new i2c.Device(ctx, { id: 'x', type: 'bitbang-i2c-slave', model: 'bme280', scl: 1, sda: 2, address: 0x76 });
    dev.model.n = 1;
    const st = dev.getState();
    assert.equal(st.model, 'bme280');
    assert.equal(st.address, 0x76);
    assert.equal(st.bme.n, 1);
    assert.equal(st.bme.tCx100, 2216);
    assert.equal(st.bme.pPa, 91849);
    assert.equal(st.bme.hRx1024, 69917);
});

test('ir-nec: gpio edge capture decodes after the line goes quiet', () => {
    const { ctx, leases } = makeDevCtx();
    const dev = new ir.Device(ctx, { id: 'x', type: 'ir-nec', pin: 5, source: 'gpio' });
    dev.onBatch(); // resolves the mode
    assert.equal(dev.getState().mode, 'gpio');

    // feed a synthetic bit-banged frame: rising edges every 26 µs in bursts;
    // bytes [0xAA, 0x55, 0x37, 0xC8] = a valid addr/cmd + inverse pair
    const bytes = [0xaa, 0x55, 0x37, 0xc8];
    let cycles = 0;
    const t = necLib.NEC_TIMING;
    const burst = (lenUs) => {
        for (let u = 0; u <= lenUs - 13; u += 26) {
            ctx.setCycles(cycles + u * 160);
            dev.onPinState(5, { out: true, oe: true, cycles: cycles + u * 160 });
        }
        cycles += lenUs * 160;
    };
    burst(t.leaderOn);
    cycles += t.leaderOff * 160;
    for (let b = 0; b < 32; b++) {
        burst(t.burst);
        const one = (bytes[b >> 3] >> (b & 7)) & 1; // LSB first per byte
        cycles += (one ? t.bit1Off : t.bit0Off) * 160;
    }
    burst(t.burst);
    assert.ok(leases.fine.length > 100, 'fine lease renewed per edge');

    ctx.setCycles(cycles + 30_000 * 160); // long quiet → flush
    dev.onBatch();
    const st = dev.getState();
    assert.equal(st.mode, 'gpio');
    assert.equal(st.count, 1);
    assert.equal(st.last.addr, 0xaa);
    assert.equal(st.last.cmd, 0x37);
    assert.equal(st.last.valid, true);
    dev.destroy();
});

test('ir-nec: rmt RAM capture (auto source via pin routing)', () => {
    const regs = new Map();
    const { ctx } = makeDevCtx({ regs });
    // route GPIO10 → RMT ch1 (signal 52), leave ch0 unrouted
    regs.set(C3_MMIO.gpio.funcOutSelBase + 4 * 10, C3_MMIO.signals.rmtCh1);
    const dev = new ir.Device(ctx, { id: 'x', type: 'ir-nec', pin: 10, source: 'auto' });
    dev.onBatch();
    let st = dev.getState();
    assert.equal(st.mode, 'rmt', 'auto picks the routed RMT channel');
    assert.equal(st.channel, 1);
    assert.equal(st.pin, 10);

    // load a completed NEC transmission into the channel RAM (1 µs ticks)
    const segs = necLib.necFrameSegments(0x00FF, 0x22).map((s) => ({
        on: Math.round(s.on), off: Math.round(s.off),
    }));
    const r = C3_MMIO.rmt.ch(1);
    segs.forEach((s, i) => regs.set(r.mem + 4 * i, s.on | (1 << 15) | (s.off << 16)));
    regs.set(r.mem + 4 * segs.length, 0); // terminator
    regs.set(r.status, 0);
    dev.onBatch();
    st = dev.getState();
    assert.equal(st.count, 1);
    assert.equal(st.last.addr, 0xff);
    assert.equal(st.last.cmd, 0x22);
    assert.equal(st.last.valid, true);

    // repeat frame follows
    const rep = [
        { on: 9000, off: 2250 }, { on: 560, off: 0 },
    ];
    rep.forEach((s, i) => regs.set(r.mem + 4 * i, s.on | (1 << 15) | (s.off << 16)));
    regs.set(r.mem + 4 * rep.length, 0);
    dev.onBatch();
    st = dev.getState();
    assert.equal(st.count, 1, 'repeats do not add frames');
    assert.equal(st.last.repeats, 1);
    assert.equal(st.last.cmd, 0x22, 'repeat refers to the previous code');

    // fresh emulator: binding resets (auto), state clears
    dev.onEmuReady();
    st = dev.getState();
    assert.equal(st.count, 0);
    assert.equal(st.mode, null);
});

// ---------------------------------------------------------------------------
// MAX7219 (datasheet tables 2–8)

test('max7219: Code B font matches datasheet table 5', () => {
    const f = mxLib.CODE_B;
    assert.deepEqual(
        [f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7]],
        [0x7e, 0x30, 0x6d, 0x79, 0x33, 0x5b, 0x5f, 0x70],
    );
    assert.deepEqual(
        [f[8], f[9], f[0xa], f[0xb], f[0xc], f[0xd], f[0xe], f[0xf]],
        [0x7f, 0x7b, 0x01, 0x4f, 0x37, 0x0e, 0x67, 0x00],
    );
    // the reference driver's no-decode digit glyphs use the same segment
    // mapping (D7=dp D6=a … D0=g) — cross-check its font constants
    assert.deepEqual([f[0], f[2], f[8]], [0x7e, 0x6d, 0x7f]);
});

test('max7219: register model, power-on defaults, masking', () => {
    const m = new mxLib.Max7219Model();
    assert.equal(m.shutdown, true, 'powers up in shutdown');
    assert.equal(m.scanLimit, 0, 'scanning one digit');
    assert.equal(m.decodeMode, 0);
    assert.equal(m.intensity, 0);
    assert.deepEqual(m.digits, new Array(8).fill(0));
    assert.equal(m.write(0x01, 0x42), true, 'digit write changes state');
    assert.equal(m.write(0x01, 0x42), false, 'same byte = no visible change');
    assert.equal(m.write(0x00, 0xff), false, 'no-op register ignored');
    assert.equal(m.writes, 3, 'no-ops still counted');
    m.write(0x0a, 0x2c); // intensity keeps the low nibble
    assert.equal(m.intensity, 0x0c);
    m.write(0x0b, 0x55); // scan limit keeps 3 bits
    assert.equal(m.scanLimit, 5);
    m.write(0x0c, 0x01);
    assert.equal(m.shutdown, false);
    m.write(0x0f, 0x01);
    assert.equal(m.test, true);
    assert.equal(m.brightness(), 13 / 32, 'PWM duty (intensity+1)/32');
    assert.equal(m.digitSegments(0), 0x42, 'no decode: raw byte');
    m.write(0x09, 0x01); // Code B decode for digit 0 only
    assert.equal(m.digitSegments(0), mxLib.CODE_B[2], '0x42 decodes low nibble');
    m.write(0x01, 0x82); // 2 + DP (D7 independent of the decoder)
    assert.equal(m.digitSegments(0), mxLib.CODE_B[2] | 0x80);
});

test('max7219: display derivation (decode, scan limit, shutdown, test)', () => {
    const base = { digits: new Array(8).fill(0), decodeMode: 0, scanLimit: 7, shutdown: false, test: false, intensity: 3 };
    base.digits[0] = 0x05; base.digits[1] = 0x8f; base.digits[7] = 0xff;
    let v = mxLib.displayFromSnapshot(base);
    assert.equal(v.segs[0], 0x05, 'no decode: raw byte is the segment byte');
    assert.equal(v.segs[1], 0x8f);
    assert.equal(v.segs[7], 0xff);
    base.decodeMode = 0x03; // decode digits 0 and 1
    v = mxLib.displayFromSnapshot(base);
    assert.equal(v.segs[0], mxLib.CODE_B[5], 'digit 0 decoded');
    assert.equal(v.segs[1], mxLib.CODE_B[0xf] | 0x80, 'digit 1: blank glyph + DP');
    base.scanLimit = 0; // only digit 0 scanned
    v = mxLib.displayFromSnapshot(base);
    assert.equal(v.segs[7], 0, 'beyond scan limit: dark');
    assert.notEqual(v.segs[0], 0);
    base.shutdown = true;
    v = mxLib.displayFromSnapshot(base);
    assert.deepEqual(v.segs, new Array(8).fill(0), 'shutdown blanks, registers kept');
    base.test = true; base.shutdown = false;
    v = mxLib.displayFromSnapshot(base);
    assert.deepEqual(v.segs, new Array(8).fill(0xff), 'display test lights everything');
});

test('max7219 wire: MSB-first shift, LOAD latch, misaligned frames dropped', () => {
    const got = [];
    const w = new mxLib.Max7219Wire((words, bits) => got.push({ words, bits }));
    // the first LOAD sighting learns the idle level (consumed, not a latch)
    assert.equal(w.step(false, false, true), true);
    assert.deepEqual(got, []);
    assert.equal(w.busy, false);
    // one frame, two words, mode-0 order (DIN settles while CLK low)
    w.step(false, false, false); // LOAD fall: frame start
    assert.equal(w.busy, true);
    const bit = (b) => { w.step(false, b, false); w.step(true, b, false); };
    // 0xAF16 then 0x00FF, MSB first
    for (let i = 15; i >= 0; i--) bit((0xaf16 >> i) & 1);
    for (let i = 15; i >= 0; i--) bit((0x00ff >> i) & 1);
    w.step(false, false, true); // LOAD rise: latch
    assert.deepEqual(got, [{ words: [0xaf16, 0x00ff], bits: 32 }]);
    assert.equal(w.busy, false);
    // reference-driver order: DIN changes after the rise, before the fall
    got.length = 0;
    w.step(false, false, false);
    for (let i = 15; i >= 0; i--) {
        const b = (0x1234 >> i) & 1;
        w.step(true, b, false);  // rise samples the CURRENT din
        w.step(false, b, false);
        w.step(false, b, false); // (din still stable around the next rise)
    }
    w.step(false, false, true);
    assert.deepEqual(got, [{ words: [0x1234], bits: 16 }]);
    // 17 clocks = misaligned: frame dropped, not garbled
    got.length = 0;
    w.step(false, false, false);
    for (let i = 0; i < 17; i++) { w.step(true, i === 0, false); w.step(false, i === 0, false); }
    w.step(false, false, true);
    assert.deepEqual(got, [{ words: null, bits: 17 }]);
    // reset forgets levels — and a fresh emulator's pads sit low, so the
    // first CLK sighting at high IS a genuine rising edge (the sigbus
    // reports changes only; the pre-change level was the real sampled low)
    w.reset();
    assert.equal(w.step(true, false, false), true, 'null→high CLK counts as a rise');
});

test('max7219 wire: fresh-emulator bootstrap (idle CLK is never announced)', () => {
    const got = [];
    const w = new mxLib.Max7219Wire((words, bits) => got.push({ words, bits }));
    // pads default low at reset: the driver's init write announces LOAD=1,
    // CLK and DIN sit at their idle levels and produce no events — the
    // first CLK event of the first frame is a rising edge from null
    assert.equal(w.step(null, null, true), true, 'LOAD init write consumed');
    assert.deepEqual(got, [], 'learned idle LOAD is not a latch');
    w.step(null, null, false); // LOAD falls: frame start
    for (let i = 15; i >= 0; i--) {
        const b = (0x0b07 >> i) & 1;
        w.step(true, b, false);
        w.step(false, b, false);
    }
    w.step(false, false, true); // LOAD rises: latch
    assert.deepEqual(got, [{ words: [0x0b07], bits: 16 }]);
    // an empty LOAD pulse (fall + rise, no clocks) is not a frame
    got.length = 0;
    w.step(false, false, false);
    w.step(false, false, true);
    assert.deepEqual(got, []);
});

test('max7219: daisy-chain word picking (stream runs away from the master)', () => {
    const words = [0x0100, 0x0200, 0x0300];
    assert.equal(mxLib.pickChainWord(words, 1, 0), 0x0300, 'single device: last word');
    assert.equal(mxLib.pickChainWord(words, 3, 0), 0x0300, 'pos0 (DIN side): last word');
    assert.equal(mxLib.pickChainWord(words, 3, 1), 0x0200);
    assert.equal(mxLib.pickChainWord(words, 3, 2), 0x0100, 'far end: first word');
    assert.equal(mxLib.pickChainWord([0x0100], 2, 0), 0x0100, 'short frame feeds pos0');
    assert.equal(mxLib.pickChainWord([0x0100], 2, 1), null, 'pos1 keeps its old word');
    assert.equal(mxLib.pickChainWord(words, 2, 5), null, 'pos beyond the chain');
});

/** Soft master driving the plugin through onPinState (the sigbus path). */
function makeMaxMaster(devs, pins, order = 'after-rise') {
    const feed = (pin, high) => {
        for (const d of devs) d.onPinState(pin, { out: high, oe: true, cycles: 0 });
    };
    feed(pins.load, true);  // the firmware's init writes teach idle levels
    feed(pins.clk, false);
    feed(pins.din, false);
    return {
        frame(words) {
            feed(pins.load, false);
            for (const word of words) {
                for (let i = 15; i >= 0; i--) {
                    const b = (word >> i) & 1;
                    if (order === 'after-rise') {
                        feed(pins.din, b);
                        feed(pins.clk, true);
                        feed(pins.clk, false);
                    } else { // classic mode-0: DIN settles while CLK is low
                        feed(pins.clk, false);
                        feed(pins.din, b);
                        feed(pins.clk, true);
                    }
                }
            }
            feed(pins.load, true);
        },
        /** nBits clock rises then LOAD rise — a frame an edge-sampling
         * window could not fully resolve (bit count not a multiple of 16). */
        garbage(nBits) {
            feed(pins.clk, false); // mode0 frames leave CLK high at the end
            feed(pins.load, false);
            for (let i = 0; i < nBits; i++) {
                feed(pins.din, i & 1);
                feed(pins.clk, true);
                feed(pins.clk, false);
            }
            feed(pins.load, true);
        },
    };
}

const GUN_PINS = { din: 21, clk: 13, load: 14 };

test('max7219 device: meta validation and pins', () => {
    assert.equal(validateDeviceModule(mx), null);
    assert.deepEqual(mx.Device.pins({ din: 21, clk: 13, load: 14 }), [21, 13, 14]);
    assert.equal(mx.Device.sharedBus, true);
});

test('max7219 device: decodes reg_init + digit frame, both bit orders', () => {
    for (const order of ['after-rise', 'mode0']) {
        const { ctx, leases } = makeDevCtx();
        const dev = new mx.Device(ctx, { id: 'x', type: 'max7219', din: 21, clk: 13, load: 14 });
        assert.deepEqual(leases.armed, [mx.ARM_BATCH], 'standing watch armed');
        const m = makeMaxMaster([dev], GUN_PINS, order);
        // the reference driver's reg_init: shutdown, test off, no decode,
        // scan 8 digits, intensity 4, normal operation
        for (const [a, d] of [[0x0c, 0x00], [0x0f, 0x00], [0x09, 0x00], [0x0b, 0x07], [0x0a, 0x04], [0x0c, 0x01]]) {
            m.frame([(a << 8) | d]);
        }
        // "CAL " mirrored on both halves: digits 7..4 = C A L blank, 3..0
        // same. Single-device drivers pulse LOAD per register write (the
        // reference driver does one 16-bit LOAD frame per write_reg).
        for (const [a, d] of [[1, 0x00], [2, 0x0e], [3, 0x77], [4, 0x4e],
            [5, 0x00], [6, 0x0e], [7, 0x77], [8, 0x4e]]) {
            m.frame([(a << 8) | d]);
        }
        const st = dev.getState();
        assert.equal(st.shutdown, false);
        assert.equal(st.scanLimit, 7);
        assert.equal(st.intensity, 4);
        assert.equal(st.decodeMode, 0);
        assert.equal(st.frames, 14, '6 init words + 8 digit words, one frame each');
        assert.equal(st.dropped, 0);
        assert.deepEqual(st.digits, [0x00, 0x0e, 0x77, 0x4e, 0x00, 0x0e, 0x77, 0x4e]);
        assert.ok(leases.fine.length > 0, 'fine sampling requested during frames');
        // a misaligned frame (17 clocks) is dropped, the display untouched
        m.garbage(17);
        const st2 = dev.getState();
        assert.equal(st2.dropped, 1);
        assert.deepEqual(st2.digits, [0x00, 0x0e, 0x77, 0x4e, 0x00, 0x0e, 0x77, 0x4e]);
        assert.equal(leases.released, 0);
        dev.destroy();
        assert.equal(leases.released, 1);
    }
});

test('max7219 device: two chained parts split one frame, shared pins', () => {
    const { ctx } = makeDevCtx();
    const near = new mx.Device(ctx, { id: 'n', type: 'max7219', din: 21, clk: 13, load: 14, chain: 2, pos: 0 });
    const far = new mx.Device(ctx, { id: 'f', type: 'max7219', din: 21, clk: 13, load: 14, chain: 2, pos: 1 });
    const m = makeMaxMaster([near, far], GUN_PINS);
    // first word travels through to the far part, last word stays near
    m.frame([(0x01 << 8) | 0xaa, (0x02 << 8) | 0xbb]);
    assert.deepEqual(near.getState().digits, [0, 0xbb, 0, 0, 0, 0, 0, 0], 'pos0 latched the last word (digit1)');
    assert.deepEqual(far.getState().digits, [0xaa, 0, 0, 0, 0, 0, 0, 0], 'pos1 latched the first word (digit0)');
    // onEmuReady: power-on defaults again
    near.onEmuReady();
    assert.deepEqual(near.getState().digits, new Array(8).fill(0));
    assert.equal(near.getState().shutdown, true);
    assert.equal(near.getState().frames, 0);
});

// ---------------------------------------------------------------------------
// shared bus wiring (v1 conflict rule + the sharedBus exception)

import { PerisRuntime } from '../../build/core/runtime.js';

test('runtime: sharedBus devices share pins; non-bus devices still conflict', async () => {
    const rt = new PerisRuntime();
    const msgs = [];
    rt.post = (m) => msgs.push(m);
    rt.registry = {
        has: (t) => ['led', 'i2c', 'max7219'].includes(t),
        meta: (t) => (t === 'led' ? ledMod.Device : t === 'i2c' ? i2c.Device : mx.Device),
        View: () => null,
        types: () => [],
        errors: [],
    };
    // two I2C slaves on one SCL/SDA pair: legal wiring
    await rt.applyConfig({
        perisVersion: 1,
        devices: [
            { id: 'ee', type: 'i2c', model: 'eeprom24c02', scl: 1, sda: 2 },
            { id: 'bm', type: 'i2c', model: 'bme280', scl: 1, sda: 2, address: 0x76 },
        ],
    });
    let ready = msgs.find((m) => m.type === 'peris_ready');
    assert.equal(ready.ok, true, ready.errors.join('; '));
    assert.equal(rt.has('ee') && rt.has('bm'), true);

    // a MAX7219 daisy chain on one DIN/CLK/LOAD triple: legal wiring too
    msgs.length = 0;
    await rt.applyConfig({
        perisVersion: 1,
        devices: [
            { id: 'mx0', type: 'max7219', din: 21, clk: 13, load: 14, chain: 2, pos: 0 },
            { id: 'mx1', type: 'max7219', din: 21, clk: 13, load: 14, chain: 2, pos: 1 },
        ],
    });
    ready = msgs.find((m) => m.type === 'peris_ready');
    assert.equal(ready.ok, true, ready.errors.join('; '));

    // a plain LED on the same pin is still a conflict
    msgs.length = 0;
    await rt.applyConfig({
        perisVersion: 1,
        devices: [
            { id: 'ee', type: 'i2c', scl: 1, sda: 2 },
            { id: 'led', type: 'led', pin: 1 },
        ],
    });
    ready = msgs.find((m) => m.type === 'peris_ready');
    assert.equal(ready.ok, false);
    assert.ok(ready.errors.some((e) => e.includes('already used')), ready.errors.join('; '));
    // v1 semantics: the conflict is reported (yellow bar), the instance
    // still runs — the page's option builder is the real gate
    assert.equal(rt.has('led'), true);
});

// ---------------------------------------------------------------------------
// Logic analyzer (0.10.0): la-lib readout math + the capture state machine

import * as la from '../../peris/devices/logic-analyzer.js';
import * as laLib from '../../peris/devices/la-lib.js';

test('la-lib: parsePins cleans config input and never shares arrays', () => {
    assert.deepEqual(laLib.parsePins([3, 1, 1, 'x', -2, 3.5]), [3, 1]);
    assert.deepEqual(laLib.parsePins('nope'), []);
    assert.deepEqual(laLib.parsePins(null), []);
    const capped = [];
    for (let i = 0; i < 20; i++) capped.push(i);
    assert.equal(laLib.parsePins(capped).length, laLib.MAX_CHANNELS);
    const shared = [];
    assert.notEqual(laLib.parsePins(shared), shared, 'fresh array — the config merge is shallow');
});

test('la-lib: levelAt walks the flat edge array with unknown head', () => {
    const flat = [5, 1, 10, 0, 20, -1];
    assert.equal(laLib.levelAt(flat, null, 4), null, 'before the first edge: unknown');
    assert.equal(laLib.levelAt(flat, null, 5), 1);
    assert.equal(laLib.levelAt(flat, null, 12), 0);
    assert.equal(laLib.levelAt(flat, null, 99), -1, 'Z holds to the end');
    assert.equal(laLib.levelAt(flat, 1, 3), 1, 'initial level before any edge');
    assert.equal(laLib.levelAt([], 0, 42), 0);
});

test('la-lib: axis ticks, formatting, fit span and the pixel transform', () => {
    assert.equal(laLib.niceTickStep(1000, 6), 200);
    assert.equal(laLib.niceTickStep(50000, 6), 10000);
    assert.equal(laLib.niceTickStep(0.5, 5), 0.1);
    assert.equal(laLib.fmtUs(840), '840 µs');
    assert.equal(laLib.fmtUs(12500), '12.5 ms');
    assert.equal(laLib.fmtUs(2500000), '2.50 s');
    assert.equal(laLib.fmtUs(NaN), '—');
    // fit: full window while running, captured extent once done
    assert.equal(laLib.fitSpanUs({ status: 'run', windowUs: 50000, capturedUs: 1000, edges: [[]] }), 50000);
    assert.equal(laLib.fitSpanUs({ status: 'done', windowUs: 50000, capturedUs: 5000, edges: [[4000, 1]] }), 5000);
    assert.equal(laLib.fitSpanUs({ status: 'done', windowUs: 50000, capturedUs: 0, edges: [[]] }), 50000, 'empty capture fits the window');
    const { usToX, xToUs } = laLib.waveformXform(356, 56, 1000);
    assert.equal(usToX(0), 56);
    assert.equal(usToX(1000), 356);
    assert.equal(usToX(5000), 356, 'clamped');
    assert.ok(Math.abs(xToUs(usToX(123)) - 123) < 1e-9);
});

test('logic-analyzer: meta validation, pin claim, sharedBus probe semantics', () => {
    assert.equal(validateDeviceModule(la), null);
    assert.deepEqual(la.Device.pins({ pins: [1, 2] }), [1, 2]);
    assert.deepEqual(la.Device.pins({ pins: [] }), []);
    assert.equal(la.Device.sharedBus, true, 'a probe taps lines other bus devices drive');
});

test('logic-analyzer: immediate capture records edges, freezes at window end', () => {
    const { ctx, leases } = makeDevCtx({ levels: { 1: true, 2: false } });
    const dev = new la.Device(ctx, { id: 'la', type: 'logic-analyzer', pins: [1, 2], durationMs: 10 });
    let st = dev.getState();
    assert.equal(st.status, 'idle');
    assert.deepEqual(st.channels, [1, 2]);
    assert.equal(st.edges.length, 2);

    dev.onCommand('arm');
    st = dev.getState();
    assert.equal(st.status, 'run', 'immediate trigger starts at once');
    assert.equal(st.triggered, false);
    assert.deepEqual(leases.armed, [la.ARM_BATCH]);
    assert.deepEqual(leases.fine[leases.fine.length - 1], [la.FINE_BATCHES.normal, la.FINE_HOLD_CYCLES]);

    // edges on both channels, µs from the capture start (160 cycles/µs)
    dev.onPinState(1, { out: false, oe: true, cycles: 1600 });   // 10 µs, falling
    dev.onPinState(2, { out: true, oe: true, cycles: 4800 });    // 30 µs, rising
    dev.onPinState(1, { out: true, oe: false, cycles: 8000 });   // 50 µs, released → Z
    st = dev.getState();
    assert.equal(st.status, 'run');
    assert.deepEqual(st.edges, [[], []], 'run pushes carry no waveform (progress only)');
    assert.deepEqual(st.counts, [2, 1], 'live per-channel edge counts');
    assert.deepEqual(st.initial, [null, null]);
    assert.ok(leases.fine.length >= 4, 'fine lease renewed per edge');

    ctx.setCycles(10 * 1000 * 160 + 1); // past the 10 ms guest window
    dev.onBatch();
    st = dev.getState();
    assert.equal(st.status, 'done');
    assert.equal(st.triggered, false);
    assert.ok(Math.abs(st.capturedUs - 10000) < 1);
    assert.deepEqual(st.initial, [1, 0], 'levels snapshotted at capture start');
    assert.deepEqual(st.edges[0], [10, 0, 50, -1]);
    assert.deepEqual(st.edges[1], [30, 1]);
    assert.equal(st.totalEdges, 3);
    assert.ok(leases.released >= 1, 'leases dropped when done without auto');

    // frozen: late edges are ignored
    dev.onPinState(2, { out: false, oe: true, cycles: 20 * 1000 * 160 });
    assert.equal(dev.getState().totalEdges, 3);
    dev.destroy();
    assert.equal(leases.released >= 2, true);
});

test('logic-analyzer: channel trigger — direction, wrong channel, t0 at the edge', () => {
    const { ctx, leases } = makeDevCtx({ levels: { 4: false, 5: false } });
    const dev = new la.Device(ctx, {
        id: 'la', type: 'logic-analyzer', pins: [4, 5], trigCh: 0, trigEdge: 'rise', durationMs: 5,
    });
    dev.onCommand('arm');
    assert.equal(dev.getState().status, 'armed');
    assert.deepEqual(leases.armed, [la.ARM_BATCH], 'standing watch while waiting');

    dev.onPinState(4, { out: false, oe: true, cycles: 1000 }); // falling: ignored
    dev.onPinState(5, { out: true, oe: true, cycles: 1500 });  // wrong channel
    assert.equal(dev.getState().status, 'armed');

    dev.onPinState(4, { out: true, oe: true, cycles: 16000 }); // rising on GPIO4
    let st = dev.getState();
    assert.equal(st.status, 'run');
    assert.equal(st.triggered, true);
    assert.equal(st.capturedUs >= 0, true);
    // the trigger edge itself is the first sample at t=0; pre-edge level = 0
    ctx.setCycles(16000 + 5 * 1000 * 160 + 1);
    dev.onBatch();
    st = dev.getState();
    assert.equal(st.status, 'done');
    assert.deepEqual(st.edges[0], [0, 1]);
    assert.equal(st.initial[0], 0, 'trigger channel pre-edge level is the complement');
    assert.equal(st.initial[1], 0, 'other channels snapshot via pinLevel');
    dev.destroy();
});

test('logic-analyzer: falling trigger counts a release-to-Z as an edge', () => {
    const { ctx } = makeDevCtx({ levels: { 7: true } });
    const dev = new la.Device(ctx, { id: 'la', type: 'logic-analyzer', pins: [7], trigCh: 0, trigEdge: 'fall' });
    dev.onCommand('arm');
    dev.onPinState(7, { out: true, oe: true, cycles: 100 });
    assert.equal(dev.getState().status, 'armed', 'rising ignored');
    dev.onPinState(7, { out: false, oe: false, cycles: 200 }); // released → Z
    assert.equal(dev.getState().status, 'run', 'Z counts as falling (open-drain idiom)');
    assert.deepEqual(dev.getState().counts, [1]);
    dev.destroy();
});

test('logic-analyzer: stop / clear / auto re-arm / auto+immediate warns', () => {
    // stop mid-run keeps the partial capture
    {
        const { ctx, leases } = makeDevCtx({ levels: { 1: true } });
        const dev = new la.Device(ctx, { id: 'la', type: 'logic-analyzer', pins: [1], durationMs: 1000 });
        dev.onCommand('arm');
        dev.onPinState(1, { out: false, oe: true, cycles: 160000 }); // 1 ms in
        ctx.setCycles(1600000); // ~9 ms of the 1000 ms window
        dev.onCommand('stop');
        const st = dev.getState();
        assert.equal(st.status, 'done');
        assert.ok(st.capturedUs > 0 && st.capturedUs < 1000000, 'partial capture kept');
        assert.equal(st.totalEdges, 1);
        assert.ok(leases.released >= 1);
        // clear → idle, empty
        dev.onCommand('clear');
        const st2 = dev.getState();
        assert.equal(st2.status, 'idle');
        assert.equal(st2.totalEdges, 0);
        assert.equal(st2.capturedUs, 0);
        dev.destroy();
    }
    // stop while merely armed disarms without touching data
    {
        const { ctx } = makeDevCtx();
        const dev = new la.Device(ctx, { id: 'la', type: 'logic-analyzer', pins: [2], trigCh: 0 });
        dev.onCommand('arm');
        assert.equal(dev.getState().status, 'armed');
        dev.onCommand('stop');
        assert.equal(dev.getState().status, 'idle');
        dev.destroy();
    }
    // auto re-arm with a trigger: after done → armed again
    {
        const { ctx, leases } = makeDevCtx({ levels: { 3: false } });
        const dev = new la.Device(ctx, { id: 'la', type: 'logic-analyzer', pins: [3], trigCh: 0, durationMs: 1 });
        dev.onCommand('arm', { auto: true });
        dev.onPinState(3, { out: true, oe: true, cycles: 1000 });
        ctx.setCycles(1000 + 1000 * 160 + 1);
        dev.onBatch();
        const st = dev.getState();
        assert.equal(st.status, 'armed', 'auto re-armed after the capture');
        assert.equal(st.auto, true);
        assert.deepEqual(st.edges[0], [0, 1], 'finished waveform still readable');
        assert.ok(leases.armed.length >= 2, 'watch re-armed');
        dev.destroy();
    }
    // auto + immediate: the capture completes, auto just does not re-arm
    // (an immediate restart would overwrite the buffer unseen) — warn once
    {
        const { ctx, logs, leases } = makeDevCtx();
        const dev = new la.Device(ctx, { id: 'la', type: 'logic-analyzer', pins: [1], durationMs: 1 });
        dev.onCommand('arm', { auto: true });
        assert.equal(dev.getState().status, 'run');
        ctx.setCycles(1000 * 160 + 1);
        dev.onBatch();
        const st = dev.getState();
        assert.equal(st.status, 'done', 'capture itself finishes normally');
        assert.equal(st.auto, false);
        assert.ok(logs.some(([t, l]) => l === 'warn' && t.includes('auto re-arm')));
        assert.ok(leases.released >= 1);
        dev.destroy();
    }
});

test('logic-analyzer: buffer overflow freezes the capture flagged', () => {
    const { ctx } = makeDevCtx({ levels: { 1: true } });
    const dev = new la.Device(ctx, { id: 'la', type: 'logic-analyzer', pins: [1], durationMs: 1000 });
    dev.onCommand('arm');
    let cyc = 0;
    for (let i = 1; i <= la.MAX_EDGES + 1; i++) {
        cyc += 40; // 0.25 µs apart — raw unit feed, no scheduler in between
        dev.onPinState(1, { out: i & 1, oe: true, cycles: cyc });
        if (i % 500 === 0 && dev.status === 'done') break; // probe the field, not the full getState
    }
    const st = dev.getState();
    assert.equal(st.status, 'done');
    assert.equal(st.overflow, true);
    // the edge that trips the cap lands too, so at most one over
    assert.ok(st.totalEdges >= la.MAX_EDGES && st.totalEdges <= la.MAX_EDGES + 1,
        `totalEdges ${st.totalEdges} vs cap ${la.MAX_EDGES}`);
    dev.destroy();
});

test('logic-analyzer: onEmuReady resets waveform history', () => {
    const { ctx } = makeDevCtx({ levels: { 1: true } });
    const dev = new la.Device(ctx, { id: 'la', type: 'logic-analyzer', pins: [1], durationMs: 1 });
    dev.onCommand('arm');
    dev.onPinState(1, { out: false, oe: true, cycles: 1000 });
    ctx.setCycles(1000 * 160 + 1);
    dev.onBatch();
    assert.equal(dev.getState().status, 'done');
    dev.onEmuReady();
    const st = dev.getState();
    assert.equal(st.status, 'idle');
    assert.equal(st.totalEdges, 0);
    assert.equal(st.overflow, false);
    dev.destroy();
});

test('la-lib: view model — zoom anchors the cursor, clamps span and t0', () => {
    const st = { status: 'done', windowUs: 50000, capturedUs: 50000, edges: [[49000, 1]] };
    // zoom in 2× around t=25 ms: the anchor stays at the same fraction
    let v = laLib.zoomAt({ t0: 0, spanUs: 50000 }, 25000, 0.5, st);
    assert.equal(v.spanUs, 25000);
    assert.equal(v.t0, 12500);
    // zooming out past the data clamps at maxSpan (extent × 1.2)
    v = laLib.zoomAt(v, 20000, 50, st);
    assert.equal(v.spanUs, laLib.viewBounds(st).maxSpan);
    // t0 never scrolls past the bounds
    v = laLib.clampView({ t0: 1e9, spanUs: 1000 }, st);
    assert.ok(v.t0 <= laLib.viewBounds(st).tMax - 1000 + 1e-9);
    // the zoom floor
    v = laLib.zoomAt({ t0: 0, spanUs: 1 }, 0.5, 1e-9, st);
    assert.ok(v.spanUs >= laLib.MIN_SPAN_US);
    // an empty state still yields a zoomable (non-degenerate) view
    const b = laLib.viewBounds(null);
    assert.ok(b.maxSpan > 0 && b.tMax > b.tMin);
    assert.equal(laLib.clampView({ t0: 0, spanUs: 0 }, null).spanUs, laLib.MIN_SPAN_US);
});

test('la-lib: pulseAround finds the run containing the cursor', () => {
    const flat = [5, 1, 10, 0, 20, 1];
    assert.deepEqual(laLib.pulseAround(flat, null, 7),
        { level: 1, tStart: 5, tEnd: 10, widthUs: 5 });
    assert.deepEqual(laLib.pulseAround(flat, null, 3),
        { level: null, tStart: null, tEnd: 5, widthUs: null }, 'unknown head');
    assert.equal(laLib.pulseAround(flat, 0, 3).level, 0, 'initial level before the first edge');
    const open = laLib.pulseAround(flat, null, 25);
    assert.deepEqual(open, { level: 1, tStart: 20, tEnd: null, widthUs: null });
    assert.equal(laLib.pulseAround([8, -1], null, 9).level, -1, 'Z runs measurable');
});

test('la-lib: pwmOf derives period, duty and frequency from rising edges', () => {
    // 50% square wave, 10 µs period → 100 kHz
    const sq = [0, 1, 5, 0, 10, 1, 15, 0, 20, 1];
    const m = laLib.pwmOf(sq, 7);
    assert.equal(m.periodUs, 10);
    assert.equal(m.highUs, 5);
    assert.equal(m.duty, 0.5);
    assert.equal(m.freqHz, 100000);
    // hovering before the first rise still measures cycle 0
    assert.equal(laLib.pwmOf(sq, -5).periodUs, 10);
    // a high run with no fall inside the cycle = 100% duty
    const stuck = [0, 1, 10, 1, 20, 1];
    assert.equal(laLib.pwmOf(stuck, 12).duty, 1);
    // fewer than two rising edges: no cycle, no numbers
    assert.equal(laLib.pwmOf([0, 1, 5, 0], 2), null);
    assert.equal(laLib.pwmOf([], 2), null);
});

test('la-lib: levelChar and fmtHz formatting', () => {
    assert.equal(laLib.levelChar(1), '1');
    assert.equal(laLib.levelChar(0), '0');
    assert.equal(laLib.levelChar(-1), 'Z');
    assert.equal(laLib.levelChar(null), '?');
    assert.equal(laLib.fmtHz(156.25), '156.3 Hz');
    assert.equal(laLib.fmtHz(100000), '100.00 kHz');
    assert.equal(laLib.fmtHz(1.5e6), '1.500 MHz');
    assert.equal(laLib.fmtHz(0), '—');
});

test('logic-analyzer: capId bumps per capture (View zoom resets on it)', () => {
    const { ctx } = makeDevCtx({ levels: { 1: true } });
    const dev = new la.Device(ctx, { id: 'la', type: 'logic-analyzer', pins: [1], durationMs: 1 });
    assert.equal(dev.getState().capId, 0);
    dev.onCommand('arm');
    assert.equal(dev.getState().capId, 1);
    ctx.setCycles(1000 * 160 + 1);
    dev.onBatch(); // done
    dev.onCommand('arm'); // immediate again
    assert.equal(dev.getState().capId, 2);
    dev.onEmuReady();
    assert.equal(dev.getState().capId, 0, 'fresh emulator resets history identity');
    dev.destroy();
});
