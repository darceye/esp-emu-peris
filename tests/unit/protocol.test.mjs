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
 * Run: node --test <files> (see package.json — explicit list for Git Bash)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FineScheduler, SLEEP_FACTOR, clampBatch } from '../../build/core/scheduler.js';
import { validateDeviceModule } from '../../build/core/types.js';
import { esp32c3 as C3_MMIO } from '../../build/core/mmio/c3.js';
import * as i2c from '../../peris/devices/bitbang-i2c-slave.js';
import * as ir from '../../peris/devices/ir-nec.js';
import * as i2cLib from '../../peris/devices/i2c-lib.js';
import * as necLib from '../../peris/devices/nec-lib.js';
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

/** Fake runtime ctx with scheduler-lease + input recording. */
function makeDevCtx({ regs } = {}) {
    const inputs = [];
    const leases = { armed: [], fine: [], released: 0 };
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
            subscribe: () => {}, unsubscribe: () => {},
            markDirty: () => { dirty++; },
            log: () => {},
    };
    return { ctx, inputs, leases, dirty: () => dirty };
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
// shared bus wiring (v1 conflict rule + the sharedBus exception)

import { PerisRuntime } from '../../build/core/runtime.js';

test('runtime: sharedBus devices share pins; non-bus devices still conflict', async () => {
    const rt = new PerisRuntime();
    const msgs = [];
    rt.post = (m) => msgs.push(m);
    rt.registry = {
        has: (t) => ['led', 'i2c'].includes(t),
        meta: (t) => (t === 'led' ? ledMod.Device : i2c.Device),
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
