/*
 * Generic device config editor, driven by the device's configSchema.
 * Rendered in each peripheral row's expanded details; edits update the
 * config object through onChange and are then applied to the worker by
 * the panel. Also exports rowChips() and fillPinOptions() — the shared
 * helpers behind the compact GPIO / V·G chips shown inline in the row.
 */
import type { ConfigField, DeviceConfig, DeviceMeta } from '../core/types.js';

export interface EditorDeps {
    /** GPIO pins valid on the current chip. */
    validPins: number[];
    /** Pins already claimed by other devices (for "(in use)" hints). */
    usedPins(exceptId: string): Set<number>;
    onChange(): void;
}

/**
 * Fill a <select> with the chip's valid GPIO options. This is the single
 * source for every pin dropdown (details editor + row chip) — a second
 * copy once drifted and served stale options, so reuse it, do not fork it.
 */
export function fillPinOptions(sel: HTMLSelectElement, valid: number[], used: Set<number>, current: unknown): void {
    sel.innerHTML = '';
    for (const p of valid) {
        const opt = document.createElement('option');
        opt.value = String(p);
        opt.textContent = `GPIO ${p}` + (used.has(p) ? ' (in use)' : '');
        sel.appendChild(opt);
    }
    sel.value = String(current);
    if (sel.selectedIndex < 0 && sel.options.length) sel.value = sel.options[0].value;
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
            fillPinOptions(sel, deps.validPins, used, devCfg[field.key]);
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

/** Compact row summary derived from the schema (pure, unit-tested). */
export interface RowChips {
    /** Schema key of the GPIO pin field, if the device has one. */
    pinKey: string | null;
    /** Current pin number (null if absent/invalid). */
    pin: number | null;
    /** Schema key of the checkbox shown as the V/G pull badge, if any. */
    pullKey: string | null;
    /** 'V' = idle pulled up to VCC, 'G' = idle pulled down to GND. */
    pullChar: 'V' | 'G' | null;
}

/**
 * Which config values a device row shows inline: the first `pin` field and
 * the checkbox marked `chip:'pull'` (V when checked pulls high, unless the
 * schema says `pullWhenChecked:'low'`).
 */
export function rowChips(meta: DeviceMeta, cfg: DeviceConfig): RowChips {
    const fields: ConfigField[] = meta.configSchema || [];
    const pinField = fields.find((f) => f.type === 'pin') || null;
    const pullField = fields.find((f) => f.chip === 'pull' && f.type === 'checkbox') || null;
    const pinKey = pinField?.key ?? null;
    let pin: number | null = null;
    if (pinKey != null) {
        const n = Number(cfg[pinKey]);
        if (Number.isFinite(n)) pin = n;
    }
    let pullChar: 'V' | 'G' | null = null;
    if (pullField) {
        const highWhenChecked = pullField.pullWhenChecked !== 'low';
        const checked = !!cfg[pullField.key];
        pullChar = checked === highWhenChecked ? 'V' : 'G';
    }
    return { pinKey, pin, pullKey: pullField?.key ?? null, pullChar };
}
