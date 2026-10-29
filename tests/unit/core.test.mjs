/*
 * Unit tests for core logic (no emulator, no DOM): sigbus bit dispatch,
 * chips tables, mmio helpers, config normalisation + module validation.
 * Run: node --test tests/unit/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sigbus } from '../../peris/core/sigbus.js';
import { gpioCount, validPins, absentPins } from '../../peris/core/chips.js';
import { mmioFor, funcOutSelAddr, ioMuxAddr } from '../../peris/core/mmio.js';
import { normaliseConfig, validateDeviceModule } from '../../peris/core/types.js';

// ---- sigbus ----

/** Fake emulator: gpio words scripted per sample call. */
class FakeEmu {
    constructor(state = [0, 0, 0, 0]) { this.state = state; this.cyc = 0; this.inputs = []; }
    gpio_state() { return this.state; }
    gpio_set_input(pin, high) { this.inputs.push([pin, high]); }
    read_memory() { return new Uint8Array(4); }
    cycles() { return this.cyc; }
}

test('sigbus dispatches only changed pins to subscribers', () => {
    const emu = new FakeEmu([0, 0, 0, 0]);
    const bus = new Sigbus(emu);
    const seen = [];
    const dev = { onPinState: (pin, s) => seen.push([pin, s.out, s.oe]) };
    bus.subscribe(() => dev, [8, 9]);

    emu.state = [1 << 8, 0, (1 << 8) | (1 << 9), 0]; // pin8 out+oe flip, pin9 oe flips
    bus.sample();
    // pin8: out 0->1, oe 0->1 (one notification, union mask);
    // pin9: out unchanged 0, oe 0->1 (still a change — it is now driven)
    assert.deepEqual(seen, [[8, true, true], [9, false, true]]);

    emu.state = [(1 << 8) | (1 << 9), 0, (1 << 8) | (1 << 9), 0]; // pin9 out 0->1
    bus.sample();
    assert.deepEqual(seen.slice(-1), [[9, true, true]]);

    bus.sample(); // no change
    assert.equal(seen.length, 3);
});

test('sigbus constructor-time getter resolves instance lazily', () => {
    const emu = new FakeEmu([0, 0, 0, 0]);
    const bus = new Sigbus(emu);
    let dev = null; // "instance" registered after subscribe, like the runtime
    bus.subscribe(() => dev, [3]);
    emu.state = [1 << 3, 0, 1 << 3, 0];
    bus.sample(); // dev still null: must not throw
    dev = { onPinState: (pin, s) => { throw new Error('should not run: no new edge'); } };
    bus.sample(); // no further change: not called
});

test('sigbus dispatches high-word pins (>=32)', () => {
    const emu = new FakeEmu([0, 0, 0, 0]);
    const bus = new Sigbus(emu);
    const seen = [];
    bus.subscribe(() => ({ onPinState: (pin, s) => seen.push([pin, s.out]) }), [33]);
    emu.state = [0, 1 << 1, 0, 1 << 1];
    bus.sample();
    assert.deepEqual(seen, [[33, true]]);
});

test('sigbus setInput forwards to emulator', () => {
    const emu = new FakeEmu();
    const bus = new Sigbus(emu);
    bus.setInput(4, false);
    bus.setInput(4, true);
    assert.deepEqual(emu.inputs, [[4, false], [4, true]]);
});

// ---- chips ----

test('chips tables: counts, absent pins, valid pins', () => {
    assert.equal(gpioCount('esp32c3'), 22);
    assert.deepEqual([...absentPins('esp32s3')], [22, 23, 24, 25]);
    const s3 = validPins('esp32s3');
    assert.ok(!s3.includes(22) && s3.includes(21) && s3.includes(26));
    assert.equal(validPins('esp32c3').length, 22);
    // unknown chip falls back to 32 pins
    assert.equal(gpioCount('nope'), 32);
});

// ---- mmio ----

test('mmio c3: addresses match M0-verified values', () => {
    const m = mmioFor('esp32c3');
    assert.ok(m);
    assert.equal(m.ledc.ch(0).dutyR, 0x60019010);
    assert.equal(m.ledc.ch(1).dutyR, 0x60019024); // stride 0x14
    assert.equal(m.rmt.memBase, 0x60016400);
    assert.equal(m.rmt.memWordsPerChannel, 48);
    assert.equal(funcOutSelAddr(m, 9), 0x60004000 + 0x554 + 36);
    assert.equal(ioMuxAddr(m, 9), 0x60009028);
    assert.equal(ioMuxAddr(m, 12), null); // only GPIO0..11 contiguous
    assert.equal(mmioFor('esp32c6'), null); // not yet mapped
});

// ---- config helpers ----

/** Class-shaped stub (validateDeviceModule requires a constructor). */
class StubMeta {
    static typeId = 'stub';
    static title = 'Stub';
    static defaultConfig = { name: 'S', pin: 5, keep: true };
    static configSchema = [
        { key: 'pin', label: 'GPIO pin', type: 'pin' },
        { key: 'name', label: 'Label', type: 'text' },
    ];
    static pins(cfg) { return [cfg.pin]; }
}
const metaStub = StubMeta;

test('normaliseConfig merges defaults and strips unknown keys', () => {
    const cfg = normaliseConfig(metaStub, { id: 'x', type: 'stub', pin: 9, bogus: 1 });
    assert.equal(cfg.pin, 9);
    assert.equal(cfg.keep, true); // default retained
    assert.equal('bogus' in cfg, false);
    assert.equal(cfg.id, 'x');
});

test('validateDeviceModule rejects missing static pins (real M1 bug class)', () => {
    assert.equal(validateDeviceModule({ Device: StubMeta }), null);
    class NoPins {
        static typeId = 'stub';
        static title = 'Stub';
        static defaultConfig = {};
    }
    assert.match(validateDeviceModule({ Device: NoPins }), /pins\(cfg\) is required/);
    assert.match(validateDeviceModule({}), /does not export a Device class/);
    class NoId {
        static title = 'S';
        static defaultConfig = {};
        static pins() { return []; }
    }
    assert.match(validateDeviceModule({ Device: NoId }), /typeId/);
});
