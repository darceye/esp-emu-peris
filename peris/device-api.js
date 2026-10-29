/*
 * esp-emu-peris device API — version 1 contract (see docs/DEVICE-API.md).
 *
 * A peripheral is one ES module in peris/devices/ exporting:
 *
 *   export class Device {
 *     static typeId    = 'led';          // unique, stable, kebab-case
 *     static title     = 'LED';          // shown in the UI
 *     static category  = 'basic';        // grouping in the Add menu
 *     static description = '...';        // one line for tooltips
 *     static defaultConfig = {...};      // fresh instance defaults
 *     static configSchema = [            // generic editor fields
 *       { key:'pin', label:'GPIO pin', type:'pin' },
 *       { key:'color', label:'Colour', type:'color' },
 *       { key:'name', label:'Label', type:'text' },
 *       { key:'x', label:'...', type:'number'|'select'|'checkbox',
 *         min?, max?, step?, options?: [{value,label}] },
 *     ];
 *     static pins(cfg) { return [cfg.pin]; }  // GPIO pins claimed (conflicts)
 *
 *     constructor(ctx, cfg) {}   // cfg = {id, type, ...device config}
 *     onPinState(pin, s) {}      // sigbus: s = {out, oe, cycles} on change
 *     onCommand(cmd, params) {}  // user interaction from the View
 *     onEmuReady() {}            // (re)drive inputs after emulator (re)load
 *     getState() { return {...}; } // serialisable state for the View
 *     destroy() {}
 *   }
 *
 *   export class View {
 *     constructor(el, sendCmd) {}  // el = card body; sendCmd(cmd, params)
 *     render(state) {}             // state from Device.getState()
 *     setConfig(cfg) {}            // optional: react to config edits
 *   }
 *
 * ctx (worker side):
 *   ctx.id, ctx.chip, ctx.gpioCount
 *   ctx.setPinInput(pin, high)     // drive a pad input (reaches interrupts)
 *   ctx.subscribe(pins), ctx.unsubscribe()
 *   ctx.readMem(addr, len), ctx.readU32(addr)  // MMIO/bus reads
 *   ctx.cycles()
 *   ctx.markDirty()                // ask for a state flush (~30 fps)
 *   ctx.log(text, level?)
 *
 * Register the module in peris/devices/manifest.json — that is the only
 * other file a new peripheral touches.
 */
export const DEVICE_API_VERSION = 1;

/** Sanitise an incoming config against a device's defaultConfig/schema. */
export function normaliseConfig(meta, raw) {
    const cfg = { ...(meta.defaultConfig || {}), ...(raw || {}) };
    const known = new Set(['id', 'type', ...(meta.configSchema || []).map((f) => f.key)]);
    for (const k of Object.keys(cfg)) if (!known.has(k)) delete cfg[k];
    return cfg;
}
