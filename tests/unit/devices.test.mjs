/*
 * Unit tests for the built-in device plugins (worker side, no emulator):
 * electrical semantics — button idle/pressed levels (an inverted activeLow
 * was a real M1 bug), LED onPinState mapping, toggle switch driving —
 * plus the row-UI contract (rowIcon, V/G pull chips), export naming, the
 * M2 register-level LEDC devices (duty decode, wiring discovery,
 * auto-binding) and the M3 WS2812 device (RMT RAM decode, tail alignment,
 * TX-busy gate, layouts) against fake MMIO.
 * Run: node --test <files> (see package.json — explicit list for Git Bash)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as led from '../../peris/devices/led.js';
import * as button from '../../peris/devices/button.js';
import * as toggle from '../../peris/devices/toggle-switch.js';
import * as touch from '../../peris/devices/touch-button.js';
import * as pwmLed from '../../peris/devices/pwm-led.js';
import * as rgbLed from '../../peris/devices/rgb-led.js';
import * as ws2812 from '../../peris/devices/ws2812.js';
import * as ledcLib from '../../peris/devices/ledc-lib.js';
import * as wsLib from '../../peris/devices/ws2812-lib.js';
import { validateDeviceModule } from '../../build/core/types.js';
import { esp32c3 as C3_MMIO } from '../../build/core/mmio/c3.js';
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
    for (const mod of [led, button, toggle, touch, pwmLed, rgbLed, ws2812]) {
        assert.equal(validateDeviceModule(mod), null, mod.Device.typeId);
    }
});

test('all built-in Views implement the row icon API', () => {
    for (const mod of [led, button, toggle, touch, pwmLed, rgbLed, ws2812]) {
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

// ---------------------------------------------------------------------------
// M2 register-level devices (LEDC) — fake MMIO, real C3 address table.
// Register semantics (DUTY_R = counts<<4, conf0 bit2 = sig_out_en,
// timer DUTY_RES bits[3:0]) verified live in M0, see docs/FEASIBILITY.md.

/** Fake register-level ctx backed by a Map<addr, u32>; ctx.mmio is the real
 * C3 table (the runtime resolves it via mmioFor(chip)). readMem assembles
 * little-endian bytes from the same map (RMT channel RAM reads). */
function makeMmioCtx() {
    const regs = new Map();
    let dirty = 0;
    return {
        regs, dirty: () => dirty,
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
            cycles: () => 0,
            subscribe: () => {}, unsubscribe: () => {},
            markDirty: () => { dirty++; },
            log: () => {},
        },
    };
}

/** Write one LEDC channel's register state (conf0/timer/dutyR). */
function setLedcChannel(regs, ch, { enabled = true, res = 13, counts = 0, timer = 0 } = {}) {
    const r = C3_MMIO.ledc.ch(ch);
    regs.set(r.conf0, (timer & 3) | (enabled ? 0x4 : 0));
    regs.set(C3_MMIO.ledc.timer(timer).conf, res & 0xf);
    regs.set(r.dutyR, (counts << C3_MMIO.ledc.dutyShift) >>> 0);
}

/** Route a pad to a GPIO-matrix output signal (FUNCn_OUT_SEL low 9 bits). */
function routePad(regs, pin, signal) {
    regs.set(C3_MMIO.gpio.funcOutSelBase + C3_MMIO.gpio.funcOutSelStride * pin, signal & 0x1ff);
}

test('parseChannel: auto passthrough, numeric strings, out-of-range → auto', () => {
    assert.equal(ledcLib.parseChannel('auto', 6), 'auto');
    assert.equal(ledcLib.parseChannel('AUTO', 6), 'auto');
    assert.equal(ledcLib.parseChannel(3, 6), 3);
    assert.equal(ledcLib.parseChannel('3', 6), 3);
    assert.equal(ledcLib.parseChannel(0, 6), 0);
    assert.equal(ledcLib.parseChannel(6, 6), 'auto', 'count is exclusive');
    assert.equal(ledcLib.parseChannel('1.5', 6), 'auto');
    assert.equal(ledcLib.parseChannel(undefined, 6), 'auto');
    assert.equal(ledcLib.parseChannel(null, 6), 'auto');
});

test('readLedcChannel: DUTY_R decode across resolution and enable state', () => {
    const { ctx, regs } = makeMmioCtx();
    // M0 measured layout: half(4096)/13-bit → DUTY_R = 0x10000
    setLedcChannel(regs, 0, { counts: 4096 });
    let st = ledcLib.readLedcChannel(ctx, 0);
    assert.equal(st.enabled, true);
    assert.equal(st.resolution, 13);
    assert.ok(Math.abs(st.fraction - 4096 / 8191) < 1e-6, 'half duty ≈ 0.5');
    setLedcChannel(regs, 0, { counts: 8191 });
    st = ledcLib.readLedcChannel(ctx, 0);
    assert.ok(st.fraction > 0.9998, 'max duty ≈ 1');
    // disabled channel reads 0 even with a duty latched
    setLedcChannel(regs, 0, { counts: 4096, enabled: false });
    st = ledcLib.readLedcChannel(ctx, 0);
    assert.equal(st.fraction, 0);
    // 10-bit timer: full-scale is 1023, not 8191
    setLedcChannel(regs, 1, { counts: 512, res: 10 });
    st = ledcLib.readLedcChannel(ctx, 1);
    assert.ok(Math.abs(st.fraction - 512 / 1023) < 1e-6);
    // timer_sel routes the resolution lookup to another timer
    setLedcChannel(regs, 2, { counts: 512, res: 10, timer: 1 });
    regs.set(C3_MMIO.ledc.timer(1).conf, 10);
    regs.set(C3_MMIO.ledc.timer(0).conf, 13);
    st = ledcLib.readLedcChannel(ctx, 2);
    assert.equal(st.resolution, 10);
});

test('discoverLedcPins: matrix routing scan (LEDC only, plain GPIO ignored)', () => {
    const { ctx, regs } = makeMmioCtx();
    routePad(regs, 9, C3_MMIO.signals.ledcCh0);
    routePad(regs, 6, C3_MMIO.signals.ledcCh1);
    routePad(regs, 7, C3_MMIO.signals.ledcCh2);
    routePad(regs, 8, 0x100);   // plain GPIO output
    routePad(regs, 5, 0x33);    // RMT — not LEDC
    assert.deepEqual(
        [...ledcLib.discoverLedcPins(ctx)].sort((a, b) => a[0] - b[0]),
        [[0, 9], [1, 6], [2, 7]]);
    // no table → empty, devices must idle
    assert.equal(ledcLib.discoverLedcPins({ ...ctx, mmio: null }).size, 0);
});

test('pwm-led: auto-binds the first routed channel and tracks its duty', () => {
    const { ctx, regs, dirty } = makeMmioCtx();
    const dev = new pwmLed.Device(ctx, { id: 'p', type: 'pwm-led', channel: 'auto' });
    dev.onBatch();
    assert.deepEqual(dev.getState(), { duty: 0, channel: null, pin: null, wired: false },
        'unrouted firmware: waiting state');
    routePad(regs, 9, C3_MMIO.signals.ledcCh0);
    setLedcChannel(regs, 0, { counts: 4096 });
    dev.onBatch();
    assert.deepEqual(dev.getState(), { duty: 0.5, channel: 0, pin: 9, wired: true });
    const d1 = dirty();
    dev.onBatch(); // same registers → no state push
    assert.equal(dirty(), d1, 'unchanged duty does not re-mark dirty');
    setLedcChannel(regs, 0, { counts: 8191 });
    dev.onBatch();
    assert.equal(dev.getState().duty, 1);
    assert.ok(dirty() > d1);
    // firmware rewires ch0 away → auto mode releases the binding
    regs.delete(C3_MMIO.gpio.funcOutSelBase + C3_MMIO.gpio.funcOutSelStride * 9);
    routePad(regs, 2, C3_MMIO.signals.ledcCh3);
    for (let i = 0; i < ledcLib.LEDC_RESCAN_BATCHES; i++) dev.onBatch();
    assert.deepEqual(dev.getState(), { duty: 0, channel: 3, pin: 2, wired: false },
        'rebinds to the next routed channel (ch3 has no registers written)');
});

test('pwm-led: manual channel works without any routing (duty still read)', () => {
    const { ctx, regs } = makeMmioCtx();
    const dev = new pwmLed.Device(ctx, { id: 'p', type: 'pwm-led', channel: '3' });
    setLedcChannel(regs, 3, { counts: 2048 });
    dev.onBatch();
    const st = dev.getState();
    assert.equal(st.channel, 3);
    assert.equal(st.pin, null, 'never routed → no pin');
    assert.ok(Math.abs(st.duty - 2048 / 8191) < 0.001);
    // fresh emulator: manual binding survives, discovery restarts
    dev.onEmuReady();
    assert.deepEqual(dev.getState(), { duty: 0, channel: 3, pin: null, wired: false });
});

test('rgb-led: auto-assigns lowest routed channels R→G→B, manual roles excluded', () => {
    const { ctx, regs } = makeMmioCtx();
    routePad(regs, 9, C3_MMIO.signals.ledcCh0);
    routePad(regs, 6, C3_MMIO.signals.ledcCh1);
    routePad(regs, 7, C3_MMIO.signals.ledcCh2);
    setLedcChannel(regs, 0, { counts: 4096 });  // R ≈ half
    setLedcChannel(regs, 1, { counts: 8191 });  // G full
    setLedcChannel(regs, 2, { counts: 0 });     // B off
    const dev = new rgbLed.Device(ctx, { id: 'rgb', type: 'rgb-led' });
    dev.onBatch();
    let st = dev.getState();
    assert.deepEqual(st.channels, { r: 0, g: 1, b: 2 });
    assert.deepEqual(st.pins, { r: 9, g: 6, b: 7 });
    assert.equal(st.r, 0.5);
    assert.equal(st.g, 1);
    assert.equal(st.b, 0);
    assert.equal(st.wired, true);

    // manual red on ch2 → auto roles take the remaining lowest channels
    const dev2 = new rgbLed.Device(ctx, { id: 'rgb2', type: 'rgb-led', channelR: 2 });
    dev2.onBatch();
    st = dev2.getState();
    assert.deepEqual(st.channels, { r: 2, g: 0, b: 1 },
        'auto roles skip the manually claimed channel');
    assert.equal(st.pins.r, 7);
});

test('rgb-led: mixed duty changes push once per state change', () => {
    const { ctx, regs, dirty } = makeMmioCtx();
    routePad(regs, 9, C3_MMIO.signals.ledcCh0);
    setLedcChannel(regs, 0, { counts: 8191 });
    const dev = new rgbLed.Device(ctx, { id: 'rgb', type: 'rgb-led' });
    dev.onBatch();
    assert.equal(dev.getState().r, 1);
    const d1 = dirty();
    dev.onBatch();
    assert.equal(dirty(), d1, 'unchanged channels stay quiet');
    setLedcChannel(regs, 0, { counts: 0 });
    dev.onBatch();
    assert.deepEqual(
        [dev.getState().r, dev.getState().g, dev.getState().b], [0, 0, 0]);
    assert.ok(dirty() > d1);
});

test('lerpStep/mixHex: smooth-rendering math (pure)', () => {
    // one time-constant of smoothing covers 1-1/e of the gap
    assert.ok(Math.abs(ledcLib.lerpStep(0, 1, 90, 90) - (1 - Math.exp(-1))) < 1e-9);
    assert.equal(ledcLib.lerpStep(0.4, 0.4, 100, 90), 0.4, 'already at target');
    const v = ledcLib.lerpStep(0, 1, 10000, 90);
    assert.ok(v > 0.9999, 'long frame converges');
    assert.equal(ledcLib.mixHex(['#ff0000', '#00ff00'], [1, 1]), '#ffff00');
    assert.equal(ledcLib.mixHex(['#ff0000', '#00ff00'], [0, 0]), '#000000');
    assert.equal(ledcLib.mixHex(['#ffffff'], [0.5]), '#808080');
    assert.equal(ledcLib.quantiseDuty(4096 / 8191), 0.5);
});

// ---------------------------------------------------------------------------
// M3 WS2812 (RMT channel RAM) — fake MMIO, real C3 address table.
// The write model mirrors the emulator measured in the M3 probe (and real
// hardware): the copy encoder emits ONE RMT word per WS2812 bit (d0/l0 =
// high run, d1/l1 = low run), words land sequentially at k mod 48 and wrap,
// the reset word (>=300 low) is followed by ONE all-zero terminator word —
// so after a transmission the RAM holds reset + terminator + the last 46
// bits of the frame. See docs/FEASIBILITY.md.

/** Build the post-transmission channel-0 RAM for a frame of LED colours. */
function buildWsRam(colours) {
    const words = new Uint32Array(48);
    let k = 0;
    const put = (w) => { words[k % 48] = w; k++; };
    for (const rgb of colours) {
        const grb = [(rgb >> 8) & 255, (rgb >> 16) & 255, rgb & 255]; // wire order
        for (let b = 0; b < 24; b++) {
            const one = (grb[b >> 3] >> (7 - (b & 7))) & 1;
            put((one ? 8 : 4) | (1 << 15) | ((one ? 5 : 8) << 16));
        }
    }
    put(600 | (1 << 16)); // reset: 60 us low, then a 1-tick low
    put(0);               // transmit terminator (all-zero word)
    return words;
}

/** Load a RAM image into the fake ctx's channel-n memory (+status). */
function setRmtRam(regs, ch, words, busy = false) {
    const r = C3_MMIO.rmt.ch(ch);
    for (let w = 0; w < words.length; w++) regs.set(r.mem + 4 * w, words[w] >>> 0);
    regs.set(r.status, busy ? 1 << 9 : 0);
}

test('decodeWs2812: single-LED frame decodes completely', () => {
    const dec = wsLib.decodeWs2812(buildWsRam([0x0000ff]));
    assert.equal(dec.bits, 24);
    assert.deepEqual(dec.slots, [[0x00, 0x00, 0xff]], 'wire GRB of pure blue');
    assert.deepEqual(wsLib.slotsToRgb(dec.slots, 'grb'), [[0, 0, 255]]);
    // RGB order mapping: wire bytes taken as R,G,B
    assert.deepEqual(wsLib.slotsToRgb([[1, 2, 3]], 'rgb'), [[1, 2, 3]]);
    assert.deepEqual(wsLib.slotsToRgb([[1, 2, 3]], 'grb'), [[2, 1, 3]]);
});

test('decodeWs2812: 8-LED frame keeps only the 46-bit tail, realigned', () => {
    // uniform colour: both surviving slots decode to the same LED
    const dec = wsLib.decodeWs2812(buildWsRam(Array(8).fill(0x333333)));
    assert.equal(dec.bits, 46, '48-word RAM minus reset and terminator');
    assert.equal(dec.slots.length, 2);
    assert.deepEqual(dec.slots, [[0x33, 0x33, 0x33], [0x33, 0x33, 0x33]]);
});

test('decodeWs2812: per-LED tail alignment (last intact, second-to-last loses 2 G bits)', () => {
    // the firmware grad burst: all red, n-2 green, n-1 blue
    const colours = Array(8).fill(0xff0000);
    colours[7] = 0x0000ff;
    colours[6] = 0x00ff00;
    const dec = wsLib.decodeWs2812(buildWsRam(colours));
    assert.deepEqual(wsLib.slotsToRgb(dec.slots, 'grb'), [[0, 0x3f, 0], [0, 0, 255]],
        'slot1 = LED7 blue; slot0 = LED6 with G=0x3f (two head bits lost to the RAM wrap)');
});

test('decodeWs2812 rejects RAM without a completed frame', () => {
    assert.equal(wsLib.decodeWs2812(new Uint32Array(48)), null, 'all zero');
    const words = buildWsRam([0xff00ff]);
    words[25] = 0x00088004; // overwrite the terminator (reset sits at word 24)
    assert.equal(wsLib.decodeWs2812(words), null, 'reset without terminator');
    const bits = new Uint32Array(48).fill(0x00088004);
    assert.equal(wsLib.decodeWs2812(bits), null, 'bits but no reset');
});

test('readRmtWords/rmtTxBusy: channel RAM and STATUS state decode', () => {
    const { ctx, regs } = makeMmioCtx();
    const words = buildWsRam([0xff0000]);
    setRmtRam(regs, 1, words);
    assert.deepEqual(Array.from(wsLib.readRmtWords(ctx, 1)), Array.from(words));
    assert.equal(wsLib.rmtTxBusy(ctx, 1), false);
    setRmtRam(regs, 1, words, true);
    assert.equal(wsLib.rmtTxBusy(ctx, 1), true, 'RMT_STATE bits[11:9] != 0');
});

test('discoverRmtPins: matrix routing scan (RMT only)', () => {
    const { ctx, regs } = makeMmioCtx();
    routePad(regs, 4, C3_MMIO.signals.rmtCh0);
    routePad(regs, 5, C3_MMIO.signals.rmtCh1);
    routePad(regs, 9, C3_MMIO.signals.ledcCh0); // LEDC — ignored
    routePad(regs, 8, 0x100);                   // plain GPIO — ignored
    assert.deepEqual([...wsLib.discoverRmtPins(ctx)].sort((a, b) => a[0] - b[0]), [[0, 4], [1, 5]]);
    assert.equal(wsLib.discoverRmtPins({ ...ctx, mmio: null }).size, 0, 'no table → empty');
});

test('ws2812 device: auto-binds ch0, decodes tail-aligned, quiet when unchanged', () => {
    const { ctx, regs, dirty } = makeMmioCtx();
    const dev = new ws2812.Device(ctx, { id: 'w', type: 'ws2812' });
    dev.onBatch();
    assert.deepEqual(dev.getState().leds, Array.from({ length: 8 }, () => [0, 0, 0]));
    assert.equal(dev.getState().channel, null, 'waiting state before routing');

    routePad(regs, 4, C3_MMIO.signals.rmtCh0);
    const colours = Array(8).fill(0xff0000);
    colours[7] = 0x0000ff;
    colours[6] = 0x00ff00;
    setRmtRam(regs, 0, buildWsRam(colours));
    dev.onBatch();
    let st = dev.getState();
    assert.equal(st.channel, 0);
    assert.equal(st.pin, 4);
    assert.equal(st.visible, 2);
    assert.equal(st.frames, 1);
    assert.deepEqual(st.leds.slice(-2), [[0, 0x3f, 0], [0, 0, 255]]);
    assert.deepEqual(st.leds.slice(0, 6), Array.from({ length: 6 }, () => [0, 0, 0]),
        'head LEDs stay unknown/black');

    const d1 = dirty();
    dev.onBatch(); // identical RAM → no re-markDirty
    assert.equal(dirty(), d1);
    setRmtRam(regs, 0, buildWsRam(Array(8).fill(0x111111)));
    dev.onBatch();
    st = dev.getState();
    assert.equal(st.frames, 2);
    assert.deepEqual(st.leds.slice(-2), [[0x11, 0x11, 0x11], [0x11, 0x11, 0x11]]);
    assert.ok(dirty() > d1);
});

test('ws2812 device: busy TX gate, manual channel, count trim, emu reset', () => {
    const { ctx, regs } = makeMmioCtx();
    setRmtRam(regs, 0, buildWsRam(Array(8).fill(0x00ff00)), true);
    const dev = new ws2812.Device(ctx, { id: 'w', type: 'ws2812', channel: '0' });
    dev.onBatch();
    assert.equal(dev.getState().frames, 0, 'in-flight transmission is not decoded');
    setRmtRam(regs, 0, buildWsRam(Array(8).fill(0x00ff00)));
    dev.onBatch();
    assert.equal(dev.getState().frames, 1, 'idle after TX → decoded');
    assert.equal(dev.getState().channel, 0);

    // count=1 keeps only the last LED slot
    const dev1 = new ws2812.Device(ctx, { id: 'w1', type: 'ws2812', channel: 0, count: 1 });
    dev1.onBatch();
    assert.deepEqual(dev1.getState().leds, [[0x00, 0xff, 0x00]]);
    assert.equal(dev1.getState().visible, 1);

    // fresh emulator: binding survives (manual), frame state resets
    dev.onEmuReady();
    assert.deepEqual(dev.getState(), {
        leds: Array.from({ length: 8 }, () => [0, 0, 0]),
        visible: 0, channel: 0, pin: null, frames: 0,
    });
});

test('countFrom: ints and numeric strings, clamped to 1..64', () => {
    assert.equal(ws2812.countFrom(8), 8);
    assert.equal(ws2812.countFrom('12'), 12);
    assert.equal(ws2812.countFrom(1), 1);
    assert.equal(ws2812.countFrom(0), 1);
    assert.equal(ws2812.countFrom(999), 64);
    assert.equal(ws2812.countFrom(undefined), 8);
});

test('ledPositions: layouts are complete and inside the canvas', () => {
    for (const [layout, count, columns] of [['strip', 8, 8], ['ring', 12, 8], ['matrix', 16, 8], ['matrix', 12, 5]]) {
        const g = wsLib.ledPositions(layout, count, columns, 300);
        assert.equal(g.dots.length, count, layout);
        for (const d of g.dots) {
            assert.ok(d.x - d.r >= 0 && d.x + d.r <= g.w && d.y - d.r >= 0 && d.y + d.r <= g.h,
            `${layout} dot inside canvas`);
        }
    }
    const m = wsLib.ledPositions('matrix', 16, 8, 300);
    assert.ok(m.w > m.h, '8-column 16-LED matrix is wider than tall');
    assert.ok(Math.abs((m.dots[1].x - m.dots[0].x) - (m.dots[9].x - m.dots[8].x)) < 1e-9, 'grid spacing');
    assert.ok(m.dots[8].y > m.dots[0].y, 'second row is below the first');
});

test('shapeLevel: brightness cap and gamma (pure)', () => {
    assert.equal(wsLib.shapeLevel(0.8), 0.8, 'identity defaults');
    assert.equal(wsLib.shapeLevel(0.8, 0.5), 0.4, 'cap scales linearly');
    assert.ok(Math.abs(wsLib.shapeLevel(0.5, 1, 2) - 0.25) < 1e-9, 'gamma 2');
    assert.equal(wsLib.shapeLevel(1.5, 1, 1), 1, 'clamped');
    assert.equal(wsLib.shapeLevel(-1, 1, 1), 0, 'clamped low');
});
