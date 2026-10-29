/*
 * Debug tab readouts: cores, GPIO grid, register table, memory inspector.
 * All driven by worker snapshots / explicit reads; input side (gpio_input,
 * read_mem, mem_watch) goes through the injected send callback.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

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
const XT_WINDOW_ROLES: Record<string, string> = { a0: 'ret', a1: 'sp' };
const XT_SPECIAL_NAMES = [
    'ps', 'sar', 'windowbase', 'windowstart',
    'exccause', 'excvaddr', 'epc1', 'lbeg', 'lend', 'lcount',
];

const hex8 = (v: number) => (v >>> 0).toString(16).padStart(8, '0');

export interface DebugDeps {
    send(msg: any): void;
    getChip(): string;
    firmwareLoaded(): boolean;
}

export class DebugPanels {
    private gpioPins: HTMLElement[] = [];
    private gpioInputLevels: boolean[] = [];
    private regCells: HTMLElement[] = [];
    private lastRegs: number[] | null = null;
    private isXtensa = false;

    constructor(private deps: DebugDeps) {
        this.wireMemControls();
    }

    // ---- cores ----
    renderCores(pcs: number[], chip: string) {
        const box = document.getElementById('cores')!;
        box.innerHTML = '';
        const total = (chip === 'esp32p4' || chip === 'esp32s3' || chip === 'esp32s31') ? 2 : 1;
        for (let h = 0; h < total; h++) {
            const el = document.createElement('div');
            const live = h < pcs.length;
            el.className = 'core' + (live ? '' : ' idle');
            el.innerHTML = `<div class="k"><span>Core ${h}</span><span>${live ? 'running' : 'held in reset'}</span></div>` +
                           `<div class="v">pc 0x${live ? hex8(pcs[h]) : '--------'}</div>`;
            box.appendChild(el);
        }
    }

    // ---- GPIO grid ----
    initGpioPanel(chip: string, counts: { count: number; absent: ReadonlySet<number> }) {
        const grid = document.getElementById('gpio-grid')!;
        grid.innerHTML = '';
        this.gpioPins = [];
        document.getElementById('gpio-count')!.textContent = `${counts.count - counts.absent.size} pins`;
        this.gpioInputLevels = new Array(counts.count).fill(true);
        for (let i = 0; i < counts.count; i++) {
            const pin = document.createElement('div');
            pin.className = 'gpio-pin in high' + (counts.absent.has(i) ? ' absent' : '');
            pin.textContent = String(i);
            pin.title = `GPIO${i} — input, high (pull-up)`;
            pin.addEventListener('click', () => this.toggleGpioInput(i));
            grid.appendChild(pin);
            this.gpioPins.push(pin);
        }
    }

    private toggleGpioInput(pin: number) {
        const el = this.gpioPins[pin];
        if (!el || el.classList.contains('out') || !this.deps.firmwareLoaded()) return;
        this.gpioInputLevels[pin] = !this.gpioInputLevels[pin];
        this.deps.send({ type: 'gpio_input', pin, high: this.gpioInputLevels[pin] });
        this.paintGpioPin(pin, false, this.gpioInputLevels[pin]);
    }

    private paintGpioPin(i: number, isOut: boolean, high: boolean) {
        const el = this.gpioPins[i];
        if (!el) return;
        el.classList.toggle('out', isOut);
        el.classList.toggle('in', !isOut);
        el.classList.toggle('high', high);
        el.classList.toggle('low', !high);
        el.title = isOut
            ? `GPIO${i} — output, driven ${high ? 'high' : 'low'} by firmware`
            : `GPIO${i} — input, ${high ? 'high' : 'low'} (click to toggle)`;
    }

    updateGpio(state: number[] | ArrayLike<number>) {
        // state = [out_lo, out_hi, enable_lo, enable_hi]
        for (let i = 0; i < this.gpioPins.length; i++) {
            const word = i < 32 ? 0 : 1, bit = i & 31;
            const isOut = ((state[2 + word] >>> bit) & 1) === 1;
            const high = isOut ? ((state[word] >>> bit) & 1) === 1 : this.gpioInputLevels[i];
            this.paintGpioPin(i, isOut, high);
        }
    }

    // ---- registers ----
    initRegTable(isXtensa: boolean, chip: string) {
        this.isXtensa = isXtensa;
        const table = document.getElementById('reg-table')!;
        table.innerHTML = '';
        this.regCells = [];
        this.lastRegs = null;
        const tbody = document.createElement('tbody');
        const cell = (name: string) => {
            const td = document.createElement('td');
            td.className = 'val';
            td.textContent = '00000000';
            this.regCells.push(td);
            const nameTd = document.createElement('td');
            nameTd.className = 'name';
            nameTd.textContent = name;
            return [nameTd, td];
        };
        const addRow = (names: Array<string | null>, sep?: boolean) => {
            const tr = document.createElement('tr');
            if (sep) tr.className = 'sep';
            for (const n of names) {
                if (n == null) { tr.appendChild(document.createElement('td')); tr.appendChild(document.createElement('td')); continue; }
                for (const td of cell(n)) tr.appendChild(td);
            }
            tbody.appendChild(tr);
        };

        if (isXtensa) {
            document.getElementById('isa-tag')!.textContent = 'Xtensa LX7';
            document.getElementById('reg-tag')!.textContent = 'core 0 · window';
            for (let i = 0; i < 8; i++) {
                const a = XT_WINDOW_NAMES[i], b = XT_WINDOW_NAMES[i + 8];
                const label = (n: string) => XT_WINDOW_ROLES[n] ? `${n} (${XT_WINDOW_ROLES[n]})` : n;
                addRow([label(a), label(b)]);
            }
            for (let i = 0; i < XT_SPECIAL_NAMES.length; i += 2) {
                addRow([XT_SPECIAL_NAMES[i], XT_SPECIAL_NAMES[i + 1] ?? null], i === 0);
            }
        } else {
            document.getElementById('isa-tag')!.textContent =
                chip === 'esp32p4' || chip === 'esp32s31' ? 'RV32IMAFC' : 'RV32IMAC';
            document.getElementById('reg-tag')!.textContent = 'hart 0';
            for (let i = 0; i < 16; i++) {
                addRow([`x${i} (${RV_REG_NAMES[i]})`, `x${i + 16} (${RV_REG_NAMES[i + 16]})`]);
            }
        }
        table.appendChild(tbody);
    }

    updateRegisters(regs: number[] | ArrayLike<number>) {
        // Cells were pushed row by row (left, right); map register index to
        // the cell holding it.
        const order = this.cellOrder(regs.length);
        for (let k = 0; k < order.length; k++) {
            const idx = order[k];
            const td = this.regCells[k];
            if (!td || idx == null || idx >= regs.length) continue;
            const text = hex8(regs[idx]);
            const changed = this.lastRegs && this.lastRegs[idx] !== regs[idx];
            if (td.textContent !== text) td.textContent = text;
            if (changed) {
                td.classList.remove('changed');
                void td.offsetWidth; // restart the fade
                td.classList.add('changed');
                setTimeout(() => td.classList.remove('changed'), 50);
            }
        }
        this.lastRegs = Array.from(regs);
    }

    // Register index at each cell position, matching initRegTable's layout.
    private cellOrder(n: number): number[] {
        const out: number[] = [];
        if (this.isXtensa) {
            for (let i = 0; i < 8; i++) out.push(i, i + 8);
            for (let i = 16; i < n; i++) out.push(i);
        } else {
            for (let i = 0; i < 16; i++) out.push(i, i + 16);
        }
        return out;
    }

    // ---- memory inspector ----
    private parseAddr(text: string): number | null {
        const t = text.trim().replace(/_/g, '').replace(/^0x/i, '');
        if (!/^[0-9a-f]{1,8}$/i.test(t)) return null;
        return parseInt(t, 16) >>> 0;
    }

    renderMem(addr: number, bytes: Uint8Array | number[]) {
        const out: string[] = [];
        for (let off = 0; off < bytes.length; off += 16) {
            const row = Array.from(bytes.slice(off, off + 16));
            let hexs = '', ascii = '';
            for (let i = 0; i < 16; i++) {
                if (i < row.length) {
                    const b = row[i];
                    const h = b.toString(16).padStart(2, '0');
                    hexs += (b === 0 ? `<span class="zero">${h}</span>` : h) + (i === 7 ? '  ' : ' ');
                    ascii += b >= 0x20 && b < 0x7f
                        ? String.fromCharCode(b).replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))
                        : '.';
                } else {
                    hexs += '   ' + (i === 7 ? ' ' : '');
                }
            }
            out.push(`<span class="addr">${hex8(addr + off)}</span>  ${hexs} <span class="ascii">|${ascii}|</span>`);
        }
        document.getElementById('mem-display')!.innerHTML = out.join('\n');
    }

    private memRequest(): { addr: number; len: number } | null {
        const addr = this.parseAddr((document.getElementById('mem-addr') as HTMLInputElement).value);
        const len = parseInt((document.getElementById('mem-len') as HTMLSelectElement).value, 10);
        if (addr == null) {
            document.getElementById('mem-display')!.innerHTML =
                '<span class="empty">Enter a hex address, e.g. 0x3FC80000.</span>';
            return null;
        }
        return { addr, len };
    }

    private readMem() {
        const req = this.memRequest();
        if (req && this.deps.firmwareLoaded()) {
            this.deps.send({ type: 'read_mem', addr: req.addr, len: req.len });
        }
        this.pushMemWatch();
    }

    pushMemWatch() {
        const follow = (document.getElementById('mem-follow') as HTMLInputElement).checked;
        const req = follow ? this.memRequest() : null;
        this.deps.send({ type: 'mem_watch', addr: req ? req.addr : null, len: req ? req.len : 0 });
    }

    private wireMemControls() {
        const readMem = () => this.readMem();
        document.getElementById('mem-read-btn')!.addEventListener('click', readMem);
        document.getElementById('mem-addr')!.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Enter') readMem();
        });
        document.getElementById('mem-len')!.addEventListener('change', readMem);
        document.getElementById('mem-follow')!.addEventListener('change', () => this.pushMemWatch());
    }
}
