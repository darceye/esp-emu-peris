#!/usr/bin/env node
/*
 * Scratch check: run the P6 firmware phase against the real wasm with the
 * real runtime + the two hw-SPI devices, print their final state. This is
 * the manual pre-smoke for S14/S15 — kept as a scratch tool, not part of
 * npm test.
 */
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = process.env.ESP_EMU_WWW || path.join(REPO, 'vendor', 'esp-emu-browser', 'www');
const FW = path.join(REPO, 'tests', 'firmware', 'peris_probe', 'build', 'merged-binary.bin');
if (!existsSync(FW)) { console.error('firmware missing'); process.exit(1); }

const { initSync, WasmEmulator } = await import(pathToFileURL(path.join(WWW, 'pkg', 'esp_emu.js')).href);
initSync(readFileSync(path.join(WWW, 'pkg', 'esp_emu_bg.wasm')));

const { PerisRuntime } = await import(pathToFileURL(path.join(REPO, 'build', 'core', 'runtime.js')).href);
const devices = {};
for (const m of ['max7219', 'ili9341']) {
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

const emu = new WasmEmulator('esp32c3');
if (emu.has_default_rom()) emu.load_default_rom();
emu.set_boot_from_rom(true);
emu.load_firmware(new Uint8Array(readFileSync(FW)));

let uartBuf = '';
let done = false, inP6 = false, sawMxEnd = false;
let msgs = [];
const rt = new PerisRuntime();
rt.post = (m) => { msgs.push(m); if (m.type === 'peris_log') console.log(`[log] ${m.text}`); };
rt.registry = registry;
rt.attachEmu(emu, 'esp32c3');
const ready = await rt.applyConfig({
    perisVersion: 1,
    devices: [
        { id: 'mx1', type: 'max7219', bus: 'hwspi', chain: 1, pos: 0, mode: 'auto', name: 'MX-hw' },
        { id: 'lcd1', type: 'ili9341', dcPin: 15, csPin: 14, width: 320, height: 240, name: 'LCD' },
    ],
});
const readyMsg = msgs.find((m) => m.type === 'peris_ready');
console.log('ready:', JSON.stringify(readyMsg));
// batch-size sanity: with an armed SPI device the scheduler must return 60
console.log('batchSize next =', rt.batchSize(50000));

// event-stream tracing: wrap both devices' window-engine callbacks
if (process.env.TRACE) {
    for (const m of msgs) {
        if (m.type !== 'peris_ready') continue;
        for (const d of m.devices ?? []) {
            const inst = rt.devices?.get?.(d.id);
        }
    }
    // reach into the runtime's device map via has()+state — instances are
    // not exposed; instead patch the SpiWindowEngine callbacks through the
    // plugin module scope is not possible. Use per-device log tracing:
    rt.post = (m) => {
        msgs.push(m);
        if (m.type === 'peris_log') console.log(`[log] ${m.text}`);
    };
}

function pump() {
    const nl = uartBuf.indexOf('\n');
    if (nl < 0) return;
    const line = uartBuf.slice(0, nl).trim();
    uartBuf = uartBuf.slice(nl + 1);
    if (!line.startsWith('###')) { pump(); return; }
    if (line === '###P6 start') inP6 = true;
    else if (line === '###P6 mx end') sawMxEnd = true;
    else if (line === '###P6 end') { done = true; return; }
    if (inP6 && line.startsWith('###P6')) console.log(line);
    pump();
}

let batch = 0;
while (!done) {
    uartBuf += emu.run_batch(rt.batchSize(50000));
    rt.onBatchEnd();
    pump();
    if (done) break;
    if (batch++ > 60_000_000) throw new Error('ran too long'); // arm 60 → tens of millions of batches per guest round
}
rt.flushStates(true);

const snap = (id) => {
    const all = msgs.filter((m) => m.type === 'peris_state' && m.id === id);
    const withPx = all.filter((m) => m.state && m.state.pixels);
    return (withPx.length ? withPx : all).pop()?.state ?? null;
};
const mxSt = snap('mx1'), lcdSt = snap('lcd1');
console.log('\n--- MAX7219 hwspi state ---');
console.log(JSON.stringify(mxSt));
if (mxSt) {
    console.log(`digits=${mxSt.digits.map((d) => d.toString(16).padStart(2, '0')).join(' ')}`);
    console.log(`decode=${mxSt.decodeMode.toString(16)} intensity=${mxSt.intensity} scan=${mxSt.scanLimit} shutdown=${mxSt.shutdown} test=${mxSt.test}`);
    console.log(`frames=${mxSt.frames} transfers=${mxSt.transfers} dropped=${mxSt.dropped} writes=${mxSt.writes} wiring=${JSON.stringify(mxSt.wiring)}`);
}
console.log('\n--- ILI9341 state ---');
if (lcdSt) {
    console.log(`win=${JSON.stringify(lcdSt.win)} colmod=${lcdSt.colmod.toString(16)} madctl=${lcdSt.madctl.toString(16)}`);
    console.log(`sleep=${lcdSt.sleep} on=${lcdSt.displayOn} cmds=${lcdSt.cmdCount} frames=${lcdSt.frames} px=${lcdSt.pixelsWritten} unknown=${lcdSt.unknownCmds}`);
    console.log(`transfers=${lcdSt.transfers} dropped=${lcdSt.dropped} dmaFeeds=${lcdSt.dmaFeeds} dataBytes=${lcdSt.dataBytes}`);
    if (lcdSt.pixels) {
        const expect = (x, y) => (((x * 31 / 319) << 11) | ((y * 63 / 239) << 5) | (((x >> 3) + (y >> 2)) & 0x1f)) & 0xffff;
        for (const [x, y] of [[0, 0], [319, 0], [0, 239], [319, 239], [160, 120]]) {
            const got = lcdSt.pixels[y * 320 + x];
            console.log(`    (${x},${y}) got=0x${got.toString(16)} want=0x${expect(x, y).toString(16)} ${got === expect(x, y) ? 'OK' : 'MISMATCH'}`);
        }
    }
}
