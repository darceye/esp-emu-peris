/*
 * Peripherals panel: device cards with config editors, add/remove,
 * wiring-config import/export + localStorage autosave, tab switching and
 * the peris_* message handlers (peris_ready / peris_state / peris_log).
 */
import { loadRegistry } from '../core/registry.js';
import type { Registry } from '../core/registry.js';
import { normaliseConfig } from '../core/types.js';
import type { DeviceConfig, PerisConfig, ViewClass, ViewLike } from '../core/types.js';
import { PERIS_API_VERSION, PERIS_CONFIG, PERIS_COMMAND, PERIS_READY, PERIS_STATE, PERIS_LOG } from '../core/protocol.js';
import type { PerisEvent } from '../core/protocol.js';
import { validPins } from '../core/chips.js';
import { buildConfigEditor } from './config-editor.js';
import type { TerminalView } from './terminal.js';

const STORAGE_KEY = 'peris.config.v1';

export interface PerisPanelDeps {
    send(msg: unknown): void;
    getChip(): string;
    terminal: TerminalView;
}

export class PerisPanel {
    private registry: Registry | null = null;
    private config: PerisConfig = { perisVersion: PERIS_API_VERSION, devices: [] };
    private views = new Map<string, { card: HTMLElement; view: ViewLike | null }>();
    private idSeq = 0;

    constructor(private deps: PerisPanelDeps) {
        this.wireToolbar();
        this.wireTabs();
        this.restore();
    }

    /** Load the device registry, render toolbar + cards, apply to worker. */
    async init() {
        const reg = await loadRegistry();
        this.registry = reg;
        if (reg.errors.length) {
            this.deps.terminal.writeln(`\x1b[33m[Peris] Device registry warnings: ${reg.errors.join('; ')}\x1b[0m`);
        }
        this.renderToolbar();
        this.renderAll();
        this.deps.terminal.writeln(
            `\x1b[32m[Peris] ${reg.types().length} device type(s) ready — add peripherals in the Peripherals tab.\x1b[0m`);
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
        this.apply();
    }

    // ---- config lifecycle ----

    private apply() {
        this.deps.send({ type: PERIS_CONFIG, config: this.config });
        this.persist();
    }

    private persist() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
        } catch { /* storage unavailable */ }
    }

    private restore() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as PerisConfig | null;
            if (saved && Array.isArray(saved.devices)) {
                this.config = { perisVersion: PERIS_API_VERSION, devices: saved.devices };
            }
        } catch { /* ignore */ }
    }

    // ---- cards ----

    private usedPins(exceptId: string): Set<number> {
        const used = new Set<number>();
        for (const d of this.config.devices) {
            if (d.id === exceptId) continue;
            const meta = this.registry?.meta(d.type);
            if (meta) for (const p of meta.pins(d)) used.add(p);
        }
        return used;
    }

    private freePin(preferred: number | undefined): number | null {
        const used = this.usedPins('');
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

    private buildDeviceCard(devCfg: DeviceConfig): { card: HTMLElement; view: ViewLike | null } | null {
        const meta = this.registry?.meta(devCfg.type);
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
        const ViewClass: ViewClass | undefined = this.registry?.View(devCfg.type);
        let view: ViewLike | null = null;
        if (ViewClass) {
            view = new ViewClass(body, (cmd, params) =>
                this.deps.send({ type: PERIS_COMMAND, id: devCfg.id, cmd, params }));
            view.setConfig?.(devCfg);
        }

        // config editor
        const editor = buildConfigEditor(devCfg, meta, {
            validPins: validPins(this.deps.getChip()),
            usedPins: (id) => this.usedPins(id),
            onChange: () => {
                this.apply();
                view?.setConfig?.(devCfg);
                this.renderTitles();
            },
        });
        card.appendChild(editor);

        remove.addEventListener('click', () => {
            this.config.devices = this.config.devices.filter((d) => d.id !== devCfg.id);
            this.views.delete(devCfg.id);
            card.remove();
            this.apply();
            this.renderEmpty();
        });

        document.getElementById('peris-cards')!.appendChild(card);
        const entry = { card, view };
        this.views.set(devCfg.id, entry);
        return entry;
    }

    private renderTitles() {
        for (const d of this.config.devices) {
            const v = this.views.get(d.id);
            if (v) v.card.querySelector('.dev-title')!.textContent = String(d.name ?? d.type);
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
            this.buildDeviceCard(devCfg);
        }
        this.renderTitles();
        this.renderEmpty();
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
        if (pinField) (cfg as Record<string, unknown>)[pinField.key] = this.freePin(cfg[pinField.key] as number | undefined);
        this.config.devices.push(cfg);
        this.buildDeviceCard(cfg);
        this.renderTitles();
        this.renderEmpty();
        this.apply();
        this.views.get(id)?.card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // ---- import / export ----

    private exportCfg() {
        const data = JSON.stringify({ ...this.config, chip: this.deps.getChip() }, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `peris-${this.deps.getChip()}-${new Date().toISOString().slice(0, 10)}.json`;
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

    // ---- toolbar / tabs wiring ----

    private wireToolbar() {
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
        // Config files are also drop targets.
        const pane = document.getElementById('pane-peris')!;
        pane.addEventListener('dragover', (e) => { e.preventDefault(); pane.classList.add('over'); });
        pane.addEventListener('dragleave', () => pane.classList.remove('over'));
        pane.addEventListener('drop', (e) => {
            e.preventDefault();
            pane.classList.remove('over');
            const f = e.dataTransfer?.files?.[0];
            if (f && f.name.endsWith('.json')) this.importCfg(f);
        });
    }

    private wireTabs() {
        const tabs = document.querySelectorAll('.ptab');
        const panes: Record<string, HTMLElement> = {
            peris: document.getElementById('pane-peris')!,
            debug: document.getElementById('pane-debug')!,
        };
        for (const tab of Array.from(tabs)) {
            (tab as HTMLElement).addEventListener('click', () => {
                for (const t of Array.from(tabs)) t.classList.toggle('active', t === tab);
                const name = (tab as HTMLElement).dataset.pane!;
                for (const [key, pane] of Object.entries(panes)) {
                    pane.classList.toggle('hidden', key !== name);
                }
            });
        }
    }
}
