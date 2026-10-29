/*
 * ESP-EMU PERIS application — the stock browser app (terminal, debug
 * panels, worker orchestration) plus the Peripherals panel:
 *   - device cards with generic config editors (from configSchema)
 *   - add / remove devices, config import / export, localStorage autosave
 *   - peris_state rendering into each device's View
 *
 * The worker is peris/worker.js (stock worker + peris hooks).
 */
import { loadRegistry } from './registry.js';
import { normaliseConfig } from './device-api.js';
import { PERIS_CONFIG, PERIS_COMMAND, PERIS_READY, PERIS_STATE, PERIS_LOG, PERIS_API_VERSION } from './protocol.js';
import { validPins } from './chips.js';

(function() {
    'use strict';

    // --- State ---
    let worker = null;
    let terminal = null;
    let fitAddon = null;
    let isRunning = false;
    let firmwareLoaded = false;
    let romData = null;
    let romFilename = null;
    let netConnected = false;
    let uartBytes = 0;

    // What the worker told us about the loaded machine.
    let machine = { chip: 'esp32c3', isXtensa: false, numHarts: 1, cyclesPerUs: 160 };

    // Labels for the embedded default ROMs (mirrors roms/ at build time).
    const ROM_DEFAULTS = {
        esp32c3: 'esp32c3 rev3 (embedded)',
        esp32c5: 'esp32c5 rev1.0 (embedded)',
        esp32c6: 'esp32c6 rev0 (embedded)',
        esp32h2: 'esp32h2 rev0 (embedded)',
        esp32p4: 'esp32p4 rev3 (embedded)',
        esp32s3: 'esp32s3 rev0 (embedded)',
        esp32s31: 'esp32s31 (embedded)',
    };

    // SOC_GPIO_PIN_COUNT per chip; S3 has register slots but no pads at 22-25.
    const GPIO_COUNT = {
        esp32c3: 22, esp32c5: 29, esp32c6: 31, esp32h2: 28,
        esp32p4: 55, esp32s3: 49, esp32s31: 32,
    };
    const GPIO_ABSENT = { esp32s3: new Set([22, 23, 24, 25]) };

    // --- Register names ---
    const RV_REG_NAMES = [
        'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
        's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
        'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
        's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
    ];
    // Matches the order WasmEmulator::registers() returns for Xtensa.
    const XT_WINDOW_NAMES = [
        'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
        'a8', 'a9', 'a10', 'a11', 'a12', 'a13', 'a14', 'a15',
    ];
    const XT_WINDOW_ROLES = { a0: 'ret', a1: 'sp' };
    const XT_SPECIAL_NAMES = [
        'ps', 'sar', 'windowbase', 'windowstart',
        'exccause', 'excvaddr', 'epc1', 'lbeg', 'lend', 'lcount',
    ];

    const $ = (id) => document.getElementById(id);
    const hex8 = (v) => (v >>> 0).toString(16).padStart(8, '0');

    function setStatus(state, text) {
        $('status-pill').dataset.state = state;
        $('status-text').textContent = text;
    }

    function updateRomBtnLabel() {
        const btn = $('rom-btn');
        if (!btn) return;
        if (romFilename) {
            btn.textContent = 'Custom: ' + romFilename;
        } else {
            const chip = $('chip-select').value;
            btn.textContent = ROM_DEFAULTS[chip] || 'Select ROM...';
        }
    }

    // --- Terminal ---
    function initTerminal() {
        terminal = new Terminal({
            theme: {
                background: '#0e0e10',
                foreground: '#ececea',
                cursor: '#ff7a1a',
                cursorAccent: '#0e0e10',
                selectionBackground: 'rgba(255, 122, 26, 0.3)',
                black: '#1c1c21', brightBlack: '#5c5c66',
                red: '#ff5c5c', brightRed: '#ff7b7b',
                green: '#49d49a', brightGreen: '#6ee7b7',
                yellow: '#f5c04a', brightYellow: '#ffd57a',
                blue: '#6ea8fe', brightBlue: '#9cc2ff',
                magenta: '#d48cff', brightMagenta: '#e3b0ff',
                cyan: '#4cd3e0', brightCyan: '#7fe3ee',
                white: '#ececea', brightWhite: '#ffffff',
            },
            fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
            fontSize: 13,
            lineHeight: 1.15,
            convertEol: true,
            cursorBlink: true,
            scrollback: 10000,
        });
        fitAddon = new FitAddon.FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open($('terminal-container'));
        fitAddon.fit();

        // Handle terminal input -> UART RX
        terminal.onData(data => {
            if (worker && firmwareLoaded) {
                const encoder = new TextEncoder();
                worker.postMessage({
                    type: 'uart_input',
                    data: Array.from(encoder.encode(data)),
                });
            }
        });

        window.addEventListener('resize', () => {
            if (fitAddon) fitAddon.fit();
            drawChart();
        });

        terminal.writeln('\x1b[1;33m╔══════════════════════════════════════╗');
        terminal.writeln('║  ESP-EMU + PERIS peripherals v0.51.0 ║');
        terminal.writeln('║  Load a firmware .bin to begin       ║');
        terminal.writeln('╚══════════════════════════════════════╝\x1b[0m');
        terminal.writeln('');
    }

    function uartOut(text) {
        terminal.write(text);
        uartBytes += text.length;
        $('uart-count').textContent = formatBytes(uartBytes);
    }

    function formatBytes(n) {
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
        return `${(n / 1048576).toFixed(2)} MiB`;
    }

    function formatCycles(n) {
        if (n < 1e6) return Math.floor(n).toLocaleString();
        if (n < 1e9) return `${(n / 1e6).toFixed(2)} M`;
        return `${(n / 1e9).toFixed(3)} G`;
    }

    // --- Performance tiles + sparkline ---
    const CHART_WINDOW_MS = 30000;
    const samples = []; // { t: wall ms, mips, cycles }
    let hoverX = null;

    function recordStatus(msg) {
        const t = msg.now || performance.now();
        const mips = parseFloat(msg.mips);
        samples.push({ t, mips: Number.isFinite(mips) ? mips : 0, cycles: msg.cycles });
        while (samples.length && samples[0].t < t - CHART_WINDOW_MS) samples.shift();

        $('mips-display').textContent = `${msg.mips} MIPS`;
        $('cycle-display').textContent = `${formatCycles(msg.cycles)} cycles`;
        $('tile-mips').innerHTML = `${msg.mips}<small>MIPS</small>`;
        $('tile-cycles').textContent = formatCycles(msg.cycles);
        updateTimeTiles(msg.cycles);

        // Emulated-vs-wall ratio over the last ~2 s of samples. A live figure:
        // about 1 while the firmware idles, since the worker paces emulated
        // time to the host clock, and below 1 in compute-bound stretches.
        let i = samples.length - 1;
        while (i > 0 && samples[i - 1].t > t - 2000) i--;
        const first = samples[i], last = samples[samples.length - 1];
        const wallMs = last.t - first.t;
        if (wallMs > 200 && machine.cyclesPerUs > 0) {
            const emuMs = (last.cycles - first.cycles) / machine.cyclesPerUs / 1000;
            const ratio = emuMs / wallMs;
            $('tile-ratio').innerHTML = `${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(2)}<small>×</small>`;
        }
        drawChart();
    }

    function updateTimeTiles(cycles) {
        const secs = machine.cyclesPerUs > 0 ? cycles / machine.cyclesPerUs / 1e6 : 0;
        $('tile-time').innerHTML = `${secs.toFixed(3)}<small>s</small>`;
    }

    function drawChart() {
        const canvas = $('mips-chart');
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth || 300, cssH = 64;
        if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
            canvas.width = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);

        const styles = getComputedStyle(document.documentElement);
        const accent = styles.getPropertyValue('--accent').trim();
        const grid = styles.getPropertyValue('--border').trim();

        const padX = 6, padTop = 8, padBottom = 6;
        const plotW = cssW - padX * 2, plotH = cssH - padTop - padBottom;

        // Recessive gridlines at 1/3 and 2/3.
        ctx.strokeStyle = grid;
        ctx.lineWidth = 1;
        for (const f of [1 / 3, 2 / 3]) {
            const y = padTop + plotH * f + 0.5;
            ctx.beginPath(); ctx.moveTo(padX, y); ctx.lineTo(cssW - padX, y); ctx.stroke();
        }

        if (samples.length < 2) { $('chart-max').textContent = ''; return; }
        const now = samples[samples.length - 1].t;
        const t0 = now - CHART_WINDOW_MS;
        let max = 0;
        for (const s of samples) if (s.mips > max) max = s.mips;
        max = Math.max(1, max * 1.1);
        $('chart-max').textContent = `peak ${(max / 1.1).toFixed(1)}`;

        const px = (t) => padX + ((t - t0) / CHART_WINDOW_MS) * plotW;
        const py = (v) => padTop + plotH - (v / max) * plotH;

        // Area fill under the line, then the 2px line on top.
        ctx.beginPath();
        ctx.moveTo(px(samples[0].t), py(0));
        for (const s of samples) ctx.lineTo(px(s.t), py(s.mips));
        ctx.lineTo(px(now), py(0));
        ctx.closePath();
        const fill = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
        fill.addColorStop(0, 'rgba(255, 122, 26, 0.35)');
        fill.addColorStop(1, 'rgba(255, 122, 26, 0.02)');
        ctx.fillStyle = fill;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            if (i === 0) ctx.moveTo(px(s.t), py(s.mips)); else ctx.lineTo(px(s.t), py(s.mips));
        }
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // Hover crosshair + tooltip.
        const tip = $('chart-tip');
        if (hoverX != null) {
            const tHover = t0 + ((hoverX - padX) / plotW) * CHART_WINDOW_MS;
            let best = samples[0];
            for (const s of samples) if (Math.abs(s.t - tHover) < Math.abs(best.t - tHover)) best = s;
            const x = px(best.t), y = py(best.mips);
            ctx.strokeStyle = 'rgba(236, 236, 234, 0.35)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(x + 0.5, padTop); ctx.lineTo(x + 0.5, padTop + plotH); ctx.stroke();
            ctx.fillStyle = accent;
            ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = '#1c1c21'; ctx.lineWidth = 2; ctx.stroke();
            tip.textContent = `${best.mips.toFixed(1)} MIPS · ${((now - best.t) / 1000).toFixed(1)} s ago`;
            tip.style.display = 'block';
            const tipW = tip.offsetWidth;
            tip.style.left = `${Math.min(Math.max(0, x - tipW / 2), cssW - tipW)}px`;
        } else {
            tip.style.display = 'none';
        }
    }

    function initChart() {
        const canvas = $('mips-chart');
        canvas.addEventListener('mousemove', (e) => {
            hoverX = e.offsetX;
            drawChart();
        });
        canvas.addEventListener('mouseleave', () => { hoverX = null; drawChart(); });
        drawChart();
    }

    // --- Cores ---
    function renderCores(pcs) {
        const box = $('cores');
        box.innerHTML = '';
        const total = (machine.chip === 'esp32p4' || machine.chip === 'esp32s3' || machine.chip === 'esp32s31') ? 2 : 1;
        for (let h = 0; h < total; h++) {
            const el = document.createElement('div');
            const live = h < pcs.length;
            el.className = 'core' + (live ? '' : ' idle');
            el.innerHTML = `<div class="k"><span>Core ${h}</span><span>${live ? 'running' : 'held in reset'}</span></div>` +
                           `<div class="v">pc 0x${live ? hex8(pcs[h]) : '--------'}</div>`;
            box.appendChild(el);
        }
    }

    // --- GPIO (debug panel) ---
    let gpioPins = [];        // DOM nodes indexed by pin
    let gpioInputLevels = []; // what we drive on input pins (default high: pull-up)

    function initGpioPanel() {
        const grid = $('gpio-grid');
        grid.innerHTML = '';
        gpioPins = [];
        const count = GPIO_COUNT[machine.chip] || 32;
        const absent = GPIO_ABSENT[machine.chip] || new Set();
        $('gpio-count').textContent = `${count - absent.size} pins`;
        gpioInputLevels = new Array(count).fill(true);
        for (let i = 0; i < count; i++) {
            const pin = document.createElement('div');
            pin.className = 'gpio-pin in high' + (absent.has(i) ? ' absent' : '');
            pin.textContent = i;
            pin.title = `GPIO${i} — input, high (pull-up)`;
            pin.addEventListener('click', () => toggleGpioInput(i));
            grid.appendChild(pin);
            gpioPins.push(pin);
        }
    }

    function toggleGpioInput(pin) {
        const el = gpioPins[pin];
        if (!el || el.classList.contains('out') || !worker || !firmwareLoaded) return;
        gpioInputLevels[pin] = !gpioInputLevels[pin];
        worker.postMessage({ type: 'gpio_input', pin, high: gpioInputLevels[pin] });
        paintGpioPin(pin, false, gpioInputLevels[pin]);
    }

    function paintGpioPin(i, isOut, high) {
        const el = gpioPins[i];
        if (!el) return;
        el.classList.toggle('out', isOut);
        el.classList.toggle('in', !isOut);
        el.classList.toggle('high', high);
        el.classList.toggle('low', !high);
        el.title = isOut
            ? `GPIO${i} — output, driven ${high ? 'high' : 'low'} by firmware`
            : `GPIO${i} — input, ${high ? 'high' : 'low'} (click to toggle)`;
    }

    function updateGpio(state) {
        // state = [out_lo, out_hi, enable_lo, enable_hi]
        for (let i = 0; i < gpioPins.length; i++) {
            const word = i < 32 ? 0 : 1, bit = i & 31;
            const isOut = ((state[2 + word] >>> bit) & 1) === 1;
            const high = isOut ? ((state[word] >>> bit) & 1) === 1 : gpioInputLevels[i];
            paintGpioPin(i, isOut, high);
        }
    }

    // --- Registers ---
    let regCells = [];
    let lastRegs = null;

    function initRegTable() {
        const table = $('reg-table');
        table.innerHTML = '';
        regCells = [];
        lastRegs = null;
        const tbody = document.createElement('tbody');
        const cell = (name) => {
            const td = document.createElement('td');
            td.className = 'val';
            td.textContent = '00000000';
            regCells.push(td);
            const nameTd = document.createElement('td');
            nameTd.className = 'name';
            nameTd.textContent = name;
            return [nameTd, td];
        };
        const addRow = (names, sep) => {
            const tr = document.createElement('tr');
            if (sep) tr.className = 'sep';
            for (const n of names) {
                if (n == null) { tr.appendChild(document.createElement('td')); tr.appendChild(document.createElement('td')); continue; }
                for (const td of cell(n)) tr.appendChild(td);
            }
            tbody.appendChild(tr);
        };

        if (machine.isXtensa) {
            $('isa-tag').textContent = 'Xtensa LX7';
            $('reg-tag').textContent = 'core 0 · window';
            for (let i = 0; i < 8; i++) {
                const a = XT_WINDOW_NAMES[i], b = XT_WINDOW_NAMES[i + 8];
                const label = (n) => XT_WINDOW_ROLES[n] ? `${n} (${XT_WINDOW_ROLES[n]})` : n;
                addRow([label(a), label(b)]);
            }
            for (let i = 0; i < XT_SPECIAL_NAMES.length; i += 2) {
                addRow([XT_SPECIAL_NAMES[i], XT_SPECIAL_NAMES[i + 1] ?? null], i === 0);
            }
        } else {
            $('isa-tag').textContent = machine.chip === 'esp32p4' || machine.chip === 'esp32s31' ? 'RV32IMAFC' : 'RV32IMAC';
            $('reg-tag').textContent = 'hart 0';
            for (let i = 0; i < 16; i++) {
                addRow([`x${i} (${RV_REG_NAMES[i]})`, `x${i + 16} (${RV_REG_NAMES[i + 16]})`]);
            }
        }
        table.appendChild(tbody);
    }

    function updateRegisters(regs) {
        // Cells were pushed row by row (left, right); map register index to
        // the cell holding it.
        const order = cellOrder(regs.length);
        for (let k = 0; k < order.length; k++) {
            const idx = order[k];
            const td = regCells[k];
            if (!td || idx == null || idx >= regs.length) continue;
            const text = hex8(regs[idx]);
            const changed = lastRegs && lastRegs[idx] !== regs[idx];
            if (td.textContent !== text) td.textContent = text;
            if (changed) {
                td.classList.remove('changed');
                void td.offsetWidth; // restart the fade
                td.classList.add('changed');
                setTimeout(() => td.classList.remove('changed'), 50);
            }
        }
        lastRegs = regs.slice();
    }

    // Register index at each cell position, matching initRegTable's layout.
    function cellOrder(n) {
        const out = [];
        if (machine.isXtensa) {
            for (let i = 0; i < 8; i++) out.push(i, i + 8);
            for (let i = 16; i < n; i++) out.push(i);
        } else {
            for (let i = 0; i < 16; i++) out.push(i, i + 16);
        }
        return out;
    }

    // --- Memory inspector ---
    function parseAddr(text) {
        // Hex, with or without a 0x prefix.
        const t = text.trim().replace(/_/g, '').replace(/^0x/i, '');
        if (!/^[0-9a-f]{1,8}$/i.test(t)) return null;
        return parseInt(t, 16) >>> 0;
    }

    function renderMem(addr, bytes) {
        const out = [];
        for (let off = 0; off < bytes.length; off += 16) {
            const row = bytes.slice(off, off + 16);
            let hexs = '', ascii = '';
            for (let i = 0; i < 16; i++) {
                if (i < row.length) {
                    const b = row[i];
                    const h = b.toString(16).padStart(2, '0');
                    hexs += (b === 0 ? `<span class="zero">${h}</span>` : h) + (i === 7 ? '  ' : ' ');
                    ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b).replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;') : '.';
                } else {
                    hexs += '   ' + (i === 7 ? ' ' : '');
                }
            }
            out.push(`<span class="addr">${hex8(addr + off)}</span>  ${hexs} <span class="ascii">|${ascii}|</span>`);
        }
        $('mem-display').innerHTML = out.join('\n');
    }

    function memRequest() {
        const addr = parseAddr($('mem-addr').value);
        const len = parseInt($('mem-len').value, 10);
        if (addr == null) {
            $('mem-display').innerHTML = '<span class="empty">Enter a hex address, e.g. 0x3FC80000.</span>';
            return null;
        }
        return { addr, len };
    }

    function pushMemWatch() {
        if (!worker) return;
        const req = $('mem-follow').checked ? memRequest() : null;
        worker.postMessage({ type: 'mem_watch', addr: req ? req.addr : null, len: req ? req.len : 0 });
    }

    // ===================================================================
    // --- Peripherals panel (esp-emu-peris) ---
    // ===================================================================
    const STORAGE_KEY = 'peris.config.v1';
    let perisRegistry = null;
    let perisConfig = { perisVersion: PERIS_API_VERSION, devices: [] };
    const perisViews = new Map(); // id -> { card, view, cfgKey }
    let perisIdSeq = 0;

    function perisPersist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(perisConfig));
        } catch (e) { /* storage unavailable */ }
    }

    function perisApply() {
        if (worker) worker.postMessage({ type: PERIS_CONFIG, config: perisConfig });
        perisPersist();
    }

    function perisSendCmd(id) {
        return (cmd, params) => worker.postMessage({ type: PERIS_COMMAND, id, cmd, params });
    }

    function usedPins(exceptId) {
        const used = new Set();
        for (const d of perisConfig.devices) {
            if (d.id === exceptId) continue;
            const meta = perisRegistry?.meta(d.type);
            if (meta?.pins) for (const p of meta.pins(d)) used.add(p);
        }
        return used;
    }

    function freePin(preferred) {
        const used = usedPins();
        const ok = validPins(machine.chip);
        if (preferred != null && !used.has(preferred) && ok.includes(preferred)) return preferred;
        for (const p of ok) if (!used.has(p)) return p;
        return null;
    }

    function renderPerisToolbar() {
        const sel = $('peris-add');
        sel.innerHTML = '';
        const groups = new Map();
        for (const t of (perisRegistry ? perisRegistry.types() : [])) {
            if (!groups.has(t.category)) groups.set(t.category, []);
            groups.get(t.category).push(t);
        }
        for (const [cat, types] of groups) {
            const og = document.createElement('optgroup');
            og.label = cat;
            for (const t of types) {
                const opt = document.createElement('option');
                opt.value = t.typeId;
                opt.textContent = t.title;
                opt.title = t.description;
                og.appendChild(opt);
            }
            sel.appendChild(og);
        }
    }

    function buildConfigEditor(card, devCfg, meta, onChange) {
        const editor = document.createElement('div');
        editor.className = 'dev-editor';
        const used = usedPins(devCfg.id);
        for (const field of meta.configSchema || []) {
            const row = document.createElement('label');
            row.className = 'dev-field';
            const lab = document.createElement('span');
            lab.textContent = field.label;
            row.appendChild(lab);
            let input;
            if (field.type === 'pin') {
                input = document.createElement('select');
                for (const p of validPins(machine.chip)) {
                    const opt = document.createElement('option');
                    opt.value = p; opt.textContent = `GPIO ${p}`;
                    if (used.has(p)) opt.textContent += ' (in use)';
                    input.appendChild(opt);
                }
                input.value = String(devCfg[field.key]);
                if (input.selectedIndex < 0 && input.options.length) input.value = input.options[0].value;
            } else if (field.type === 'checkbox') {
                input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = !!devCfg[field.key];
            } else if (field.type === 'color') {
                input = document.createElement('input');
                input.type = 'color';
                input.value = devCfg[field.key] || '#ff4d4d';
            } else if (field.type === 'select') {
                input = document.createElement('select');
                for (const o of field.options || []) {
                    const opt = document.createElement('option');
                    opt.value = o.value; opt.textContent = o.label;
                    input.appendChild(opt);
                }
                input.value = devCfg[field.key];
            } else { // text / number
                input = document.createElement('input');
                input.type = field.type === 'number' ? 'number' : 'text';
                input.value = devCfg[field.key] ?? '';
                if (field.min != null) input.min = field.min;
                if (field.max != null) input.max = field.max;
                if (field.step != null) input.step = field.step;
            }
            input.addEventListener('change', () => {
                let v = field.type === 'checkbox' ? input.checked : input.value;
                if (field.type === 'number') v = Number(v);
                if (field.type === 'pin') v = Number(v);
                devCfg[field.key] = v;
                onChange(field.key, v);
            });
            row.appendChild(input);
            editor.appendChild(row);
        }
        return editor;
    }

    function buildDeviceCard(devCfg) {
        const meta = perisRegistry.meta(devCfg.type);
        if (!meta) return null;
        const card = document.createElement('div');
        card.className = 'peris-card';
        card.dataset.id = devCfg.id;

        // header: title, type tag, remove
        const head = document.createElement('div');
        head.className = 'peris-card-head';
        head.innerHTML = `<span class="dev-title"></span><span class="dev-type">${meta.title} · ${devCfg.type}</span>`;
        const remove = document.createElement('button');
        remove.className = 'btn small dev-remove';
        remove.title = 'Remove device';
        remove.textContent = '×';
        head.appendChild(remove);
        card.appendChild(head);

        // body: the device's own View
        const body = document.createElement('div');
        card.appendChild(body);
        const ViewClass = perisRegistry.View(devCfg.type);
        let view = null;
        if (ViewClass) {
            view = new ViewClass(body, perisSendCmd(devCfg.id));
            view.setConfig?.(devCfg);
        }

        // config editor
        const editor = buildConfigEditor(card, devCfg, meta, () => {
            perisApply();
            view?.setConfig?.(devCfg);
            renderCardTitles();
        });
        card.appendChild(editor);

        remove.addEventListener('click', () => {
            perisConfig.devices = perisConfig.devices.filter((d) => d.id !== devCfg.id);
            perisViews.delete(devCfg.id);
            card.remove();
            perisApply();
            renderPerisEmpty();
        });

        $('peris-cards').appendChild(card);
        perisViews.set(devCfg.id, { card, view });
        return { card, view };
    }

    function renderCardTitles() {
        for (const d of perisConfig.devices) {
            const v = perisViews.get(d.id);
            if (v) v.card.querySelector('.dev-title').textContent = d.name || d.type;
        }
    }

    function renderPerisEmpty() {
        $('peris-empty').style.display = perisConfig.devices.length ? 'none' : '';
    }

    function renderPerisPanel() {
        const list = $('peris-cards');
        list.innerHTML = '';
        perisViews.clear();
        for (const devCfg of perisConfig.devices) {
            const meta = perisRegistry?.meta(devCfg.type);
            if (!meta) continue;
            const cfg = normaliseConfig(meta, devCfg);
            Object.assign(devCfg, cfg); // drop unknown keys
            buildDeviceCard(devCfg);
        }
        renderCardTitles();
        renderPerisEmpty();
        perisApply();
    }

    function perisAddDevice(type) {
        const meta = perisRegistry.meta(type);
        if (!meta) return;
        // unique id
        let id;
        do { id = `${type}-${++perisIdSeq}`; } while (perisConfig.devices.some((d) => d.id === id));
        const cfg = { id, type, ...normaliseConfig(meta, {}) };
        // pick a free pin for the first 'pin' schema field
        const pinField = (meta.configSchema || []).find((f) => f.type === 'pin');
        if (pinField) cfg[pinField.key] = freePin(cfg[pinField.key]);
        perisConfig.devices.push(cfg);
        buildDeviceCard(cfg);
        renderCardTitles();
        renderPerisEmpty();
        perisApply();
        // open the card's editor for immediate pin choice
        perisViews.get(id)?.card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function perisExport() {
        const data = JSON.stringify({ ...perisConfig, chip: machine.chip }, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `peris-${machine.chip}-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    function perisImport(file) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (!Array.isArray(data.devices)) throw new Error('no devices array');
                if (data.perisVersion !== PERIS_API_VERSION) throw new Error(`unsupported perisVersion ${data.perisVersion}`);
                if (!perisRegistry) throw new Error('registry not loaded');
                let seq = perisIdSeq;
                const devices = data.devices.map((d) => {
                    if (!perisRegistry.has(d.type)) throw new Error(`unknown device type "${d.type}"`);
                    if (!d.id) d.id = `imp-${++seq}`;
                    return normaliseConfig(perisRegistry.meta(d.type), d);
                });
                perisIdSeq = seq;
                perisConfig = { perisVersion: PERIS_API_VERSION, devices };
                renderPerisPanel();
                if (terminal) terminal.writeln(`\x1b[36m[Peris] Imported ${devices.length} device(s) from ${file.name}\x1b[0m`);
            } catch (e) {
                if (terminal) terminal.writeln(`\x1b[31m[Peris] Import failed: ${e.message}\x1b[0m`);
            }
        };
        reader.readAsText(file);
    }

    function initPerisPanel() {
        // tabs
        const tabs = document.querySelectorAll('.ptab');
        const panes = { peris: $('pane-peris'), debug: $('pane-debug') };
        for (const tab of tabs) {
            tab.addEventListener('click', () => {
                for (const t of tabs) t.classList.toggle('active', t === tab);
                for (const [name, pane] of Object.entries(panes)) {
                    pane.classList.toggle('hidden', name !== tab.dataset.pane);
                }
                if (tab.dataset.pane === 'debug') drawChart();
            });
        }

        $('peris-add-btn').addEventListener('click', () => {
            const t = $('peris-add').value;
            if (t) perisAddDevice(t);
        });
        $('peris-export-btn').addEventListener('click', perisExport);
        $('peris-import-btn').addEventListener('click', () => $('peris-import-file').click());
        $('peris-import-file').addEventListener('change', (e) => {
            const f = e.target.files[0];
            if (f) perisImport(f);
            e.target.value = '';
        });
        // Config files are also drop targets.
        const cards = $('pane-peris');
        cards.addEventListener('dragover', (e) => { e.preventDefault(); cards.classList.add('over'); });
        cards.addEventListener('dragleave', () => cards.classList.remove('over'));
        cards.addEventListener('drop', (e) => {
            e.preventDefault();
            cards.classList.remove('over');
            const f = e.dataTransfer.files && e.dataTransfer.files[0];
            if (f && f.name.endsWith('.json')) perisImport(f);
        });

        // restore autosaved config
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
            if (saved && Array.isArray(saved.devices)) {
                perisConfig = { perisVersion: PERIS_API_VERSION, devices: saved.devices };
            }
        } catch (e) { /* ignore */ }

        loadRegistry(import.meta.url).then((reg) => {
            perisRegistry = reg;
            if (reg.errors.length) {
                terminal.writeln(`\x1b[33m[Peris] Device registry warnings: ${reg.errors.join('; ')}\x1b[0m`);
            }
            renderPerisToolbar();
            renderPerisPanel();
            terminal.writeln(`\x1b[32m[Peris] ${reg.types().length} device type(s) ready — add peripherals in the Peripherals tab.\x1b[0m`);
        }).catch((e) => {
            terminal.writeln(`\x1b[31m[Peris] Registry load failed: ${e.message}\x1b[0m`);
        });
    }

    function handlePerisMessage(msg) {
        switch (msg.type) {
            case PERIS_READY: {
                const box = $('peris-errors');
                if (msg.errors && msg.errors.length) {
                    box.innerHTML = msg.errors.map((e) => `⚠ ${e}`).join('');
                    box.style.display = 'block'; // CSS default is display:none
                } else {
                    box.style.display = 'none';
                    box.textContent = '';
                }
                break;
            }
            case PERIS_STATE: {
                const v = perisViews.get(msg.id);
                if (v?.view) v.view.render(msg.state);
                break;
            }
            case PERIS_LOG: {
                const color = msg.level === 'error' ? '31' : msg.level === 'warn' ? '33' : '36';
                terminal.writeln(`\x1b[${color}m[Peris] ${msg.text}\x1b[0m`);
                break;
            }
        }
    }

    // --- Worker ---
    function applyMachineInfo(msg) {
        machine = {
            chip: msg.chip || machine.chip,
            isXtensa: !!msg.isXtensa,
            numHarts: msg.numHarts || 1,
            cyclesPerUs: msg.cyclesPerUs || machine.cyclesPerUs,
        };
    }

    function initWorker() {
        terminal.writeln('\x1b[90m[System] Initializing WASM module...\x1b[0m');

        try {
            // Worker URLs resolve against the page, not this module.
            worker = new Worker('peris/worker.js', { type: 'module' });
        } catch (e) {
            terminal.writeln(`\x1b[31m[Error] Failed to create worker: ${e.message}\x1b[0m`);
            terminal.writeln('\x1b[31m[Error] Make sure you are serving via HTTP (not file://)\x1b[0m');
            return;
        }

        worker.onerror = function(e) {
            terminal.writeln(`\x1b[31m[Error] Worker failed: ${e.message || e}\x1b[0m`);
            terminal.writeln('\x1b[31m[Error] Check browser console (F12) for details\x1b[0m');
        };

        worker.onmessage = function(e) {
            const msg = e.data;
            switch (msg.type) {
                case 'ready':
                    terminal.writeln('\x1b[32m[System] WASM module loaded\x1b[0m');
                    break;

                case 'loaded':
                    applyMachineInfo(msg);
                    firmwareLoaded = true;
                    samples.length = 0;
                    initRegTable();
                    initGpioPanel();
                    renderCores([msg.pc]);
                    updateTimeTiles(0);
                    updateButtons();
                    perisApply(); // re-apply devices on the fresh emulator
                    terminal.writeln(`\x1b[32m[System] Firmware loaded, PC=0x${msg.pc.toString(16)}\x1b[0m`);
                    terminal.writeln('');
                    setStatus('ready', 'Ready');
                    break;

                case 'uart_output':
                    uartOut(msg.data);
                    break;

                case 'status':
                    recordStatus(msg);
                    break;

                case 'snapshot':
                    updateRegisters(msg.regs);
                    renderCores(msg.pcs);
                    updateGpio(msg.gpio);
                    if (msg.mem) renderMem(msg.mem.addr, msg.mem.bytes);
                    break;

                case 'mem':
                    renderMem(msg.addr, msg.bytes);
                    break;

                case 'step':
                    if (msg.output) uartOut(msg.output);
                    $('cycle-display').textContent = `${formatCycles(msg.cycles)} cycles`;
                    $('tile-cycles').textContent = formatCycles(msg.cycles);
                    updateTimeTiles(msg.cycles);
                    break;

                case 'restarted':
                    if (msg.numHarts) applyMachineInfo({ ...machine, ...msg });
                    terminal.writeln('\x1b[33m[System] Software restart (esp_restart)\x1b[0m');
                    break;

                case 'reset':
                    terminal.clear();
                    isRunning = false;
                    samples.length = 0;
                    drawChart();
                    if (msg.reloaded) {
                        applyMachineInfo({ ...machine, ...msg });
                        terminal.writeln('\x1b[33m[System] Emulator reset\x1b[0m');
                        terminal.writeln(`\x1b[32m[System] Firmware reloaded, PC=0x${msg.pc.toString(16)}\x1b[0m`);
                        firmwareLoaded = true;
                        renderCores([msg.pc]);
                        updateTimeTiles(0);
                        setStatus('ready', 'Ready');
                    } else {
                        terminal.writeln('\x1b[33m[System] Emulator reset (no firmware)\x1b[0m');
                        firmwareLoaded = false;
                        setStatus('idle', 'Reset');
                    }
                    updateButtons();
                    break;

                case 'net_status': {
                    netConnected = msg.connected;
                    const netBtn = $('net-btn');
                    if (msg.connected) {
                        terminal.writeln('\x1b[32m[Network] Connected to WebSocket proxy\x1b[0m');
                        netBtn.textContent = 'Disconnect';
                        netBtn.classList.add('primary');
                    } else {
                        terminal.writeln('\x1b[33m[Network] Disconnected\x1b[0m');
                        netBtn.textContent = 'Connect';
                        netBtn.classList.remove('primary');
                    }
                    break;
                }

                case 'error':
                    terminal.writeln(`\x1b[31m[Error] ${msg.message}\x1b[0m`);
                    break;

                default:
                    handlePerisMessage(msg);
                    break;
            }
        };

        // absolute so the worker (living in peris/) resolves the wasm pkg
        worker.postMessage({ type: 'init', wasmUrl: new URL('pkg/esp_emu.js', document.baseURI).href });
    }

    // --- Controls ---
    function updateButtons() {
        $('run-btn').disabled = !firmwareLoaded || isRunning;
        $('pause-btn').disabled = !isRunning;
        $('step-btn').disabled = !firmwareLoaded || isRunning;
        $('reset-btn').disabled = !firmwareLoaded;
    }

    async function loadFirmwareFile(file) {
        if (!file) return;
        const chip = $('chip-select').value;
        const buffer = await file.arrayBuffer();
        terminal.writeln(`\x1b[36m[System] Loading ${file.name} (${buffer.byteLength} bytes) for ${chip}...\x1b[0m`);
        $('fw-name').textContent = `${file.name} · ${formatBytes(buffer.byteLength)}`;
        $('fw-drop-text').innerHTML = '<strong>Replace</strong> with another .bin';

        if (isRunning) {
            isRunning = false;
            worker.postMessage({ type: 'stop' });
        }
        uartBytes = 0;
        $('uart-count').textContent = '0 B';

        const transferList = [buffer];
        const msg = {
            type: 'load',
            chip: chip,
            firmware: buffer,
            ssid: $('wifi-ssid').value,
            password: $('wifi-password').value,
        };
        if (romData) {
            const romCopy = romData.slice(0);
            msg.rom = romCopy;
            transferList.push(romCopy);
        }
        if (worker) {
            worker.postMessage(msg, transferList);
        }
    }

    function setupDropTargets() {
        const targets = [$('fw-drop'), $('terminal-container')];
        for (const el of targets) {
            el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
            el.addEventListener('dragleave', () => el.classList.remove('over'));
            el.addEventListener('drop', (e) => {
                e.preventDefault();
                el.classList.remove('over');
                const file = e.dataTransfer.files && e.dataTransfer.files[0];
                if (file) loadFirmwareFile(file);
            });
        }
    }

    function setupControls() {
        // ROM ELF upload (optional — overrides the chip's embedded default)
        $('rom-file').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            romData = await file.arrayBuffer();
            romFilename = file.name;
            terminal.writeln(`\x1b[36m[System] ROM ELF override loaded: ${file.name} (${romData.byteLength} bytes)\x1b[0m`);
            updateRomBtnLabel();
        });

        // Reflect the embedded default in the ROM button when the chip changes.
        $('chip-select').addEventListener('change', updateRomBtnLabel);
        updateRomBtnLabel();

        $('firmware-file').addEventListener('change', (e) => loadFirmwareFile(e.target.files[0]));
        setupDropTargets();

        $('run-btn').addEventListener('click', () => {
            isRunning = true;
            updateButtons();
            worker.postMessage({ type: 'start' });
            setStatus('running', 'Running');
            pushMemWatch();
        });

        $('pause-btn').addEventListener('click', () => {
            isRunning = false;
            updateButtons();
            worker.postMessage({ type: 'stop' });
            setStatus('paused', 'Paused');
        });

        $('step-btn').addEventListener('click', () => {
            worker.postMessage({ type: 'step' });
        });

        $('reset-btn').addEventListener('click', () => {
            const chip = $('chip-select').value;
            worker.postMessage({ type: 'reset', chip: chip });
        });

        $('clear-btn').addEventListener('click', () => terminal.clear());

        // Network connect/disconnect. A page served over HTTPS cannot open a
        // ws:// socket to localhost, so the hosted build explains instead.
        const secure = location.protocol === 'https:';
        if (secure) {
            $('net-url').disabled = true;
            $('net-btn').disabled = true;
            $('net-note').className = 'note warn';
            $('net-note').textContent = 'Not available from an HTTPS page: browsers block the ws:// link to a local proxy. Run the page from a local server to use networking.';
        }
        $('net-btn').addEventListener('click', () => {
            if (netConnected) {
                worker.postMessage({ type: 'net_disconnect' });
            } else {
                worker.postMessage({ type: 'net_connect', url: $('net-url').value });
            }
        });

        // Memory inspector
        const readMem = () => {
            const req = memRequest();
            if (req && worker && firmwareLoaded) worker.postMessage({ type: 'read_mem', addr: req.addr, len: req.len });
            pushMemWatch();
        };
        $('mem-read-btn').addEventListener('click', readMem);
        $('mem-addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') readMem(); });
        $('mem-len').addEventListener('change', readMem);
        $('mem-follow').addEventListener('change', pushMemWatch);
    }

    // --- Init ---
    document.addEventListener('DOMContentLoaded', () => {
        initTerminal();
        initChart();
        initGpioPanel();
        initRegTable();
        renderCores([]);
        setupControls();
        initPerisPanel();
        initWorker();
    });
})();
