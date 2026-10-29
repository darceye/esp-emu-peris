/*
 * Device API v1 type contracts (see docs/DEVICE-API.md). These are the
 * interfaces every peripheral plugin implements — device modules are plain
 * JS, but editors pick up these types from the compiled .d.ts, and the
 * registry validates the shape at load time.
 */

/** Snapshot of one GPIO pad, delivered on change via ctx.subscribe(). */
export interface PinState {
    /** Output register level (meaningful only when oe is true). */
    out: boolean;
    /** Pad is driven as an output by the guest. */
    oe: boolean;
    /** Emulator cycle counter at the sample. */
    cycles: number;
}

/** Worker-side context handed to every Device constructor. */
export interface DeviceCtx {
    readonly id: string;
    readonly chip: string;
    readonly gpioCount: number;
    /** Drive a pad input level; reaches guest reads and GPIO interrupts. */
    setPinInput(pin: number, high: boolean): void;
    /** Bus/MMIO read (little-endian), e.g. LEDC duty, RMT channel RAM. */
    readMem(addr: number, len: number): Uint8Array;
    readU32(addr: number): number;
    cycles(): number;
    /** Subscribe to PinState updates for the given pins. */
    subscribe(pins: number[]): void;
    unsubscribe(): void;
    /** Ask for getState() to be flushed to the page (~30 fps). */
    markDirty(): void;
    log(text: string, level?: 'info' | 'warn' | 'error'): void;
}

/** One field of the generic config editor. */
export interface ConfigField {
    key: string;
    label: string;
    type: 'pin' | 'color' | 'text' | 'number' | 'checkbox' | 'select';
    min?: number;
    max?: number;
    step?: number;
    options?: Array<{ value: string | number; label: string }>;
}

/** A device entry in a wiring config: { id, type, ...settings }. */
export interface DeviceConfig {
    id: string;
    type: string;
    [key: string]: unknown;
}

export interface PerisConfig {
    perisVersion: number;
    chip?: string;
    devices: DeviceConfig[];
}

/** Static metadata + constructor of a device plugin's Device class. */
export interface DeviceMeta {
    readonly typeId: string;
    readonly title: string;
    readonly category?: string;
    readonly description?: string;
    readonly defaultConfig: Record<string, unknown>;
    readonly configSchema?: ConfigField[];
    /** GPIO pins the device claims (conflict detection). Required. */
    pins(cfg: DeviceConfig): number[];
    new (ctx: DeviceCtx, cfg: DeviceConfig): DeviceLike;
}

/** Instance-side contract of a device plugin. */
export interface DeviceLike {
    onPinState?(pin: number, s: PinState): void;
    onCommand?(cmd: string, params?: Record<string, unknown>): void;
    /** Re-drive inputs after the emulator (re)loaded. */
    onEmuReady?(): void;
    getState?(): Record<string, unknown>;
    destroy?(): void;
}

/** Page-side view of a device plugin. */
export interface ViewLike {
    render(state: Record<string, unknown>): void;
    setConfig?(cfg: DeviceConfig): void;
}
export interface ViewClass {
    new (el: HTMLElement, sendCmd: (cmd: string, params?: Record<string, unknown>) => void): ViewLike;
}

export interface DeviceModule {
    Device: DeviceMeta;
    View?: ViewClass;
}

/** Strip config keys that are not id/type, in the schema, or a default. */
export function normaliseConfig(meta: DeviceMeta, raw: Partial<DeviceConfig> | undefined): DeviceConfig {
    const cfg: Record<string, unknown> = { ...(meta.defaultConfig || {}), ...(raw || {}) };
    const known = new Set<string>([
        'id', 'type',
        ...Object.keys(meta.defaultConfig || {}),
        ...(meta.configSchema || []).map((f) => f.key),
    ]);
    for (const k of Object.keys(cfg)) if (!known.has(k)) delete cfg[k];
    return cfg as unknown as DeviceConfig;
}

/**
 * Validate a loaded plugin module's Device class. Returns an error string
 * or null. This is the runtime guard for plugin authors who get no
 * compile-time checking (missing static pins() was a real M1 bug).
 */
export function validateDeviceModule(mod: unknown): string | null {
    const m = mod as Partial<DeviceModule> | undefined;
    const Dev = m?.Device as (DeviceMeta & { [k: string]: unknown }) | undefined;
    if (!Dev || typeof Dev !== 'function') return 'module does not export a Device class';
    if (typeof Dev.typeId !== 'string' || !Dev.typeId) return 'Device.typeId must be a non-empty string';
    if (typeof Dev.title !== 'string' || !Dev.title) return `"${Dev.typeId}": Device.title must be a non-empty string`;
    if (typeof Dev.pins !== 'function') return `"${Dev.typeId}": Device.pins(cfg) is required (conflict detection)`;
    if (!Dev.defaultConfig || typeof Dev.defaultConfig !== 'object') return `"${Dev.typeId}": Device.defaultConfig must be an object`;
    if (Dev.configSchema !== undefined && !Array.isArray(Dev.configSchema)) return `"${Dev.typeId}": Device.configSchema must be an array`;
    return null;
}
