/*
 * Device plugin registry. Both the page (for Views) and the worker (for
 * Devices) import device modules through the manifest, so adding a
 * peripheral is: drop a module into peris/devices/ and add one line to
 * peris/devices/manifest.json. Nothing else in the tree changes.
 *
 * Compiled location: build/core/registry.js → hand-written device plugins
 * live at ../../peris/devices/ relative to this module.
 */
import type { DeviceMeta, ViewClass } from './types.js';
import { validateDeviceModule } from './types.js';

export interface RegistryType {
    typeId: string;
    title: string;
    category: string;
    description: string;
}

export interface Registry {
    errors: string[];
    types(): RegistryType[];
    has(type: string): boolean;
    meta(type: string): DeviceMeta | undefined;
    Device(type: string): DeviceMeta | undefined;
    View(type: string): ViewClass | undefined;
}

interface LoadedEntry {
    meta: DeviceMeta;
    view?: ViewClass;
}

export async function loadRegistry(baseUrl: string = import.meta.url): Promise<Registry> {
    const url = (p: string) => new URL(p, baseUrl).href;
    const DEVICES_DIR = '../../peris/devices/';
    // Manifest module paths are relative to the devices directory.
    const deviceUrl = (m: string) => (/^([a-z]+:|\/)/i.test(m) ? m : DEVICES_DIR + m.replace(/^\.\//, ''));
    const manifest = await (await fetch(url(DEVICES_DIR + 'manifest.json'))).json() as { devices: Array<{ module: string }> };

    const modules = new Map<string, LoadedEntry>();
    const errors: string[] = [];
    for (const entry of manifest.devices) {
        const modPath = entry?.module;
        try {
            const mod = await import(/* @vite-ignore */ url(deviceUrl(modPath)));
            const invalid = validateDeviceModule(mod);
            if (invalid) throw new Error(invalid);
            const meta = mod.Device as DeviceMeta;
            if (modules.has(meta.typeId)) throw new Error(`duplicate typeId "${meta.typeId}"`);
            modules.set(meta.typeId, { meta, view: mod.View as ViewClass | undefined });
        } catch (e) {
            errors.push(`${modPath}: ${(e as Error).message}`);
        }
    }
    return {
        errors,
        types: () => [...modules.values()].map((m) => ({
            typeId: m.meta.typeId,
            title: m.meta.title || m.meta.typeId,
            category: m.meta.category || 'misc',
            description: m.meta.description || '',
        })),
        has: (type: string) => modules.has(type),
        meta: (type: string) => modules.get(type)?.meta,
        Device: (type: string) => modules.get(type)?.meta,
        View: (type: string) => modules.get(type)?.view,
    };
}
