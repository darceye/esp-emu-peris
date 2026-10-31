/*
 * Peripherals panel: one compact row per device (interactive icon · name ·
 * GPIO chip · V/G pull badge, right-aligned expand/remove/drag) with an
 * expandable details area holding the device View body and the generic
 * config editor. Also owns add/remove, drag-sort, wiring-config
 * import/export + localStorage autosave and the peris_* message handlers
 * (peris_ready / peris_state / peris_log).
 */
import { loadRegistry } from '../core/registry.js';
import type { Registry } from '../core/registry.js';
import { normaliseConfig } from '../core/types.js';
import type { DeviceConfig, DeviceMeta, PerisConfig, ViewClass, ViewHost, ViewLike } from '../core/types.js';
import { PERIS_API_VERSION, PERIS_CONFIG, PERIS_COMMAND, PERIS_READY, PERIS_STATE, PERIS_LOG } from '../core/protocol.js';
import type { PerisEvent } from '../core/protocol.js';
import { validPins } from '../core/chips.js';
import { buildConfigEditor, fillPinOptions, rowChips } from './config-editor.js';
import type { TerminalView } from './terminal.js';

const STORAGE_KEY = 'peris.config.v1';
const EXPORT_NAME_KEY = 'peris.exportName.v1';

/**
 * Firmware provenance recorded in exported configs (informational only —
 * import ignores it). Browsers do not expose a file's full disk path;
 * `path` is filled only when the host environment provides a non-standard
 * `File.path`/`filePath` property.
 */
export interface FirmwareInfo {
    name: string;
    size: number;
    path?: string;
}

export interface PerisPanelDeps {
    send(msg: unknown): void;
    getChip(): string;
    /** Last loaded firmware's name/size(/path), or null before any load. */
    firmwareInfo(): FirmwareInfo | null;
    /** Select the target chip (restoring a cached wiring's chip). */
    selectChip(chip: string): void;
    terminal: TerminalView;
}

/**
 * Compose the export file name from the user-set base: illegal filename
 * characters are stripped, a single .json suffix is enforced. Empty base
 * falls back to the auto name peris-{chip}-{yyyy-mm-dd}.json.
 * (Pure — unit-tested.)
 */
export function exportFileName(custom: string, chip: string, date = new Date()): string {
    const base = custom.trim().replace(/[\\/:*?"<>|]/g, '').replace(/\.json$/i, '');
    if (base) return `${base}.json`;
    return `peris-${chip}-${date.toISOString().slice(0, 10)}.json`;
}

interface RowEntry { row: HTMLElement; view: ViewLike | null; }

export class PerisPanel {
    private registry: Registry | null = null;
    private config: PerisConfig = { perisVersion: PERIS_API_VERSION, devices: [] };
    private views = new Map<string, RowEntry>();
    private expanded = new Set<string>();
    private dragRow: HTMLElement | null = null;
    private idSeq = 0;
    /** Chip the detail editors were built for (refreshForChip rebuilds on change). */
    private editorChip = '';

    constructor(private deps: PerisPanelDeps) {
        this.wireToolbar();
        this.wireDrag();
        this.restore();
    }

    /** Load the device registry, render toolbar + rows, apply to worker. */
    async init() {
        const reg = await loadRegistry();
        this.registry = reg;
        if (reg.errors.length) {
            this.deps.terminal.writeln(`\x1b[33m[Peris] Device registry warnings: ${reg.errors.join('; ')}\x1b[0m`);
        }
        this.renderToolbar();
        this.renderAll();
        this.deps.terminal.writeln(
            `\x1b[32m[Peris] ${reg.types().length} device type(s) ready — add peripherals in the Peripherals panel.\x1b[0m`);
    }

    // ---- worker message handling ----

    handlePerisMessage(msg: PerisEvent) {
        switch (msg.type) {
            case PERIS_READY: {
                const box = document.getElementById('peris-errors')!;
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
                const v = this.views.get(msg.id);
                if (v?.view) v.view.render(msg.state);
                break;
            }
            case PERIS_LOG: {
                const color = msg.level === 'error' ? '31' : msg.level === 'warn' ? '33' : '36';
                this.deps.terminal.writeln(`\x1b[${color}m[Peris] ${msg.text}\x1b[0m`);
                break;
            }
        }
    }

    /** Re-apply the config after the worker loaded a fresh emulator. */
    reapplyOnLoad() {
        this.refreshForChip();
        this.apply();
    }

    // ---- config lifecycle ----

    private apply() {
        this.deps.send({ type: PERIS_CONFIG, config: this.config });
        this.persist();
    }

    private persist() {
        try {
            // chip rides along so the next session can re-select it (restore)
            localStorage.setItem(STORAGE_KEY,
                JSON.stringify({ ...this.config, chip: this.deps.getChip() }));
        } catch { /* storage unavailable */ }
    }

    private restore() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as PerisConfig | null;
            if (saved && Array.isArray(saved.devices)) {
                this.config = { perisVersion: PERIS_API_VERSION, devices: saved.devices };
                if (typeof saved.chip === 'string' && saved.chip) this.deps.selectChip(saved.chip);
            }
        } catch { /* ignore */ }
    }

    // ---- rows ----

    /**
     * Pins claimed by other devices, from the perspective of `candidate`
     * (the device about to use the set): sharedBus devices ignore each
     * other's pins — two I2C slaves on one bus is legal wiring.
     */
    private usedPins(exceptId: string, candidate?: DeviceMeta | null): Set<number> {
        const used = new Set<number>();
        for (const d of this.config.devices) {
            if (d.id === exceptId) continue;
            const meta = this.registry?.meta(d.type);
            if (!meta) continue;
            if (candidate?.sharedBus && meta.sharedBus) continue;
            for (const p of meta.pins(d)) used.add(p);
        }
        return used;
    }

    private freePin(preferred: number | undefined, candidate?: DeviceMeta | null): number | null {
        const used = this.usedPins('', candidate);
        const ok = validPins(this.deps.getChip());
        if (preferred != null && !used.has(preferred) && ok.includes(preferred)) return preferred;
        for (const p of ok) if (!used.has(p)) return p;
        return null;
    }

    private renderToolbar() {
        const sel = document.getElementById('peris-add') as HTMLSelectElement;
        sel.innerHTML = '';
        const groups = new Map<string, Array<{ typeId: string; title: string; description: string }>>();
        for (const t of this.registry ? this.registry.types() : []) {
            if (!groups.has(t.category)) groups.set(t.category, []);
            groups.get(t.category)!.push(t);
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

    private buildDeviceRow(devCfg: DeviceConfig): RowEntry | null {
        const meta = this.registry?.meta(devCfg.type);
        if (!meta) return null;
        const row = document.createElement('div');
        row.className = 'peris-row' + (this.expanded.has(devCfg.id) ? ' open' : '');
        row.dataset.id = devCfg.id;

        // ---- the one-line main row ----
        const main = document.createElement('div');
        main.className = 'peris-row-main';

        const icon = document.createElement('span');
        icon.className = 'dev-icon';
        main.appendChild(icon);

        const nameSlot = document.createElement('span');
        nameSlot.className = 'dev-name-slot';
        main.appendChild(nameSlot);

        const chips = rowChips(meta, devCfg);
        if (chips.pinKey != null) {
            const pinSlot = document.createElement('span');
            pinSlot.className = 'dev-chip-slot';
            main.appendChild(pinSlot);
        }
        if (chips.pullKey != null) {
            const pullBtn = document.createElement('button');
            pullBtn.type = 'button';
            pullBtn.className = 'dev-chip dev-chip-pull';
            pullBtn.title = 'Idle pull level — click to flip (V = pull-up to VCC, G = pull-down to GND)';
            pullBtn.addEventListener('click', () => {
                devCfg[chips.pullKey!] = !devCfg[chips.pullKey!];
                this.apply();
                this.views.get(devCfg.id)?.view?.setConfig?.(devCfg);
                this.renderRows();
            });
            main.appendChild(pullBtn);
        }

        const spacer = document.createElement('span');
        spacer.className = 'row-spacer';
        main.appendChild(spacer);

        const expand = document.createElement('button');
        expand.type = 'button';
        expand.className = 'row-btn row-expand';
        expand.title = 'Show / hide details';
        expand.innerHTML = `<svg viewBox="0 0 10 10" width="10" height="10"><path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        expand.addEventListener('click', () => {
            const open = row.classList.toggle('open');
            if (open) this.expanded.add(devCfg.id);
            else this.expanded.delete(devCfg.id);
        });
        main.appendChild(expand);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'row-btn row-remove';
        remove.title = 'Remove device';
        remove.textContent = '×';
        remove.addEventListener('click', () => {
            this.config.devices = this.config.devices.filter((d) => d.id !== devCfg.id);
            this.views.delete(devCfg.id);
            this.expanded.delete(devCfg.id);
            row.remove();
            this.apply();
            this.renderEmpty();
        });
        main.appendChild(remove);

        const grip = document.createElement('span');
        grip.className = 'row-grip';
        grip.title = 'Drag to reorder';
        grip.textContent = '⠿';
        // Dragging is armed only while the grip is held, so clicks on the
        // other controls never start a drag.
        grip.addEventListener('pointerdown', () => { row.draggable = true; });
        row.addEventListener('pointerup', () => { row.draggable = false; });
        row.addEventListener('dragstart', (e) => {
            this.dragRow = row;
            row.classList.add('dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', devCfg.id);
            }
        });
        row.addEventListener('dragend', () => {
            row.draggable = false;
            row.classList.remove('dragging');
            this.dragRow = null;
            this.commitOrder();
        });
        main.appendChild(grip);
        row.appendChild(main);

        // ---- expandable details: the device's own View + config editor ----
        const details = document.createElement('div');
        details.className = 'peris-details';
        const bodyWrap = document.createElement('div');
        bodyWrap.className = 'dev-body-wrap';
        const body = document.createElement('div');
        bodyWrap.appendChild(body);
        details.appendChild(bodyWrap);

        let view: ViewLike | null = null;
        const host: ViewHost = {
            updateConfig: (patch) => {
                Object.assign(devCfg, patch);
                this.apply();
                view?.setConfig?.(devCfg);
                this.renderRows();
            },
        };
        const ViewClass: ViewClass | undefined = this.registry?.View(devCfg.type);
        if (ViewClass) {
            view = new ViewClass(body, (cmd, params) =>
                this.deps.send({ type: PERIS_COMMAND, id: devCfg.id, cmd, params }), host);
            // rowIcon first, then setConfig: the icon exists when config
            // styling is applied, so both visuals stay in lock-step.
            view.rowIcon?.(icon);
            view.setConfig?.(devCfg);
        } else {
            icon.classList.add('dev-icon-plain');
            icon.title = meta.title;
            icon.textContent = meta.title.charAt(0).toUpperCase();
        }

        row.appendChild(details);
        this.attachEditor(row, devCfg, view); // after details is attached

        document.getElementById('peris-cards')!.appendChild(row);
        const entry: RowEntry = { row, view };
        this.views.set(devCfg.id, entry);
        this.updateRow(row, devCfg);
        return entry;
    }

    /**
     * (Re)build the details config editor for a row. Pin options snapshot
     * the chip at build time, so this is also how a chip change reaches
     * the editors — see refreshForChip().
     */
    private attachEditor(row: HTMLElement, devCfg: DeviceConfig, view: ViewLike | null) {
        const meta = this.registry?.meta(devCfg.type);
        const details = row.querySelector('.peris-details');
        if (!meta || !details) return;
        details.querySelector('.dev-editor')?.remove();
        const editor = buildConfigEditor(devCfg, meta, {
            validPins: validPins(this.deps.getChip()),
            // pin options are candidate-aware: bus devices may share pins
            usedPins: (id) => this.usedPins(id, meta),
            onChange: () => {
                this.apply();
                view?.setConfig?.(devCfg);
                this.renderRows();
            },
        });
        details.appendChild(editor);
    }

    /**
     * Rebuild the detail editors when the active chip changed (loading
     * firmware for another chip after devices were added). The row's inline
     * pin chip already asks the chip live; the editors must be rebuilt.
     */
    refreshForChip() {
        const chip = this.deps.getChip();
        if (chip === this.editorChip) return;
        this.editorChip = chip;
        for (const d of this.config.devices) {
            const entry = this.views.get(d.id);
            if (entry) this.attachEditor(entry.row, d, entry.view);
        }
    }

    /** Refresh one row's inline name/pin/pull chips. Slots currently holding
     * an inline editor (input/select) are skipped; a slot emptied by a
     * finished editor gets its button rebuilt here.
     */
    private updateRow(row: HTMLElement, devCfg: DeviceConfig) {
        const meta = this.registry?.meta(devCfg.type);
        if (!meta) return;
        const chips = rowChips(meta, devCfg);

        const nameSlot = row.querySelector<HTMLElement>('.dev-name-slot');
        if (nameSlot && !nameSlot.querySelector('input')) {
            let btn = nameSlot.querySelector<HTMLButtonElement>('.dev-name');
            if (!btn) {
                btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'dev-name';
                btn.title = 'Rename';
                btn.addEventListener('click', () => this.editName(nameSlot, devCfg));
                nameSlot.replaceChildren(btn);
            }
            btn.textContent = String(devCfg.name ?? devCfg.type);
        }

        const pinSlot = row.querySelector<HTMLElement>('.dev-chip-slot');
        if (pinSlot && !pinSlot.querySelector('select')) {
            let btn = pinSlot.querySelector<HTMLButtonElement>('.dev-chip-pin');
            if (!btn) {
                btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'dev-chip dev-chip-pin';
                btn.title = 'GPIO pin — click to change';
                btn.addEventListener('click', () => this.editPin(pinSlot, devCfg, chips.pinKey!));
                pinSlot.replaceChildren(btn);
            }
            btn.textContent = chips.pin != null ? String(chips.pin) : '–';
        }

        const pull = row.querySelector('.dev-chip-pull');
        if (pull) {
            pull.textContent = chips.pullChar ?? '–';
            pull.classList.toggle('v', chips.pullChar === 'V');
            pull.classList.toggle('g', chips.pullChar === 'G');
        }
    }

    private renderRows() {
        for (const d of this.config.devices) {
            const v = this.views.get(d.id);
            if (v) this.updateRow(v.row, d);
        }
    }

    private renderEmpty() {
        document.getElementById('peris-empty')!.style.display =
            this.config.devices.length ? 'none' : '';
    }

    private renderAll() {
        const list = document.getElementById('peris-cards')!;
        list.innerHTML = '';
        this.views.clear();
        for (const devCfg of this.config.devices) {
            const meta = this.registry?.meta(devCfg.type);
            if (!meta) continue;
            Object.assign(devCfg, normaliseConfig(meta, devCfg)); // drop unknown keys
            this.buildDeviceRow(devCfg);
        }
        this.renderRows();
        this.renderEmpty();
        this.editorChip = this.deps.getChip();
        this.apply();
    }

    private addDevice(type: string) {
        const meta = this.registry?.meta(type);
        if (!meta) return;
        let id: string;
        do { id = `${type}-${++this.idSeq}`; } while (this.config.devices.some((d) => d.id === id));
        const cfg = { ...normaliseConfig(meta, {}), id, type } as DeviceConfig;
        // pick a free pin for the first 'pin' schema field
        const pinField = (meta.configSchema || []).find((f) => f.type === 'pin');
        if (pinField) (cfg as Record<string, unknown>)[pinField.key] = this.freePin(cfg[pinField.key] as number | undefined, meta);
        this.config.devices.push(cfg);
        this.expanded.add(id);
        this.buildDeviceRow(cfg);
        this.renderRows();
        this.renderEmpty();
        this.apply();
        this.views.get(id)?.row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ---- inline row editors ----

    private editName(slot: HTMLElement, devCfg: DeviceConfig) {
        if (slot.querySelector('input')) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'dev-name-input';
        input.value = String(devCfg.name ?? devCfg.type);
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') input.blur();
            else if (e.key === 'Escape') {
                input.value = String(devCfg.name ?? devCfg.type);
                input.blur();
            }
        });
        input.addEventListener('blur', () => {
            const v = input.value.trim();
            slot.replaceChildren(); // close the editor; updateRow rebuilds the button
            if (v && v !== devCfg.name) {
                devCfg.name = v;
                this.apply();
                this.views.get(devCfg.id)?.view?.setConfig?.(devCfg);
            }
            this.renderRows();
        });
        slot.replaceChildren(input);
        input.focus();
        input.select();
    }

    private editPin(slot: HTMLElement, devCfg: DeviceConfig, key: string) {
        if (slot.querySelector('select')) return;
        const sel = document.createElement('select');
        sel.className = 'dev-chip-select';
        // same option source as the details editor — never fork this
        fillPinOptions(sel, validPins(this.deps.getChip()),
            this.usedPins(devCfg.id, this.registry?.meta(devCfg.type)), devCfg[key]);
        sel.addEventListener('change', () => {
            devCfg[key] = Number(sel.value);
            slot.replaceChildren(); // commit closes the editor
            this.apply();
            this.views.get(devCfg.id)?.view?.setConfig?.(devCfg);
            this.renderRows();
        });
        sel.addEventListener('blur', () => {
            if (!slot.contains(sel)) return; // already committed
            slot.replaceChildren(); // cancel closes the editor
            this.renderRows();
        });
        sel.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Escape') {
                e.preventDefault();
                slot.replaceChildren();
                this.renderRows();
            }
        });
        slot.replaceChildren(sel);
        sel.focus();
    }

    // ---- drag sorting ----

    private wireDrag() {
        const cards = document.getElementById('peris-cards')!;
        cards.addEventListener('dragover', (e) => {
            if (!this.dragRow) return;
            e.preventDefault();
            const rows = Array.from(cards.querySelectorAll('.peris-row'))
                .filter((r) => r !== this.dragRow) as HTMLElement[];
            const after = rows.find((r) => {
                const b = r.getBoundingClientRect();
                return e.clientY < b.top + b.height / 2;
            });
            if (after) cards.insertBefore(this.dragRow, after);
            else cards.appendChild(this.dragRow);
        });
    }

    /** Reorder the config from the DOM order (device set unchanged → no worker rebuild). */
    private commitOrder() {
        const cards = document.getElementById('peris-cards')!;
        const ids = Array.from(cards.querySelectorAll('.peris-row'))
            .map((el) => (el as HTMLElement).dataset.id!);
        this.config.devices.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        this.persist();
    }

    // ---- import / export ----

    private exportCfg() {
        const payload: Record<string, unknown> = { ...this.config, chip: this.deps.getChip() };
        const fw = this.deps.firmwareInfo();
        if (fw) payload.firmware = fw; // informational; import ignores it
        const data = JSON.stringify(payload, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = exportFileName(
            (document.getElementById('peris-filename') as HTMLInputElement).value,
            this.deps.getChip());
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    private importCfg(file: File) {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(String(reader.result)) as PerisConfig;
                if (!Array.isArray(data.devices)) throw new Error('no devices array');
                if (data.perisVersion !== PERIS_API_VERSION) {
                    throw new Error(`unsupported perisVersion ${String(data.perisVersion)}`);
                }
                if (!this.registry) throw new Error('registry not loaded');
                let seq = this.idSeq;
                const devices = data.devices.map((d) => {
                    if (!this.registry!.has(d.type)) throw new Error(`unknown device type "${d.type}"`);
                    if (!d.id) d.id = `imp-${++seq}`;
                    return normaliseConfig(this.registry!.meta(d.type)!, d);
                });
                this.idSeq = seq;
                this.config = { perisVersion: PERIS_API_VERSION, devices };
                this.renderAll();
                this.deps.terminal.writeln(`\x1b[36m[Peris] Imported ${devices.length} device(s) from ${file.name}\x1b[0m`);
            } catch (e) {
                this.deps.terminal.writeln(`\x1b[31m[Peris] Import failed: ${(e as Error).message}\x1b[0m`);
            }
        };
        reader.readAsText(file);
    }

    // ---- toolbar wiring ----

    private wireToolbar() {
        // user-set export file name: restored from / saved to localStorage
        const nameInput = document.getElementById('peris-filename') as HTMLInputElement;
        try { nameInput.value = localStorage.getItem(EXPORT_NAME_KEY) || ''; } catch { /* storage unavailable */ }
        nameInput.addEventListener('change', () => {
            try { localStorage.setItem(EXPORT_NAME_KEY, nameInput.value); } catch { /* ignore */ }
        });

        document.getElementById('peris-add-btn')!.addEventListener('click', () => {
            const t = (document.getElementById('peris-add') as HTMLSelectElement).value;
            if (t) this.addDevice(t);
        });
        document.getElementById('peris-export-btn')!.addEventListener('click', () => this.exportCfg());
        document.getElementById('peris-import-btn')!.addEventListener('click', () =>
            (document.getElementById('peris-import-file') as HTMLInputElement).click());
        document.getElementById('peris-import-file')!.addEventListener('change', (e) => {
            const f = (e.target as HTMLInputElement).files?.[0];
            if (f) this.importCfg(f);
            (e.target as HTMLInputElement).value = '';
        });
        // Config files are also drop targets (ignore internal row sorting,
        // which carries text/plain rather than files).
        const pane = document.getElementById('pane-peris')!;
        const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
        pane.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            pane.classList.add('over');
        });
        pane.addEventListener('dragleave', () => pane.classList.remove('over'));
        pane.addEventListener('drop', (e) => {
            e.preventDefault();
            pane.classList.remove('over');
            const f = e.dataTransfer?.files?.[0];
            if (f && f.name.endsWith('.json')) this.importCfg(f);
        });
    }
}
