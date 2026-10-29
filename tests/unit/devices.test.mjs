/*
 * Unit tests for the built-in device plugins (worker side, no emulator):
 * electrical semantics — button idle/pressed levels (an inverted activeLow
 * was a real M1 bug), LED onPinState mapping, toggle switch driving.
 * Run: node --test tests/unit/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as led from '../../peris/devices/led.js';
import * as button from '../../peris/devices/button.js';
import * as toggle from '../../peris/devices/toggle-switch.js';
import { validateDeviceModule } from '../../build/core/types.js';

/** Recording stub for the runtime ctx handed to device constructors. */
function makeCtx() {
    const inputs = [];
    let dirty = 0;
    return {
        inputs, dirty: () => dirty,
        ctx: {
            id: 't', chip: 'esp32c3', gpioCount: 22,
            setPinInput: (pin, high) => inputs.push([pin, high]),
            readMem: () => new Uint8Array(0),
            readU32: () => 0,
            cycles: () => 0,
            subscribe: () => {}, unsubscribe: () => {},
            markDirty: () => { dirty++; },
            log: () => {},
        },
    };
}

test('all device modules pass meta validation', () => {
    for (const mod of [led, button, toggle]) {
        assert.equal(validateDeviceModule(mod), null, mod.Device.typeId);
    }
});

test('button active-low: idle HIGH, pressed LOW (pull-up wiring)', () => {
    const { ctx, inputs } = makeCtx();
    const b = new button.Device(ctx, { id: 'b', type: 'button', pin: 3, activeLow: true });
    assert.deepEqual(inputs, [[3, true]], 'constructor drives idle HIGH');
    b.onCommand('press');
    assert.deepEqual(inputs.slice(-1), [[3, false]]);
    b.onCommand('release');
    assert.deepEqual(inputs.slice(-1), [[3, true]]);
    assert.deepEqual(b.getState(), { pressed: false });
    b.destroy();
    assert.deepEqual(inputs.slice(-1), [[3, true]], 'destroy restores idle');
});

test('button active-high: idle LOW, pressed HIGH', () => {
    const { ctx, inputs } = makeCtx();
    const b = new button.Device(ctx, { id: 'b', type: 'button', pin: 2, activeLow: false });
    assert.deepEqual(inputs, [[2, false]]);
    b.onCommand('press');
    assert.deepEqual(inputs.slice(-1), [[2, true]]);
});

test('button re-drives its level onEmuReady (fresh emulator instance)', () => {
    const { ctx, inputs } = makeCtx();
    const b = new button.Device(ctx, { id: 'b', type: 'button', pin: 3, activeLow: true });
    b.onCommand('press');
    inputs.length = 0;
    b.onEmuReady();
    assert.deepEqual(inputs, [[3, false]], 'stays pressed across emulator reload');
});

test('led maps pin state to on/off with invert support', () => {
    const { ctx } = makeCtx();
    const l = new led.Device(ctx, { id: 'l', type: 'led', pin: 8, invert: false });
    l.onPinState(8, { out: true, oe: true, cycles: 0 });
    assert.deepEqual(l.getState(), { on: true, driven: true });
    l.onPinState(8, { out: false, oe: true, cycles: 0 });
    assert.deepEqual(l.getState(), { on: false, driven: true });
    l.onPinState(8, { out: false, oe: false, cycles: 0 });
    assert.deepEqual(l.getState(), { on: false, driven: false }, 'not driven = off');

    const li = new led.Device(makeCtx().ctx, { id: 'l2', type: 'led', pin: 9, invert: true });
    li.onPinState(9, { out: false, oe: true, cycles: 0 });
    assert.deepEqual(li.getState(), { on: true, driven: true }, 'active-low LED lights on 0');
});

test('toggle switch drives level and survives emulator reload', () => {
    const { ctx, inputs } = makeCtx();
    const sw = new toggle.Device(ctx, { id: 's', type: 'toggle-switch', pin: 5, activeLow: false, initial: false });
    assert.deepEqual(inputs, [[5, false]]);
    sw.onCommand('toggle');
    assert.deepEqual(sw.getState(), { on: true });
    assert.deepEqual(inputs.slice(-1), [[5, true]]);
    inputs.length = 0;
    sw.onEmuReady();
    assert.deepEqual(inputs, [[5, true]], 're-drives ON after reload');
    sw.onCommand('set', { on: false });
    assert.deepEqual(inputs.slice(-1), [[5, false]]);
});
