/*
 * Device plugin registry. Both the page (for Views) and the worker (for
 * Devices) import device modules through the manifest, so adding a
 * peripheral is: drop a module into peris/devices/ and add one line to
 * peris/devices/manifest.json. Nothing else in the tree changes.
 */
export async function loadRegistry(baseUrl) {
    const url = (p) => new URL(p, baseUrl).href;
    // Manifest module paths are relative to peris/devices/.
    const deviceUrl = (m) => (/^([a-z]+:|\/)/i.test(m) ? m : 'devices/' + m.replace(/^\.\//, ''));
    const manifest = await (await fetch(url('devices/manifest.json'))).json();
    const modules = new Map();
    const errors = [];
    for (const entry of manifest.devices) {
        const modPath = entry.module?.module || entry.module;
        try {
            const mod = await import(url(deviceUrl(modPath)));
            const type = mod.Device?.typeId;
            if (!type) throw new Error('module does not export Device with typeId');
            if (modules.has(type)) throw new Error(`duplicate typeId "${type}"`);
            modules.set(type, { mod, meta: mod.Device });
        } catch (e) {
            errors.push(`${entry.module || entry}: ${e.message}`);
        }
    }
    return {
        errors,
        types() {
            return [...modules.values()].map((m) => ({
                typeId: m.meta.typeId,
                title: m.meta.title || m.meta.typeId,
                category: m.meta.category || 'misc',
                description: m.meta.description || '',
            }));
        },
        has: (type) => modules.has(type),
        meta: (type) => modules.get(type)?.meta,
        Device: (type) => modules.get(type)?.mod.Device,
        View: (type) => modules.get(type)?.mod.View,
    };
}
