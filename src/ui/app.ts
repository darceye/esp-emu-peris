/*
 * App orchestrator: owns machine state and the stock controls (run/pause/
 * step/reset, firmware + ROM pickers, WiFi fields, network proxy), wires
 * the worker client to the UI modules (terminal, perf panel, debug panels,
 * peripherals panel) and routes every worker message exactly once.
 */
import { WorkerClient } from './worker-client.js';
import type { MachineInfo } from './worker-client.js';
import { TerminalView, formatBytes, formatCycles } from './terminal.js';
import { PerfPanel } from './chart.js';
import { DebugPanels } from './debug-panels.js';
import { PerisPanel } from './peris-panel.js';
import { gpioCount, absentPins } from '../core/chips.js';
import type { PerisEvent } from '../core/protocol.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Labels for the embedded default ROMs (mirrors roms/ at build time).
const ROM_DEFAULTS: Record<string, string> = {
    esp32c3: 'esp32c3 rev3 (embedded)',
    esp32c5: 'esp32c5 rev1.0 (embedded)',
    esp32c6: 'esp32c6 rev0 (embedded)',
    esp32h2: 'esp32h2 rev0 (embedded)',
    esp32p4: 'esp32p4 rev3 (embedded)',
    esp32s3: 'esp32s3 rev0 (embedded)',
    esp32s31: 'esp32s31 (embedded)',
};

const $ = (id: string) => document.getElementById(id)!;

class App {
    private client!: WorkerClient;
    private term!: TerminalView;
    private perf!: PerfPanel;
    private debug!: DebugPanels;
    private peris!: PerisPanel;

    private isRunning = false;
    private firmwareLoaded = false;
    private romData: ArrayBuffer | null = null;
    private romFilename: string | null = null;
    private netConnected = false;
    private machine: MachineInfo = { chip: 'esp32c3', isXtensa: false, numHarts: 1, cyclesPerUs: 160 };

    start() {
        this.term = new TerminalView($('terminal-container'));
        this.term.banner();
        this.term.onData((bytes) => {
            if (this.firmwareLoaded) this.client.send({ type: 'uart_input', data: bytes });
        });
        window.addEventListener('resize', () => {
            this.term.fit();
            this.perf.draw();
        });
        $('clear-btn').addEventListener('click', () => this.term.clear());

        this.perf = new PerfPanel(() => this.machine.cyclesPerUs);
        this.debug = new DebugPanels({
            send: (m) => this.client.send(m),
            getChip: () => this.machine.chip,
            firmwareLoaded: () => this.firmwareLoaded,
        });
        this.initGpioDefaults();

        this.client = new WorkerClient();
        this.client.onerror = (message) => {
            this.term.writeln(`\x1b[31m[Error] Worker failed: ${message}\x1b[0m`);
            this.term.writeln('\x1b[31m[Error] Check browser console (F12) for details\x1b[0m');
        };

        this.peris = new PerisPanel({
            send: (m) => this.client.send(m),
            getChip: () => this.machine.chip,
            terminal: this.term,
        });

        this.routeWorkerMessages();
        this.setupControls();

        this.term.writeln('\x1b[90m[System] Initializing WASM module...\x1b[0m');
        this.peris.init().catch((e) => {
            this.term.writeln(`\x1b[31m[Peris] Registry load failed: ${(e as Error).message}\x1b[0m`);
        });
        this.client.initWasm();
    }

    // ---- machine / gpio defaults before any firmware ----
    private initGpioDefaults() {
        const chip = this.machine.chip;
        this.debug.initGpioPanel(chip, { count: gpioCount(chip), absent: absentPins(chip) });
        this.debug.initRegTable(false, chip);
        this.debug.renderCores([], chip);
    }

    private applyMachineInfo(msg: Partial<MachineInfo> & { chip?: string }) {
        this.machine = {
            chip: msg.chip || this.machine.chip,
            isXtensa: !!msg.isXtensa,
            numHarts: msg.numHarts || 1,
            cyclesPerUs: msg.cyclesPerUs || this.machine.cyclesPerUs,
        };
    }

    // ---- worker message routing (each message handled exactly once) ----
    private routeWorkerMessages() {
        this.client.on((msg: any) => {
            switch (msg.type) {
                case 'ready':
                    this.term.writeln('\x1b[32m[System] WASM module loaded\x1b[0m');
                    break;

                case 'loaded':
                    this.applyMachineInfo(msg);
                    this.firmwareLoaded = true;
                    this.perf.reset();
                    this.debug.initRegTable(this.machine.isXtensa, this.machine.chip);
                    this.debug.initGpioPanel(this.machine.chip,
                        { count: gpioCount(this.machine.chip), absent: absentPins(this.machine.chip) });
                    this.debug.renderCores([msg.pc], this.machine.chip);
                    this.perf.updateTiles(0);
                    this.updateButtons();
                    this.peris.reapplyOnLoad(); // re-apply devices on the fresh emulator
                    this.term.writeln(`\x1b[32m[System] Firmware loaded, PC=0x${msg.pc.toString(16)}\x1b[0m`);
                    this.term.writeln('');
                    this.setStatus('ready', 'Ready');
                    break;

                case 'uart_output':
                    this.term.uartOut(msg.data);
                    break;

                case 'status':
                    this.perf.record(msg);
                    break;

                case 'snapshot':
                    this.debug.updateRegisters(msg.regs);
                    this.debug.renderCores(msg.pcs, this.machine.chip);
                    this.debug.updateGpio(msg.gpio);
                    if (msg.mem) this.debug.renderMem(msg.mem.addr, msg.mem.bytes);
                    break;

                case 'mem':
                    this.debug.renderMem(msg.addr, msg.bytes);
                    break;

                case 'step':
                    if (msg.output) this.term.uartOut(msg.output);
                    $('cycle-display').textContent = `${formatCycles(msg.cycles)} cycles`;
                    $('tile-cycles').textContent = formatCycles(msg.cycles);
                    this.perf.updateTiles(msg.cycles);
                    break;

                case 'restarted':
                    if (msg.numHarts) this.applyMachineInfo({ ...this.machine, ...msg });
                    this.term.writeln('\x1b[33m[System] Software restart (esp_restart)\x1b[0m');
                    break;

                case 'reset':
                    this.term.clear();
                    this.isRunning = false;
                    this.perf.reset();
                    if (msg.reloaded) {
                        this.applyMachineInfo({ ...this.machine, ...msg });
                        this.term.writeln('\x1b[33m[System] Emulator reset\x1b[0m');
                        this.term.writeln(`\x1b[32m[System] Firmware reloaded, PC=0x${msg.pc.toString(16)}\x1b[0m`);
                        this.firmwareLoaded = true;
                        this.debug.renderCores([msg.pc], this.machine.chip);
                        this.perf.updateTiles(0);
                        this.setStatus('ready', 'Ready');
                    } else {
                        this.term.writeln('\x1b[33m[System] Emulator reset (no firmware)\x1b[0m');
                        this.firmwareLoaded = false;
                        this.setStatus('idle', 'Reset');
                    }
                    this.updateButtons();
                    break;

                case 'net_status': {
                    this.netConnected = msg.connected;
                    const netBtn = $('net-btn');
                    if (msg.connected) {
                        this.term.writeln('\x1b[32m[Network] Connected to WebSocket proxy\x1b[0m');
                        netBtn.textContent = 'Disconnect';
                        netBtn.classList.add('primary');
                    } else {
                        this.term.writeln('\x1b[33m[Network] Disconnected\x1b[0m');
                        netBtn.textContent = 'Connect';
                        netBtn.classList.remove('primary');
                    }
                    break;
                }

                case 'error':
                    this.term.writeln(`\x1b[31m[Error] ${msg.message}\x1b[0m`);
                    break;

                default:
                    // peris_* events (peris_ready / peris_state / peris_log)
                    this.peris.handlePerisMessage(msg as PerisEvent);
                    break;
            }
        });
    }

    // ---- controls ----
    private setStatus(state: string, text: string) {
        const pill = $('status-pill');
        pill.dataset.state = state;
        $('status-text').textContent = text;
    }

    private updateButtons() {
        ($('run-btn') as HTMLButtonElement).disabled = !this.firmwareLoaded || this.isRunning;
        ($('pause-btn') as HTMLButtonElement).disabled = !this.isRunning;
        ($('step-btn') as HTMLButtonElement).disabled = !this.firmwareLoaded || this.isRunning;
        ($('reset-btn') as HTMLButtonElement).disabled = !this.firmwareLoaded;
    }

    private updateRomBtnLabel() {
        const btn = $('rom-btn');
        if (this.romFilename) {
            btn.textContent = 'Custom: ' + this.romFilename;
        } else {
            const chip = ($('chip-select') as HTMLSelectElement).value;
            btn.textContent = ROM_DEFAULTS[chip] || 'Select ROM...';
        }
    }

    private async loadFirmwareFile(file: File) {
        const chip = ($('chip-select') as HTMLSelectElement).value;
        const buffer = await file.arrayBuffer();
        this.term.writeln(`\x1b[36m[System] Loading ${file.name} (${buffer.byteLength} bytes) for ${chip}...\x1b[0m`);
        $('fw-name').textContent = `${file.name} · ${formatBytes(buffer.byteLength)}`;
        $('fw-drop-text').innerHTML = '<strong>Replace</strong> with another .bin';

        if (this.isRunning) {
            this.isRunning = false;
            this.client.send({ type: 'stop' });
        }
        this.term.resetCounter();

        const transferList = [buffer];
        const msg: any = {
            type: 'load',
            chip,
            firmware: buffer,
            ssid: ($('wifi-ssid') as HTMLInputElement).value,
            password: ($('wifi-password') as HTMLInputElement).value,
        };
        if (this.romData) {
            const romCopy = this.romData.slice(0);
            msg.rom = romCopy;
            transferList.push(romCopy);
        }
        this.client.send(msg, transferList);
    }

    private setupControls() {
        // ROM ELF upload (optional — overrides the chip's embedded default)
        $('rom-file').addEventListener('change', async (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (!file) return;
            this.romData = await file.arrayBuffer();
            this.romFilename = file.name;
            this.term.writeln(`\x1b[36m[System] ROM ELF override loaded: ${file.name} (${this.romData.byteLength} bytes)\x1b[0m`);
            this.updateRomBtnLabel();
        });

        // Reflect the embedded default in the ROM button when the chip changes.
        $('chip-select').addEventListener('change', () => this.updateRomBtnLabel());
        this.updateRomBtnLabel();

        $('firmware-file').addEventListener('change', (e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) void this.loadFirmwareFile(f);
        });
        for (const el of [$('fw-drop'), $('terminal-container')]) {
            el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
            el.addEventListener('dragleave', () => el.classList.remove('over'));
            el.addEventListener('drop', (e) => {
                e.preventDefault();
                el.classList.remove('over');
                const file = (e as DragEvent).dataTransfer?.files?.[0];
                if (file) void this.loadFirmwareFile(file);
            });
        }

        $('run-btn').addEventListener('click', () => {
            this.isRunning = true;
            this.updateButtons();
            this.client.send({ type: 'start' });
            this.setStatus('running', 'Running');
            this.debug.pushMemWatch();
        });

        $('pause-btn').addEventListener('click', () => {
            this.isRunning = false;
            this.updateButtons();
            this.client.send({ type: 'stop' });
            this.setStatus('paused', 'Paused');
        });

        $('step-btn').addEventListener('click', () => this.client.send({ type: 'step' }));

        $('reset-btn').addEventListener('click', () => {
            this.client.send({ type: 'reset', chip: ($('chip-select') as HTMLSelectElement).value });
        });

        // Network connect/disconnect. A page served over HTTPS cannot open a
        // ws:// socket to localhost, so explain instead of failing silently.
        if (location.protocol === 'https:') {
            ($('net-url') as HTMLInputElement).disabled = true;
            ($('net-btn') as HTMLButtonElement).disabled = true;
            const note = $('net-note');
            note.className = 'note warn';
            note.textContent = 'Not available from an HTTPS page: browsers block the ws:// link to a local proxy. Run the page from a local server to use networking.';
        }
        $('net-btn').addEventListener('click', () => {
            if (this.netConnected) {
                this.client.send({ type: 'net_disconnect' });
            } else {
                this.client.send({ type: 'net_connect', url: ($('net-url') as HTMLInputElement).value });
            }
        });
    }
}

document.addEventListener('DOMContentLoaded', () => new App().start());
