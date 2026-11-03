#!/usr/bin/env node
/*
 * Scratch: bare SpiWindowEngine against the real P5+P6 firmware — prints
 * every W-window event with the UART marker context, to explain frame
 * counts (no runtime, no devices).
 */
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = process.env.ESP_EMU_WWW || path.join(REPO, 'vendor', 'esp-emu-browser', 'www');
const FW = path.join(REPO, 'tests', 'firmware', 'peris_probe', 'build', 'merged-binary.bin');
const { initSync, WasmEmulator } = await import(pathToFileURL(path.join(WWW, 'pkg', 'esp_emu.js')).href);
initSync(readFileSync(path.join(WWW, 'pkg', 'esp_emu_bg.wasm')));
const { esp32c3 } = await import(pathToFileURL(path.join(REPO, 'build', 'core', 'mmio', 'c3.js')).href);
const { SpiWindowEngine, readDmaPayload } = await import(pathToFileURL(path.join(REPO, 'peris', 'devices', 'spi-lib.js')).href);

const emu = new WasmEmulator('esp32c3');
if (emu.has_default_rom()) emu.load_default_rom();
emu.set_boot_from_rom(true);
emu.load_firmware(new Uint8Array(readFileSync(FW)));

const ctx = {
    mmio: esp32c3,
    readU32: (a) => {
        const b = emu.read_memory(a >>> 0, 4);
        return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
    },
    readMem: (a, l) => emu.read_memory(a >>> 0, l),
};
// GDMA outlink raw-value trace: catch every change + DC level at that moment
let lastOutlink = null, lastDc = null;
function watchGdma() {
    for (const a of esp32c3.spi.gdma.outLink) {
        const raw = ctx.readU32(a);
        if (raw !== 0 && raw !== lastOutlink) {
            lastOutlink = raw;
            const dc = (ctx.readU32(esp32c3.gpio.out) >> 15) & 1;  // GPIO15 = DC
            const walked = readDmaPayload(ctx, null);
            const n = walked ? walked.bytes.length : -1;
            const head = walked ? Array.from(walked.bytes.subarray(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' ') : '-';
            console.log(`[gdma] outlink=0x${raw.toString(16)} dc=${dc} walkLen=${n} head=${head} after "${lastMarker}"`);
        }
    }
}

let uartBuf = '', uartScan = 0, done = false, lastMarker = '';
const events = [];
const engine = new SpiWindowEngine(ctx, (bytes, bits) => {
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    events.push({ marker: lastMarker, bits, hex });
    console.log(`[tx] after "${lastMarker}"  bits=${bits}  bytes=${hex}`);
});
function pump() {
    for (;;) {
        const nl = uartBuf.indexOf('\n', uartScan);
        if (nl < 0) break;
        const line = uartBuf.slice(uartScan, nl).trim();
        uartScan = nl + 1;
        if (line.startsWith('###')) lastMarker = line;
        if (line === '###P6 end') done = true;
    }
}
let batch = 0;
let inLcd = false, lastDumpMarker = '', dumpCounter = 0;
while (!done) {
    uartBuf += emu.run_batch(process.env.TB || 60);
    pump();
    engine.sample();
    watchGdma();
    if (lastMarker === '###P6 lcd start') inLcd = true;
    if (inLcd && lastMarker !== '###P6 lcd end') {
        dumpCounter++;
        if (lastMarker !== lastDumpMarker || dumpCounter % 2000 === 0) {
            lastDumpMarker = lastMarker;
            const vals = esp32c3.spi.gdma.outLink.map((a) => ctx.readU32(a).toString(16));
            const w = readDmaPayload(ctx, null);
            const head = w ? `${w.bytes.length}B ${Array.from(w.bytes.subarray(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join(' ')}` : 'null';
            const dc = (ctx.readU32(esp32c3.gpio.out) >> 15) & 1;
            console.log(`[lcd] outlinks ch=[${vals.join(', ')}] dc=${dc} walk=${head} after "${lastMarker}"`);
        }
    }
    if (lastMarker === '###P6 lcd end') inLcd = false;
    if (done) break;
    if (batch++ > 60_000_000) throw new Error('too long');
}
console.log(`\nevents=${events.length} transfers=${engine.transfers} dropped=${engine.dropped}`);
