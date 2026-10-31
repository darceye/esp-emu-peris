#!/usr/bin/env node
/*
 * M1 integration smoke test (Node): runs the real PerisRuntime + real device
 * modules against the real emulator wasm, covering what the GUI session
 * could not reach (and serving as a regression test):
 *
 *   S1 config apply -> peris_ready ok, initial states pushed
 *   S2 LED follows firmware GPIO8 blink (peris_state on/off flips)
 *   S3 button press/release (peris_command) raises firmware ISR counts
 *   S4 toggle-switch drives its pin level
 *   S5 pin conflict rejected with a peris_ready error
 *   S6 unknown device type rejected
 *   S7 pwm-led auto-discovers the LEDC wiring (ch0 → GPIO9) and its duty
 *      tracks the firmware P2 breathing ramp (M2)
 *   S8 rgb-led auto-binds ch0/1/2 → R/G/B (GPIO 9/6/7); red ramps up,
 *      green mirrors down, blue holds half duty (M2)
 *   S9 ws2812 auto-discovers the RMT wiring (ch0 → GPIO4), decodes the P3
 *      colour walk from the channel RAM and the final grad burst pins the
 *      tail alignment (last LED intact, second-to-last loses 2 G bits) (M3)
 *   S10 bitbang-i2c-slave: the firmware's ~20 kHz soft master talks to the
 *      24C02 (0x50) and BME280 (0x76) emulations on SCL=1/SDA=2 — write +
 *      sequential read-back, pointer wrap, chip id + factory calibration,
 *      forced measurements whose C-printed Bosch compensation must equal
 *      the JS model bit-exactly (M4)
 *   S11 ir-nec: the firmware's NEC codes decode from BOTH capture paths —
 *      bit-banged 38 kHz on GPIO5 (envelope from fine-batch edges) and
 *      carrier-less RMT ch1 symbols on GPIO10 (post-TX channel RAM),
 *      including repeat frames (M4)
 *
 * Batches run through rt.batchSize(50000): the M4 scheduler shrinks them
 * while the i2c/ir devices hold sampling leases, so loop caps are generous
 * rather than marker-exact (the firmware prints ###P1..P4 markers).
 *
 * Usage: node tests/m1_smoke.mjs [merged-firmware.bin]
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = 'D:/d3/_git/esp_proj/_tools/esp-emu-browser/www';
const FW = process.argv[2] ?? path.join(REPO, 'tests/firmware/peris_probe/build/merged-binary.bin');

const { initSync, WasmEmulator } = await import(
    pathToFileURL(path.join(WWW, 'pkg/esp_emu.js')).href
);
initSync(readFileSync(path.join(WWW, 'pkg/esp_emu_bg.wasm')));

const { PerisRuntime } = await import(pathToFileURL(path.join(REPO, 'build/core/runtime.js')).href);
const devices = {};
for (const m of ['led', 'button', 'touch-button', 'toggle-switch', 'pwm-led', 'rgb-led', 'ws2812', 'bitbang-i2c-slave', 'ir-nec']) {
    devices[m] = await import(pathToFileURL(path.join(REPO, `peris/devices/${m}.js`)).href);
}
const i2cLib = await import(pathToFileURL(path.join(REPO, 'peris/devices/i2c-lib.js')).href);
const registry = {
    has: (t) => t in devices,
    meta: (t) => devices[t]?.Device,
    Device: (t) => devices[t]?.Device,
    View: () => null,
    types: () => Object.keys(devices).map((t) => ({ typeId: t, title: devices[t].Device.title })),
    errors: [],
};

// --- boot emulator ---
const emu = new WasmEmulator('esp32c3');
if (emu.has_default_rom()) emu.load_default_rom();
emu.set_boot_from_rom(true);
emu.load_firmware(new Uint8Array(readFileSync(FW)));

const msgs = [];
const states = () => msgs.filter((m) => m.type === 'peris_state');
const rt = new PerisRuntime();
rt.post = (m) => msgs.push(m);
rt.registry = registry;
rt.attachEmu(emu, 'esp32c3');

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};

let uart = '';
let uartScan = 0; // cumulative marker scan position
let inP1 = false;
let inP1b = false;
let inP2 = false;
let inP3 = false;
let inP4 = false;
const p3Colours = []; // logged colours of the P3 bursts (walk + grad marker)
const p1bSamples = []; // { sw, tch, n } lines printed inside P1b
const p4Lines = [];   // raw ###P4 lines (parsed by the S10/S11 sections)
let batches = 0;      // scheduler batches executed (verbose phase tracing)
let lastPhaseLine = ''; // most recent ### marker (bounded settles)
function trackMarkers() {
    for (;;) {
        const nl = uart.indexOf('\n', uartScan);
        if (nl < 0) break;
        const line = uart.slice(uartScan, nl).trim();
        uartScan = nl + 1;
        if (process.env.VERBOSE && line.startsWith('###')) {
            console.log(`[phase] batch=${batches} cycles=${emu.cycles()} ${line}`);
        }
        lastPhaseLine = line;
        let m;
        if (line === '###P1 start') inP1 = true;
        // the firmware prints "###P1 end btn=N" — exact match never fired
        // and inP1 stuck true through whole rounds (a real M4 bug)
        else if (line.startsWith('###P1 end')) inP1 = false;
        // P1b sampling lines: "###P1b i=N sw=S btnlvl=B tch=T n=K"
        else if (line === '###P1b start') inP1b = true;
        else if ((m = line.match(/^###P1b i=\d+ sw=([01]) btnlvl=[01] tch=([01]) n=(\d+)/)))
            p1bSamples.push({ sw: +m[1], tch: +m[2], n: +m[3] });
        else if (line.startsWith('###P1b end')) inP1b = false;
        else if (line === '###P2 start') inP2 = true;
        else if (line === '###P2 end') inP2 = false;
        else if (line === '###P3 start') inP3 = true;
        else if ((m = line.match(/^###P3 f=\d+ c=0x([0-9a-fA-F]{6})/))) p3Colours.push(parseInt(m[1], 16));
        else if (line === '###P3 grad') p3Colours.push('grad');
        else if (line === '###P3 end') inP3 = false;
        else if (line === '###P4 start') inP4 = true;
        else if (line === '###P4 end') inP4 = false; // exact match BEFORE the prefix catch
        else if (line.startsWith('###P4 ')) p4Lines.push(line.slice(6));
    }
}
// One scheduler batch per iteration (rt.batchSize honours the M4 sampling
// leases; 1600-instruction armed batches make iteration counts ~30× the
// old 50k-batch numbers — caps below are sized accordingly).
function runBatches(n) {
    for (let i = 0; i < n; i++) {
        uart += emu.run_batch(rt.batchSize(50000));
        trackMarkers();
        rt.onBatchEnd();
        batches++;
    }
}

// S1: apply config, expect ready + initial states
await rt.applyConfig({
    perisVersion: 1,
    devices: [
        { id: 'led-1', type: 'led', pin: 8, color: '#ff4d4d', name: 'L' },
        { id: 'btn-1', type: 'button', pin: 3, activeLow: true },
        { id: 'sw-1', type: 'toggle-switch', pin: 0, initial: false },
        { id: 'tch-1', type: 'touch-button', pin: 18, activeLow: true },
        { id: 'pwm-1', type: 'pwm-led', channel: 'auto' },
        { id: 'rgb-1', type: 'rgb-led' },
        { id: 'ws-1', type: 'ws2812' },
        { id: 'ee-1', type: 'bitbang-i2c-slave', model: 'eeprom24c02', scl: 1, sda: 2 },
        { id: 'bme-1', type: 'bitbang-i2c-slave', model: 'bme280', scl: 1, sda: 2, address: 0x76 },
        { id: 'ir-bb', type: 'ir-nec', pin: 5, source: 'gpio' },
        { id: 'ir-rmt', type: 'ir-nec', pin: 10, source: 'rmt', channel: 1 },
    ],
});
const ready1 = msgs.find((m) => m.type === 'peris_ready');
check('S1 config applied (11 devices, I2C bus shared)',
    ready1?.ok === true && ready1.devices.length === 11, ready1?.errors.join('; '));
check('S1 initial states pushed',
    ['led-1', 'btn-1', 'sw-1', 'tch-1', 'pwm-1', 'rgb-1', 'ws-1', 'ee-1', 'bme-1', 'ir-bb', 'ir-rmt']
        .every((id) => states().some((s) => s.id === id)));

// S4: toggle switch drives pin level (GPIO0 input)
rt.command('sw-1', 'set', { on: true });
rt.flushStates(true); // commands flush on the next batch; force for the check
const swState = states().filter((s) => s.id === 'sw-1').pop();
check('S4 toggle command updates state', swState?.state?.on === true);

// S2/S3: run firmware; LED flips; button pulses counted by guest ISR.
// Armed batches fast-forward whole sleep phases (~680k cycles/batch,
// M4-measured), so every window is bounded by MARKERS, never batch counts.
msgs.length = 0;
rt.flushStates(true);
for (let i = 0; i < 20000 && !inP1; i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
}
// Force-flush instead of waiting on the 33 ms wall-clock throttle: the
// forced push makes the observation deterministic (no wall-time jitter).
let sawOn = false, sawOff = false, ledMsgs = 0;
for (let i = 0; i < 250 && inP1 && !(sawOn && sawOff); i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
    if (i % 20 === 0) {
        rt.flushStates(true);
        const ls = states().filter((m) => m.id === 'led-1');
        ledMsgs = ls.length;
        sawOn ||= ls.some((m) => m.state.on === true);
        sawOff ||= ls.some((m) => m.state.on === false);
    }
}
check('S2 LED observed on and off', sawOn && sawOff, `${ledMsgs} state msgs`);

// Press/release while the firmware is inside a P1 phase. Emulated timing,
// not instruction counts, is what the guest ISR needs: P1's vTaskDelay
// sleeps fast-forward ~680k cycles per armed batch, so a press every 8
// batches held for 3 (~10-40 ms emulated) is the working cadence — an
// instant press+release inside one batch gap loses the edge, and
// instruction-count-shaped pulses (M0's 150k instr / 2M instr) fall outside
// the phase before three of them fit (M4 measurement).
let pulsesLeft = 3, hold = 0, made = 0;
for (let i = 0; i < 5000 && pulsesLeft >= 0; i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    batches++;
    if (inP1 && pulsesLeft > 0 && i % 8 === 0) {
        rt.command('btn-1', 'press');
        hold = 3;
        pulsesLeft--; made++;
    } else if (hold > 0 && --hold === 0) {
        rt.command('btn-1', 'release');
        if (pulsesLeft === 0) pulsesLeft = -1; // done after last release settles
    }
    rt.onBatchEnd();
}
// let the firmware print the remaining ###P1 i=N btn=M lines (bounded:
// armed batches fast-forward whole phases)
for (let i = 0; i < 5000 && inP1; i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
}
// The firmware prints "###P1 i=N btn=M" steps and a final "###P1 end btn=M";
// it zeroes the counter at each P1 start, so count any of these lines.
const btnCounts = [...uart.matchAll(/btn=(\d+)/g)].map((x) => +x[1]);
const lastBtn = btnCounts.length ? btnCounts[btnCounts.length - 1] : 0;
const anyCount = btnCounts.some((c) => c > 0);
if (process.env.VERBOSE) console.log('DEBUG btnCounts:', btnCounts.join(','), 'made:', made, 'inP1:', inP1, 'uartLen:', uart.length);
check('S3 button pulses reach guest ISR', anyCount && lastBtn >= 2,
    `${made} pulses, last btn=${lastBtn}`);

// S4b: the P1b digital-in sampling phase follows P1 immediately — the
// firmware reads the switch (GPIO0), the button level (GPIO3) and the
// touch pad (GPIO18) via gpio_get_level() every 125 ms, mirrors the switch
// on the blink LED and counts touch press edges. Flip the switch on at
// entry / off mid-phase and press the touch pad twice while inside the
// phase (marker-bounded; a hold of 20 batches ≈ 85 ms emulated straddles
// several sample windows — the same cadence lesson as S3).
for (let i = 0; i < 20000 && !inP1b; i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
}
rt.command('sw-1', 'set', { on: true });
let tchLeft = 2, tchHold = 0, tchMade = 0;
let ledOn = false, ledOff = false;
for (let i = 0; i < 30000 && inP1b; i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
    if (i === 150) rt.command('sw-1', 'set', { on: false });
    if (tchLeft > 0 && i % 60 === 0) {
        rt.command('tch-1', 'press');
        tchHold = 20;
        tchLeft--; tchMade++;
    } else if (tchHold > 0 && --tchHold === 0) {
        rt.command('tch-1', 'release');
    }
    if (i % 10 === 0) {
        rt.flushStates(true);
        const ls = states().filter((m) => m.id === 'led-1');
        ledOn ||= ls.some((m) => m.state.on === true);
        ledOff ||= ls.some((m) => m.state.on === false);
    }
}
check('S4b switch level reaches guest gpio_get_level',
    p1bSamples.some((s) => s.sw === 1) && p1bSamples.some((s) => s.sw === 0),
    `${p1bSamples.length} samples, sw=1 in ${p1bSamples.filter((s) => s.sw === 1).length}`);
check('S4b touch presses counted by guest',
    p1bSamples.some((s) => s.n >= 1) && p1bSamples.some((s) => s.tch === 0),
    `${tchMade} presses, max n=${p1bSamples.length ? Math.max(...p1bSamples.map((s) => s.n)) : 0}`);
check('S4b blink LED mirrors the switch',
    ledOn && ledOff, `on=${ledOn} off=${ledOff}`);

// S7/S8: advance into the next P2 (LEDC) phase. The firmware wires
// ch0→GPIO9, ch1→GPIO6, ch2→GPIO7 at boot and drives them inside P2:
// ch0 breathes 0→max→0 then flats 0/50%/max, ch1 mirrors down, ch2 holds
// half duty. State pushes are wall-clock throttled, so yield a little
// wall time inside the loop for flushes to go out.
for (let i = 0; i < 100000 && !inP2; i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
}
check('S7/S8 reached the P2 LEDC phase', inP2);
msgs.length = 0;
rt.flushStates(true);
for (let i = 0; i < 100000 && inP2; i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
    if (i % 25 === 0) rt.flushStates(true); // deterministic sampling of the duty ramp
}
await new Promise((r) => setTimeout(r, 60)); // trailing flush (33ms throttle)

const pwmStates = states().filter((s) => s.id === 'pwm-1').map((s) => s.state);
if (process.env.VERBOSE) console.log('DEBUG pwm states:', JSON.stringify(pwmStates.slice(-8)));
check('S7 pwm-led auto-binds ch0 on GPIO9',
    pwmStates.some((s) => s.channel === 0 && s.pin === 9));
const duties = pwmStates.map((s) => s.duty || 0);
check('S7 pwm-led duty tracks the breathing ramp',
    duties.length > 0 && Math.max(...duties) >= 0.9
    && duties.some((d) => d >= 0.35 && d <= 0.65) && Math.min(...duties) <= 0.01,
    `${duties.length} samples, min ${Math.min(...duties, 0)}, max ${duties.length ? Math.max(...duties) : 0}`);

const rgbStates = states().filter((s) => s.id === 'rgb-1').map((s) => s.state);
if (process.env.VERBOSE) console.log('DEBUG rgb states:', JSON.stringify(rgbStates.slice(-8)));
check('S8 rgb-led auto-binds ch0/1/2 → R/G/B (GPIO 9/6/7)',
    rgbStates.some((s) => s.channels?.r === 0 && s.channels?.g === 1 && s.channels?.b === 2
        && s.pins?.r === 9 && s.pins?.g === 6 && s.pins?.b === 7));
const reds = rgbStates.map((s) => s.r || 0);
const greens = rgbStates.map((s) => s.g || 0);
const blues = rgbStates.map((s) => s.b || 0);
check('S8 rgb-led duties track: red ramps, green mirrors, blue holds half',
    rgbStates.length > 0 && Math.max(...reds) >= 0.9 && Math.max(...greens) >= 0.9
    && blues.some((b) => b >= 0.45 && b <= 0.55)
    && rgbStates.some((s) => (s.r || 0) > 0.05 && (s.r || 0) + (s.g || 0) >= 0.94
        && (s.r || 0) + (s.g || 0) <= 1.06),
    `${rgbStates.length} samples`);

// S9: advance into the next P3 (RMT WS2812) phase. The firmware wires RMT
// ch0 → GPIO4 at boot and sends 8 uniform colour frames plus one grad burst
// (all red, n-2 green, n-1 blue). The 48-word channel RAM keeps only the
// last 46 bits of a frame, so exactly two tail slots decode: the grad burst
// must show the last LED pure blue and the second-to-last green with G=0x3f
// (two head bits lost to the RAM wrap — see ws2812-lib.decodeWs2812).
for (let i = 0; i < 100000 && !inP3; i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
}
check('S9 reached the P3 RMT phase', inP3);
msgs.length = 0;
rt.flushStates(true);
for (let i = 0; i < 100000 && inP3; i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
    if (i % 50 === 0) await new Promise((r) => setTimeout(r, 5));
}
for (let i = 0; i < 2000 && inP3; i++) { // settle; P3-end stops it
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
}
await new Promise((r) => setTimeout(r, 60)); // trailing flush (33ms throttle)

const wsStates = states().filter((s) => s.id === 'ws-1').map((s) => s.state);
if (process.env.VERBOSE) console.log('DEBUG ws states:', JSON.stringify(wsStates.slice(-6)));
check('S9 ws2812 auto-binds ch0 on GPIO4',
    wsStates.some((s) => s.channel === 0 && s.pin === 4));
const hex = (led) => (led[0] << 16) | (led[1] << 8) | led[2];
const seenWalk = new Set(wsStates.map((s) => s.leds?.[7]).filter(Boolean).map(hex));
const expectedWalk = p3Colours.filter((c) => typeof c === 'number');
check('S9 ws2812 tracks the P3 colour walk (last LED)',
    expectedWalk.filter((c) => seenWalk.has(c)).length >= 3,
    `expected ${expectedWalk.map((c) => '0x' + c.toString(16)).join(',')} seen ${[...seenWalk].map((c) => '0x' + c.toString(16)).join(',') || '-'}`);
const lastWs = wsStates[wsStates.length - 1];
check('S9 grad burst pins the tail alignment',
    JSON.stringify(lastWs?.leds?.[6]) === JSON.stringify([0, 0x3f, 0])
    && JSON.stringify(lastWs?.leds?.[7]) === JSON.stringify([0, 0, 255]),
    `leds[6]=${JSON.stringify(lastWs?.leds?.[6])} leds[7]=${JSON.stringify(lastWs?.leds?.[7])} visible=${lastWs?.visible}`);

// S10/S11: advance into the next P4 (bit-bang I2C + IR) phase. The firmware
// runs its ~20 kHz soft master against the emulated 24C02/BME280 on
// SCL=1/SDA=2, then NEC frames: 3 codes bit-banged on GPIO5 (first one
// followed by a repeat) and 2 codes + repeat through RMT ch1 on GPIO10.
for (let i = 0; i < 100000 && !inP4; i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
}
check('S10/S11 reached the P4 phase', inP4);
msgs.length = 0;
rt.flushStates(true);
for (let i = 0; i < 2000000 && inP4; i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
    if (i % 500 === 0) await new Promise((r) => setTimeout(r, 5));
}
// trailing quiet for the IR decoder's 25 ms-emulated flush, bounded by the
// NEXT round marker: after P4 the bus is idle and armed batches fast-forward
// entire rounds within a few thousand batches
for (let i = 0; i < 2000 && !/^###ROUND/.test(lastPhaseLine); i++) {
    uart += emu.run_batch(rt.batchSize(50000));
    trackMarkers();
    rt.onBatchEnd();
    batches++;
}
await new Promise((r) => setTimeout(r, 60)); // trailing flush (33ms throttle)
if (process.env.VERBOSE) console.log('DEBUG p4 lines:', p4Lines.join('\n'));

// ---- S10: soft I2C against the emulated slaves ---------------------------

const eeRd = p4Lines.find((l) => l.startsWith('eeprom ack=') && l.includes('rd='));
const eeWrap = p4Lines.find((l) => l.startsWith('eeprom ack=') && l.includes('wrap='));
check('S10 eeprom write + sequential read-back round-trips',
    eeRd != null && eeRd.includes('ack=0')
    && eeRd.endsWith('rd=a5 3c 0f ff 00 55 81 7e'), eeRd ?? 'missing');
check('S10 eeprom pointer wraps at 0x100 (fe 11 22 then erased ff)',
    eeWrap != null && eeWrap.includes('ack=0') && eeWrap.endsWith('wrap=11 22 ff ff'), eeWrap ?? 'missing');

const eeStates = states().filter((s) => s.id === 'ee-1').map((s) => s.state);
const eeFinal = eeStates[eeStates.length - 1];
check('S10 eeprom device mirrored the transactions (state log + writes)',
    eeStates.some((s) => (s.stats?.stops ?? 0) >= 3)
    && eeFinal?.mem?.[0x10] === 0xa5 && eeFinal?.mem?.[0x17] === 0x7e
    && eeFinal?.mem?.[0xfe] === 0x11 && eeFinal?.mem?.[0x00] === 0xff,
    `${eeFinal?.stats?.stops ?? 0} transactions, ${eeFinal?.stats?.bytes ?? 0} bytes`);

const bmeId = p4Lines.find((l) => l.startsWith('bme id='));
const bmeCalib = p4Lines.find((l) => l.startsWith('bme calib='));
check('S10 bme280 chip id + factory calibration served',
    bmeId?.includes('id=0x60') && bmeId.includes('ack=0') && bmeCalib?.includes('calib=0x9c'),
    `${bmeId ?? '-'} / ${bmeCalib ?? '-'}`);

// Cross-check the C compensation against the JS model, bit-exact
const bmeModel = new i2cLib.Bme280Model();
const mLines = [...uart.matchAll(/###P4 bme m=(\d+) ack=(\d+) rt=(\d+) rp=(\d+) rh=(\d+) T=(-?\d+) P=(-?\d+) H=(\d+)/g)]
    .map((x) => x.slice(1).map(Number));
check('S10 bme280 3 forced measurements, all ACKed, raw follows the model',
    mLines.length === 3 && mLines.every((v) => v[1] === 0)
    // a ctrl_meas write advances the fake signal first: m=k reads adc(n=k+1)
    && mLines.every((v, i) => v[2] === 524288 + 4096 * (i + 1) && v[3] === 1006500 + 200 * (i + 1) && v[4] === 30000 + 4096 * (i + 1)),
    mLines.map((v) => `m${v[0]}:rt=${v[2]}`).join(' '));
check('S10 bme280 C compensation === JS model (T/P/H bit-exact)',
    mLines.length === 3 && mLines.every(([m, ack, rt, rp, rh, T, P, H]) => {
        const c = i2cLib.bme280Compensate(rt, rp, rh, bmeModel.dig);
        return c.tCx100 === T && c.pPa === P && c.hRx1024 === H;
    }),
    mLines.map(([, , , , , T, P, H]) => `T=${T} P=${P} H=${H}`).join(' | '));
const bmeStates = states().filter((s) => s.id === 'bme-1').map((s) => s.state);
const bmeFinal = bmeStates[bmeStates.length - 1];
check('S10 bme280 device state shows the live measurement',
    bmeFinal?.bme?.n === 3 && bmeFinal?.bme?.tCx100 === 2446,
    `n=${bmeFinal?.bme?.n} T=${bmeFinal?.bme?.tCx100}`);

// ---- S11: NEC capture ------------------------------------------------------

const bbCodes = [...p4Lines.filter((l) => l.startsWith('nec bb a=')).map((l) => l.match(/a=0x([0-9a-f]+) c=0x([0-9a-f]+)/))];
const rmtCodes = [...p4Lines.filter((l) => l.startsWith('nec rmt a=')).map((l) => l.match(/a=0x([0-9a-f]+) c=0x([0-9a-f]+)/))];
const irBb = states().filter((s) => s.id === 'ir-bb').map((s) => s.state);
const irRmt = states().filter((s) => s.id === 'ir-rmt').map((s) => s.state);
const bbLast = irBb[irBb.length - 1];
const rmtLast = irRmt[irRmt.length - 1];
if (process.env.VERBOSE) {
    console.log('DEBUG ir-bb last:', JSON.stringify(bbLast?.last), 'log:', JSON.stringify(bbLast?.log));
    console.log('DEBUG ir-rmt last:', JSON.stringify(rmtLast?.last), 'log:', JSON.stringify(rmtLast?.log));
}
const seenCode = (st, addr, cmd) => (st?.log || [])
    .some((f) => !f.repeat && f.addr === addr && f.cmd === cmd && f.valid);
check('S11 ir-nec gpio capture: all 3 bit-banged codes decoded',
    bbCodes.length === 3 && bbLast?.count === 3
    && seenCode(bbLast, 0xff, 0x11) && seenCode(bbLast, 0xff, 0x22) && seenCode(bbLast, 0x34, 0xab),
    `count=${bbLast?.count} log=${JSON.stringify(bbLast?.log?.map((f) => [f.addr?.toString(16), f.cmd?.toString(16), f.valid, f.repeats]))}`);
check('S11 ir-nec gpio capture: repeat frame attached to its code',
    (bbLast?.log || []).some((f) => !f.repeat && f.addr === 0xff && f.cmd === 0x11 && f.repeats >= 1));
check('S11 ir-nec rmt capture: 2 codes + repeat from channel RAM',
    rmtCodes.length === 2 && rmtLast?.mode === 'rmt' && rmtLast?.channel === 1
    && rmtLast?.count === 2 && seenCode(rmtLast, 0xff, 0x11) && seenCode(rmtLast, 0xff, 0x22)
    && (rmtLast?.log || []).some((f) => !f.repeat && f.addr === 0xff && f.cmd === 0x22 && f.repeats >= 1),
    `count=${rmtLast?.count} log=${JSON.stringify(rmtLast?.log?.map((f) => [f.addr?.toString(16), f.cmd?.toString(16), f.valid, f.repeats]))}`);

// S5: conflict rejected
msgs.length = 0;
await rt.applyConfig({
    perisVersion: 1,
    devices: [
        { id: 'a', type: 'led', pin: 8 },
        { id: 'b', type: 'led', pin: 8 },
    ],
});
const ready2 = msgs.find((m) => m.type === 'peris_ready');
check('S5 pin conflict rejected',
    ready2?.ok === false && ready2.errors.some((e) => e.includes('already used')),
    ready2?.errors.join('; '));

// S5b: sharedBus pins do not conflict with each other, but a plain device
// claiming one of the bus pins still conflicts
msgs.length = 0;
await rt.applyConfig({
    perisVersion: 1,
    devices: [
        { id: 'a', type: 'led', pin: 8 },
        { id: 'b', type: 'bitbang-i2c-slave', scl: 1, sda: 2 },
        { id: 'c', type: 'bitbang-i2c-slave', model: 'bme280', scl: 1, sda: 2, address: 0x76 },
    ],
});
const ready2b = msgs.find((m) => m.type === 'peris_ready');
check('S5b sharedBus: two I2C slaves legally share SCL/SDA',
    ready2b?.ok === true, ready2b?.errors.join('; '));
msgs.length = 0;
await rt.applyConfig({
    perisVersion: 1,
    devices: [
        { id: 'a', type: 'led', pin: 1 },
        { id: 'b', type: 'bitbang-i2c-slave', scl: 1, sda: 2 },
    ],
});
const ready2c = msgs.find((m) => m.type === 'peris_ready');
check('S5b sharedBus: an LED on the bus pins still conflicts',
    ready2c?.ok === false && ready2c.errors.length === 1 && ready2c.errors[0].startsWith('b:'),
    ready2c?.errors.join('; '));

// S6: unknown type rejected
msgs.length = 0;
await rt.applyConfig({ perisVersion: 1, devices: [{ id: 'x', type: 'nope', pin: 1 }] });
const ready3 = msgs.find((m) => m.type === 'peris_ready');
check('S6 unknown type rejected', ready3?.ok === false && ready3.errors.some((e) => e.includes('unknown type')));

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
