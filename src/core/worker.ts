/*
 * Web Worker running the emulation loop with esp-emu-peris hooks.
 *
 * This is the stock esp-emulator-browser worker.js (v0.51.0) with three
 * additions, marked "peris:":
 *   1. A PerisRuntime instance owning the peripheral devices.
 *   2. runtime.onBatchEnd() after every run_batch (pin sampling + state
 *      flush to the page).
 *   3. peris_config / peris_command message handlers.
 * Everything else — load flow, throttle, snapshots, networking, stepping —
 * behaves exactly like the stock worker. See docs/UPGRADE.md for how to
 * re-sync when the upstream worker changes.
 */
import { PerisRuntime } from './runtime.js';
import { PERIS_CONFIG, PERIS_COMMAND } from './protocol.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Msg = any;

declare const self: {
    onmessage: ((e: { data: Msg }) => void) | null;
    onerror: ((...a: any[]) => void) | null;
    onunhandledrejection: ((e: { reason: unknown }) => void) | null;
    postMessage(m: unknown): void;
};

let wasm: { WasmEmulator: any } | null = null;
let emulator: any = null;
let running = false;
let batchSize = 50000;
let pendingLoad: Msg | null = null;
let ws: WebSocket | null = null;

// peris: peripheral device runtime
const peris = new PerisRuntime();

// Live-view state: how often a snapshot (registers, GPIO, watched memory)
// goes to the page while running, and which memory window it follows.
const SNAPSHOT_INTERVAL_MS = 150;
let lastSnapshot = 0;
let memWatch: { addr: number; len: number } | null = null; // or null

// Global error handler — catches WASM panics and unhandled exceptions
self.onerror = function (msg: any, _src: any, _line: any, _col: any, _err: any) {
    self.postMessage({ type: 'error', message: `Worker error: ${msg}` });
};
self.onunhandledrejection = function (e: { reason: unknown }) {
    self.postMessage({ type: 'error', message: `Worker promise rejected: ${e.reason}` });
};

// Import wasm module
async function initWasm(wasmUrl: string) {
    try {
        const { default: init, WasmEmulator } = await import(/* @vite-ignore */ wasmUrl);
        await init();
        wasm = { WasmEmulator };
        self.postMessage({ type: 'ready' });

        // peris: load the device registry (manifest + modules); failures
        // are reported on the console, not fatal.
        try {
            await peris.init();
        } catch (e) {
            console.warn('peris registry failed:', e);
        }

        // Process any load request that arrived while WASM was initializing
        if (pendingLoad) {
            const msg = pendingLoad;
            pendingLoad = null;
            handleLoad(msg);
        }
    } catch (e) {
        self.postMessage({ type: 'error', message: `Failed to init WASM: ${(e as Error).message}` });
    }
}

// What the page needs to know about the machine it is looking at.
function machineInfo() {
    return {
        pc: emulator.pc(),
        isXtensa: emulator.is_xtensa(),
        numHarts: emulator.num_harts(),
        cyclesPerUs: emulator.cycles_per_us(),
    };
}

function handleLoad(msg: Msg) {
    const chip = msg.chip || 'esp32c3';
    try {
        emulator = new wasm!.WasmEmulator(chip);
        if (msg.ssid) {
            emulator.set_wifi_config(msg.ssid, msg.password || '');
        }
        if (msg.rom) {
            emulator.load_rom_elf(new Uint8Array(msg.rom));
        } else if (emulator.has_default_rom()) {
            emulator.load_default_rom();
        } else {
            throw new Error(`No ROM provided and no embedded default for chip ${chip}`);
        }
        if (msg.efuse) {
            emulator.load_efuse(new Uint8Array(msg.efuse));
        }
        emulator.set_boot_from_rom(!msg.skipRom);
        const data = new Uint8Array(msg.firmware);
        emulator.load_firmware(data);
        peris.attachEmu(emulator, chip); // peris: new emulator instance
        self.postMessage({ type: 'loaded', chip, ...machineInfo() });
        sendSnapshot(true);
    } catch (err) {
        self.postMessage({ type: 'error', message: `Load failed: ${err}` });
    }
}

// --- WebSocket networking ---

function connectNetwork(url: string) {
    if (ws) {
        ws.close();
        ws = null;
    }
    try {
        ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';

        ws.onopen = function () {
            self.postMessage({ type: 'net_status', connected: true });
        };

        ws.onclose = function () {
            self.postMessage({ type: 'net_status', connected: false });
            ws = null;
        };

        ws.onerror = function () {
            self.postMessage({ type: 'error', message: `WebSocket connection failed: ${url}` });
            ws = null;
        };

        ws.onmessage = function (e: MessageEvent) {
            // Receive Ethernet frame from TAP proxy → push into emulator WiFi RX
            if (emulator && e.data instanceof ArrayBuffer && e.data.byteLength >= 14) {
                emulator.wifi_rx_push(new Uint8Array(e.data));
            }
        };
    } catch (e) {
        self.postMessage({ type: 'error', message: `WebSocket error: ${(e as Error).message}` });
    }
}

function disconnectNetwork() {
    if (ws) {
        ws.close();
        ws = null;
    }
}

function drainTxToNetwork() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !emulator) return;

    // wifi_tx_drain returns length-prefixed frames: [u32 len][frame bytes]...
    const buf = emulator.wifi_tx_drain();
    if (buf.length === 0) return;

    let offset = 0;
    while (offset + 4 <= buf.length) {
        const len = buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24);
        offset += 4;
        if (offset + len > buf.length) break;
        // Copy into a new ArrayBuffer to avoid sending the entire backing buffer
        const frame = new Uint8Array(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + len));
        ws.send(frame.buffer);
        offset += len;
    }
}

// Handle messages from main thread
self.onmessage = function (e: { data: Msg }) {
    const msg = e.data;

    switch (msg.type) {
        case 'init':
            initWasm(msg.wasmUrl);
            break;

        case 'load':
            if (!wasm) {
                pendingLoad = msg;
                self.postMessage({ type: 'error', message: 'WASM still loading, please wait...' });
            } else {
                handleLoad(msg);
            }
            break;

        case 'start':
            running = true;
            runLoop();
            break;

        case 'stop':
            running = false;
            sendSnapshot(true);
            peris.flushStates(true); // peris: final state on pause
            break;

        case 'step': {
            if (!emulator) break;
            let output = emulator.run_batch(1);
            peris.onBatchEnd(); // peris
            if (emulator.needs_restart()) {
                if (output) self.postMessage({ type: 'uart_output', data: output });
                output = '';
                try {
                    emulator.restart();
                    self.postMessage({ type: 'restarted' });
                } catch (err) {
                    self.postMessage({ type: 'error', message: `Restart failed: ${err}` });
                }
            }
            self.postMessage({
                type: 'step',
                output: output,
                pc: emulator.pc(),
                cycles: emulator.cycles(),
            });
            sendSnapshot(true);
            peris.flushStates(true); // peris
            break;
        }

        case 'reset': {
            running = false;
            if (emulator) {
                try {
                    emulator.restart();
                    self.postMessage({ type: 'reset', reloaded: true, ...machineInfo() });
                    sendSnapshot(true);
                } catch (err) {
                    self.postMessage({ type: 'error', message: `Reset failed: ${err}` });
                    self.postMessage({ type: 'reset', reloaded: false });
                }
            } else {
                self.postMessage({ type: 'reset', reloaded: false });
            }
            break;
        }

        case 'uart_input':
            if (emulator) {
                emulator.uart_input(new Uint8Array(msg.data));
            }
            break;

        case 'gpio_input':
            if (emulator) {
                emulator.gpio_set_input(msg.pin, !!msg.high);
                sendSnapshot(true);
            }
            break;

        case 'read_mem':
            if (emulator) {
                self.postMessage({
                    type: 'mem',
                    addr: msg.addr >>> 0,
                    bytes: emulator.read_memory(msg.addr >>> 0, msg.len),
                });
            }
            break;

        case 'mem_watch':
            memWatch = msg.addr == null ? null : { addr: msg.addr >>> 0, len: msg.len };
            if (memWatch && emulator) sendSnapshot(true);
            break;

        case 'net_connect':
            connectNetwork(msg.url);
            break;

        case 'net_disconnect':
            disconnectNetwork();
            break;

        case 'set_batch_size':
            batchSize = msg.size;
            break;

        case PERIS_CONFIG: // peris
            peris.applyConfig(msg.config);
            break;

        case PERIS_COMMAND: // peris
            peris.command(msg.id, msg.cmd, msg.params);
            break;
    }
};

function runLoop() {
    if (!running || !emulator) return;

    const startTime = performance.now();
    let totalCycles = 0;
    let allOutput = '';
    // Wait before the next batch for the drift the emulator reports; the
    // worker cannot block, so setTimeout sleeps. Capped with the network up
    // so queued frames are not left waiting.
    let nextDelay = 0;

    // Run multiple batches per animation frame for throughput
    while (running) {
        const output = emulator.run_batch(batchSize);
        allOutput += output;
        totalCycles += batchSize;

        peris.onBatchEnd(); // peris: pin sample + throttled state flush

        // Handle software restart (esp_restart / OTA reboot)
        if (emulator.needs_restart()) {
            // Flush output before restart
            if (allOutput.length > 0) {
                self.postMessage({ type: 'uart_output', data: allOutput });
                allOutput = '';
            }
            try {
                emulator.restart();
                self.postMessage({ type: 'uart_output', data: '\r\n' });
                self.postMessage({ type: 'restarted', ...machineInfo() });
            } catch (err) {
                self.postMessage({ type: 'error', message: `Restart failed: ${err}` });
                running = false;
            }
            break;
        }

        // Drain TX frames every batch to minimize network latency
        drainTxToNetwork();

        const drift = emulator.throttle_delay_ms(performance.now());
        if (drift > 0) {
            nextDelay = ws ? Math.min(drift, 5) : drift;
            break;
        }

        // Yield every ~16ms for responsiveness
        if (performance.now() - startTime > 12) break;
    }

    if (allOutput.length > 0) {
        self.postMessage({ type: 'uart_output', data: allOutput });
    }

    // Send status update. A batch that ran for less than a millisecond has
    // no meaningful rate; report it as 0 rather than a huge or infinite one.
    const elapsedMs = performance.now() - startTime;
    self.postMessage({
        type: 'status',
        pc: emulator.pc(),
        cycles: emulator.cycles(),
        mips: elapsedMs >= 1 ? (totalCycles / elapsedMs / 1000).toFixed(1) : '0.0',
        now: performance.now(),
    });
    sendSnapshot(false);

    if (running) {
        setTimeout(runLoop, nextDelay);
    }
}

// Registers, per-hart PCs, GPIO pads and the watched memory window, rate
// limited while running; `force` sends one regardless (step, pause, load).
function sendSnapshot(force: boolean) {
    if (!emulator) return;
    const now = performance.now();
    if (!force && now - lastSnapshot < SNAPSHOT_INTERVAL_MS) return;
    lastSnapshot = now;

    const harts = emulator.num_harts();
    const pcs: number[] = [];
    for (let h = 0; h < harts; h++) pcs.push(emulator.hart_pc(h));

    const snap: Msg = {
        type: 'snapshot',
        regs: Array.from(emulator.registers()),
        pcs,
        gpio: Array.from(emulator.gpio_state()),
        cycles: emulator.cycles(),
    };
    if (memWatch) {
        snap.mem = { addr: memWatch.addr, bytes: emulator.read_memory(memWatch.addr, memWatch.len) };
    }
    self.postMessage(snap);
}
