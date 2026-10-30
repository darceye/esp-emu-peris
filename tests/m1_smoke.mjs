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
for (const m of ['led', 'button', 'touch-button', 'toggle-switch', 'pwm-led', 'rgb-led']) {
    devices[m] = await import(pathToFileURL(path.join(REPO, `peris/devices/${m}.js`)).href);
}
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
let inP2 = false;
function trackMarkers() {
    for (;;) {
        const nl = uart.indexOf('\n', uartScan);
        if (nl < 0) break;
        const line = uart.slice(uartScan, nl).trim();
        uartScan = nl + 1;
        if (line === '###P1 start') inP1 = true;
        else if (line === '###P1 end') inP1 = false;
        else if (line === '###P2 start') inP2 = true;
        else if (line === '###P2 end') inP2 = false;
    }
}
function runBatches(n, size = 50000) {
    for (let i = 0; i < n; i++) {
        uart += emu.run_batch(size);
        trackMarkers();
        rt.onBatchEnd();
    }
}

// S1: apply config, expect ready + initial states
await rt.applyConfig({
    perisVersion: 1,
    devices: [
        { id: 'led-1', type: 'led', pin: 8, color: '#ff4d4d', name: 'L' },
        { id: 'btn-1', type: 'button', pin: 3, activeLow: true },
        { id: 'sw-1', type: 'toggle-switch', pin: 5, initial: false },
        { id: 'pwm-1', type: 'pwm-led', channel: 'auto' },
        { id: 'rgb-1', type: 'rgb-led' },
    ],
});
const ready1 = msgs.find((m) => m.type === 'peris_ready');
check('S1 config applied', ready1?.ok === true && ready1.devices.length === 5);
check('S1 initial states pushed',
    ['led-1', 'btn-1', 'sw-1', 'pwm-1', 'rgb-1'].every((id) => states().some((s) => s.id === id)));

// S4: toggle switch drives pin level (GPIO5 input)
rt.command('sw-1', 'set', { on: true });
rt.flushStates(true); // commands flush on the next batch; force for the check
const swState = states().filter((s) => s.id === 'sw-1').pop();
check('S4 toggle command updates state', swState?.state?.on === true);

// S2/S3: run firmware; LED flips; button pulses counted by guest ISR
msgs.length = 0;
rt.flushStates(true);
runBatches(400); // boot + into the first P1 blink window
await new Promise((r) => setTimeout(r, 60)); // trailing state flush (33 ms throttle)
const ledStates = states().filter((s) => s.id === 'led-1');
const sawOn = ledStates.some((s) => s.state.on === true);
const sawOff = ledStates.some((s) => s.state.on === false);
check('S2 LED observed on and off', sawOn && sawOff, `${ledStates.length} state msgs`);

// Press/release while the firmware is inside a P1 phase, holding the press
// across batches (instant press+release inside one batch gap loses the edge).
let pulsesLeft = 3, hold = 0, made = 0;
for (let i = 0; i < 5000 && pulsesLeft >= 0; i++) {
    uart += emu.run_batch(50000);
    trackMarkers();
    if (inP1 && pulsesLeft > 0 && i % 40 === 0) {
        rt.command('btn-1', 'press');
        hold = 3; // batches held down
        pulsesLeft--; made++;
    } else if (hold > 0 && --hold === 0) {
        rt.command('btn-1', 'release');
        if (pulsesLeft === 0) pulsesLeft = -1; // done after last release settles
    }
    rt.onBatchEnd();
}
// let the firmware print the remaining ###P1 i=N btn=M lines
runBatches(400);
// The firmware prints "###P1 i=N btn=M" steps and a final "###P1 end btn=M";
// it zeroes the counter at each P1 start, so count any of these lines.
const btnCounts = [...uart.matchAll(/btn=(\d+)/g)].map((x) => +x[1]);
const lastBtn = btnCounts.length ? btnCounts[btnCounts.length - 1] : 0;
const anyCount = btnCounts.some((c) => c > 0);
if (process.env.VERBOSE) console.log('DEBUG btnCounts:', btnCounts.join(','), 'made:', made, 'inP1:', inP1, 'uartLen:', uart.length);
check('S3 button pulses reach guest ISR', anyCount && lastBtn >= 2,
    `${made} pulses, last btn=${lastBtn}`);

// S7/S8: advance into the next P2 (LEDC) phase. The firmware wires
// ch0→GPIO9, ch1→GPIO6, ch2→GPIO7 at boot and drives them inside P2:
// ch0 breathes 0→max→0 then flats 0/50%/max, ch1 mirrors down, ch2 holds
// half duty. State pushes are wall-clock throttled, so yield a little
// wall time inside the loop for flushes to go out.
for (let i = 0; i < 15000 && !inP2; i++) {
    uart += emu.run_batch(50000);
    trackMarkers();
    rt.onBatchEnd();
}
check('S7/S8 reached the P2 LEDC phase', inP2);
msgs.length = 0;
rt.flushStates(true);
for (let i = 0; i < 20000 && inP2; i++) {
    uart += emu.run_batch(50000);
    trackMarkers();
    rt.onBatchEnd();
    if (i % 50 === 0) await new Promise((r) => setTimeout(r, 5));
}
await new Promise((r) => setTimeout(r, 60)); // trailing flush (33ms throttle)

const pwmStates = states().filter((s) => s.id === 'pwm-1').map((s) => s.state);
if (process.env.VERBOSE) console.log('DEBUG pwm states:', JSON.stringify(pwmStates.slice(-8)));
check('S7 pwm-led auto-binds ch0 on GPIO9',
    pwmStates.some((s) => s.channel === 0 && s.pin === 9));
const duties = pwmStates.map((s) => s.duty || 0);
check('S7 pwm-led duty tracks the breathing ramp',
    duties.length > 0 && Math.max(...duties) >= 0.9
    && duties.some((d) => d >= 0.45 && d <= 0.55) && Math.min(...duties) <= 0.01,
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

// S6: unknown type rejected
msgs.length = 0;
await rt.applyConfig({ perisVersion: 1, devices: [{ id: 'x', type: 'nope', pin: 1 }] });
const ready3 = msgs.find((m) => m.type === 'peris_ready');
check('S6 unknown type rejected', ready3?.ok === false && ready3.errors.some((e) => e.includes('unknown type')));

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS');
process.exit(failed.length ? 1 : 0);
