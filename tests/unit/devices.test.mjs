/*
 * Unit tests for the built-in device plugins (worker side, no emulator):
 * electrical semantics — button idle/pressed levels (an inverted activeLow
 * was a real M1 bug), LED onPinState mapping, toggle switch driving —
 * plus the row-UI contract (rowIcon, V/G pull chips) and export naming.
 * Run: node --test <files> (see package.json — explicit list for Git Bash)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as led from '../../peris/devices/led.js';
import * as button from '../../peris/devices/button.js';
import * as toggle from '../../peris/devices/toggle-switch.js';
import * as touch from '../../peris/devices/touch-button.js';
import { validateDeviceModule } from '../../build/core/types.js';
import { rowChips } from '../../build/ui/config-editor.js';
import { exportFileName } from '../../build/ui/peris-panel.js';

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
    for (const mod of [led, button, toggle, touch]) {
        assert.equal(validateDeviceModule(mod), null, mod.Device.typeId);
    }
});

test('all built-in Views implement the row icon API', () => {
    for (const mod of [led, button, toggle, touch]) {
        assert.equal(typeof mod.View.prototype.rowIcon, 'function', mod.Device.typeId);
    }
});

test('rowChips: GPIO number + V/G pull char from schema chip flags', () => {
    // input devices: activeLow checked → idle pulled up to VCC ('V')
    const c1 = rowChips(button.Device, { id: 'b', type: 'button', pin: 3, activeLow: true });
    assert.equal(c1.pinKey, 'pin');
    assert.equal(c1.pin, 3);
    assert.equal(c1.pullKey, 'activeLow');
    assert.equal(c1.pullChar, 'V');
    const c2 = rowChips(button.Device, { id: 'b', type: 'button', pin: 4, activeLow: false });
    assert.equal(c2.pullChar, 'G');
    assert.equal(c2.pin, 4);

    // touch-button inherits button's schema, so it carries the chip too
    assert.equal(rowChips(touch.Device, { pin: 10, activeLow: true }).pullChar, 'V');

    // output device: pin chip only, no pull badge
    const c3 = rowChips(led.Device, { id: 'l', type: 'led', pin: 8 });
    assert.equal(c3.pin, 8);
    assert.equal(c3.pullKey, null);
    assert.equal(c3.pullChar, null);

    // GPIO 0 is a valid pin value (must not be falsy-dropped)
    assert.equal(rowChips(led.Device, { pin: 0 }).pin, 0);

    // pullWhenChecked:'low' inverts the badge mapping
    const inv = {
        ...toggle.Device,
        configSchema: [
            { key: 'pin', label: 'GPIO pin', type: 'pin' },
            { key: 'activeHigh', label: 'Active high', type: 'checkbox', chip: 'pull', pullWhenChecked: 'low' },
        ],
    };
    assert.equal(rowChips(inv, { pin: 2, activeHigh: true }).pullChar, 'G');
    assert.equal(rowChips(inv, { pin: 2, activeHigh: false }).pullChar, 'V');

    // schema without a pin field → no pin chip
    const noPin = { ...led.Device, configSchema: [{ key: 'name', label: 'Label', type: 'text' }] };
    assert.equal(rowChips(noPin, { name: 'x' }).pinKey, null);
});

test('exportFileName: custom base wins, sanitised, single .json suffix', () => {
    const d = new Date('2026-10-30T00:00:00Z');
    assert.equal(exportFileName('my-wiring', 'esp32c3', d), 'my-wiring.json');
    assert.equal(exportFileName('my-wiring.json', 'esp32c3', d), 'my-wiring.json', 'no double suffix');
    assert.equal(exportFileName('my wiring.JSON', 'esp32c3', d), 'my wiring.json');
    // Windows-illegal characters stripped
    assert.equal(exportFileName('a/b\\c:d*e?f"g<h>i|.json', 'esp32c3', d), 'abcdefghi.json');
    // empty / whitespace-only / stripped-to-empty → auto name
    assert.equal(exportFileName('', 'esp32c3', d), 'peris-esp32c3-2026-10-30.json');
    assert.equal(exportFileName('   ', 'esp32c3', d), 'peris-esp32c3-2026-10-30.json');
    assert.equal(exportFileName('???.json', 'esp32s3', d), 'peris-esp32s3-2026-10-30.json');
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
