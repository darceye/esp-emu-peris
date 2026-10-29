/*
 * Generic device config editor, driven by the device's configSchema.
 * Rendered inside each peripheral card; edits update the config object
 * through onChange and are then applied to the worker by the panel.
 */
import type { ConfigField, DeviceConfig, DeviceMeta } from '../core/types.js';

export interface EditorDeps {
    /** GPIO pins valid on the current chip. */
    validPins: number[];
    /** Pins already claimed by other devices (for "(in use)" hints). */
    usedPins(exceptId: string): Set<number>;
    onChange(): void;
}

export function buildConfigEditor(devCfg: DeviceConfig, meta: DeviceMeta, deps: EditorDeps): HTMLElement {
    const editor = document.createElement('div');
    editor.className = 'dev-editor';
    const used = deps.usedPins(devCfg.id);
    for (const field of meta.configSchema || []) {
        const row = document.createElement('label');
        row.className = 'dev-field';
        const lab = document.createElement('span');
        lab.textContent = field.label;
        row.appendChild(lab);
        let input: HTMLSelectElement | HTMLInputElement;
        if (field.type === 'pin') {
            const sel = document.createElement('select');
            for (const p of deps.validPins) {
                const opt = document.createElement('option');
                opt.value = String(p);
                opt.textContent = `GPIO ${p}` + (used.has(p) ? ' (in use)' : '');
                sel.appendChild(opt);
            }
            sel.value = String(devCfg[field.key]);
            if (sel.selectedIndex < 0 && sel.options.length) sel.value = sel.options[0].value;
            input = sel;
        } else if (field.type === 'checkbox') {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!devCfg[field.key];
            input = cb;
        } else if (field.type === 'color') {
            const ci = document.createElement('input');
            ci.type = 'color';
            ci.value = String(devCfg[field.key] ?? '#ff4d4d');
            input = ci;
        } else if (field.type === 'select') {
            const sel = document.createElement('select');
            for (const o of field.options || []) {
                const opt = document.createElement('option');
                opt.value = String(o.value);
                opt.textContent = o.label;
                sel.appendChild(opt);
            }
            sel.value = String(devCfg[field.key]);
            input = sel;
        } else { // text / number
            const ti = document.createElement('input');
            ti.type = field.type === 'number' ? 'number' : 'text';
            ti.value = String(devCfg[field.key] ?? '');
            if (field.min != null) ti.min = String(field.min);
            if (field.max != null) ti.max = String(field.max);
            if (field.step != null) ti.step = String(field.step);
            input = ti;
        }
        input.addEventListener('change', () => {
            let v: unknown;
            if (field.type === 'checkbox') v = (input as HTMLInputElement).checked;
            else if (field.type === 'number' || field.type === 'pin') v = Number(input.value);
            else v = input.value;
            devCfg[field.key] = v;
            deps.onChange();
        });
        row.appendChild(input);
        editor.appendChild(row);
    }
    return editor;
}
