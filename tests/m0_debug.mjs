#!/usr/bin/env node
/*
 * Focused M0 debug: dump raw LEDC duty registers during P2 flats and raw
 * RMT channel-0 RAM symbols during P3, plus cycles() behaviour across a
 * small-batch window. Run: node tests/m0_debug.mjs
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = 'D:/d3/_git/esp_proj/_tools/esp-emu-browser/www';
const FW = path.join(REPO, 'tests/firmware/peris_probe/build/merged-binary.bin');

const { initSync, WasmEmulator } = await import(
    pathToFileURL(path.join(WWW, 'pkg/esp_emu.js')).href
);
initSync(readFileSync(path.join(WWW, 'pkg/esp_emu_bg.wasm')));

const emu = new WasmEmulator('esp32c3');
if (emu.has_default_rom()) emu.load_default_rom();
emu.set_boot_from_rom(true);
emu.load_firmware(new Uint8Array(readFileSync(FW)));

const readU32 = (a) => { const b = emu.read_memory(a, 4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; };
const LEDC_DUTY = 0x60019008, LEDC_DUTY_R = 0x60019010;
const RMTMEM = 0x60016400;

let uart = '', scan = 0, phase = 'boot', done = false, batch = 0;
let dutyCtx = null, dutyLogs = [], memDumps = [], cyclesLog = [], dbgFine = 0;

function handle(line) {
    let m;
    if (line === '###P2 start') phase = 'P2';
    else if ((m = line.match(/^###P2 flat=(\w+) d=(\d+)/))) dutyCtx = `${m[1]}(${m[2]})`;
    else if (line === '###P2 end') phase = 'idle';
    else if (line === '###P3 start') phase = 'P3';
    else if ((m = line.match(/^###P3 f=(\d+) c=0x([0-9a-fA-F]{6})/))) {
        if (dbgFine < 2) { dbgFine++; debugFineWindow(); }
    }
    else if (line === '###P3 end') done = true;
}
function processUart() {
    for (;;) {
        const nl = uart.indexOf('\n', scan);
        if (nl < 0) break;
        const line = uart.slice(scan, nl).trim();
        scan = nl + 1;
        if (line.startsWith('###')) handle(line);
        if (done) return;
    }
}

function debugFineWindow() {
    // Log cycles behaviour and RMT RAM across consecutive tiny batches.
    const start = emu.cycles();
    for (let i = 0; i < 4000 && emu.cycles() - start < 4_000_000; i++) {
        const out = emu.run_batch(40);
        if (out) { uart += out; processUart(); if (done) break; }
        if (i < 40 || i % 400 === 0) {
            const s = emu.gpio_state();
            cyclesLog.push({
                i, cycles: emu.cycles(), dc: emu.cycles() - start,
                out4: (s[0] >> 4) & 1, oe4: (s[2] >> 4) & 1,
            });
        }
    }
    // RAM dump right after the window.
    const bytes = emu.read_memory(RMTMEM, 48 * 4);
    const words = [];
    for (let w = 0; w < 48; w++) words.push((bytes[w * 4] | (bytes[w * 4 + 1] << 8) | (bytes[w * 4 + 2] << 16) | (bytes[w * 4 + 3] << 24)) >>> 0);
    memDumps.push({ at: emu.cycles(), words });
}

while (!done) {
    const out = emu.run_batch(50000);
    if (out) { uart += out; processUart(); }
    if (done) break;
    if (phase === 'P2' && dutyCtx && batch % 64 === 0 && dutyLogs.length < 40) {
        dutyLogs.push({ ctx: dutyCtx, duty: readU32(LEDC_DUTY).toString(16), dutyR: readU32(LEDC_DUTY_R).toString(16) });
    }
    if (phase === 'P3' && batch % 4 === 0 && memDumps.length < 4) {
        const bytes = emu.read_memory(RMTMEM, 48 * 4);
        const words = [];
        for (let w = 0; w < 48; w++) words.push((bytes[w * 4] | (bytes[w * 4 + 1] << 8) | (bytes[w * 4 + 2] << 16) | (bytes[w * 4 + 3] << 24)) >>> 0);
        if (words.filter((w) => w !== 0).length >= 10) memDumps.push({ at: emu.cycles(), words });
    }
    if (++batch > 400_000) throw new Error('timeout');
}

console.log('--- LEDC duty regs during flats (ctx, DUTY, DUTY_R hex) ---');
for (const d of dutyLogs.slice(0, 12)) console.log(`  ${d.ctx}  duty=0x${d.duty}  duty_r=0x${d.dutyR}`);
console.log('\n--- cycles()/pin behaviour across run_batch(40) window ---');
for (const c of cyclesLog) console.log(`  i=${c.i} cycles=${c.cycles} delta=${c.dc} out4=${c.out4} oe4=${c.oe4}`);
console.log('\n--- RMTMEM ch0 dumps ---');
memDumps.forEach((d, k) => {
    console.log(` dump#${k} at cycles=${d.at}:`);
    for (let w = 0; w < 16; w++) console.log(`   [${w.toString(2).padStart(2, '0')}] 0x${d.words[w].toString(16).padStart(8, '0')}  d0=${d.words[w] & 0x7fff} l0=${(d.words[w] >> 15) & 1} d1=${(d.words[w] >> 16) & 0x7fff} l1=${(d.words[w] >> 31) & 1}`);
});
