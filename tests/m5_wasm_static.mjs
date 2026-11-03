#!/usr/bin/env node
/*
 * M5 static probe: enumerate EVERY export/import of esp_emu_bg.wasm and
 * every Rust string (log targets, panic messages, periph module paths).
 * Usage: node tests/m5_wasm_static.mjs [--strings]
 */
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW = process.env.ESP_EMU_WWW || path.join(REPO, 'vendor', 'esp-emu-browser', 'www');
const WASM = path.join(WWW, 'pkg', 'esp_emu_bg.wasm');
if (!existsSync(WASM)) { console.error(`missing ${WASM}`); process.exit(1); }

const bytes = readFileSync(WASM);
const mod = new WebAssembly.Module(bytes); // compiles (no instantiation)

const ex = WebAssembly.Module.exports(mod).sort((a, b) => a.name.localeCompare(b.name));
const im = WebAssembly.Module.imports(mod).sort((a, b) => a.name.localeCompare(b.name));

console.log(`wasm: ${WASM} (${bytes.length} bytes)`);
console.log(`\n=== ${ex.length} exports (kind name) ===`);
for (const e of ex) console.log(`${e.kind.padEnd(8)} ${e.name}`);
console.log(`\n=== ${im.length} imports (module.name kind) ===`);
for (const i of im) console.log(`${i.kind.padEnd(8)} ${i.module}.${i.name}`);

// ---- string scan: UTF-8 printable runs >=5 chars, filter interesting ----
const ascii = bytes.toString('latin1');
const runs = ascii.match(/[\x20-\x7e]{5,}/g) || [];
const uniq = [...new Set(runs)];
const kw = /(spi|i2c|gpio|rmt|ledc|uart|miso|mosi|sclk|cs\b|dma|gdma|w0_|periph|register|mem_wr|write_mem|input)/i;
const hits = uniq.filter((s) => kw.test(s));
console.log(`\n=== ${hits.length} keyword strings (of ${uniq.length} unique runs) ===`);
for (const s of hits.slice(0, 400)) console.log(s);
