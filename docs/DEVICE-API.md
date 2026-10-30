**English** | [简体中文](DEVICE-API.zh-cn.md)

# esp-emu-peris peripheral interface spec (v1)

A peripheral = one ES module under `peris/devices/` + one line in
`manifest.json`. Nothing else in the project needs to change.

> **Language**: plugins are **plain JavaScript** (drop-in, no build). The
> framework is compiled TypeScript; the full contract types live in
> `peris/core/types.d.ts` (`DeviceMeta`/`DeviceLike`/`DeviceCtx`/`PinState`
> etc.) and can be referenced from JSDoc for editor hints. The registry
> **validates metadata at load time** (a missing `typeId`/`title`/`pins()`/
> `defaultConfig` errors immediately); the unit tests in
> `tests/unit/devices.test.mjs` are the reference for electrical semantics.

## Module exports

```js
export class Device {          // runs in the worker, talks to the emulator
    static typeId      = 'led';       // unique, stable, kebab-case
    static version     = '1.0.0';     // plugin's own version (row header; logged in docs/CHANGELOG.md)
    static title       = 'LED';       // UI display name
    static category    = 'basic';     // Add-menu grouping
    static description = '...';       // one-line explanation (tooltip)
    static defaultConfig = {...};     // defaults for new instances
    static configSchema = [           // generic config editor fields (in the
                                  // expanded details, one per line)
        { key: 'pin',    label: 'GPIO pin', type: 'pin' },
        { key: 'color',  label: 'Colour',   type: 'color' },
        { key: 'name',   label: 'Label',    type: 'text' },
        // also supported: number(min/max/step), select(options:[{value,label}]), checkbox
        // a checkbox may add chip:'pull' + pullWhenChecked:'high'|'low'
        //   → the device row shows a V/G idle-pull badge (click to flip),
        //     see "Row UI conventions" below
    ];
    static pins(cfg) { return [cfg.pin]; }   // claimed GPIOs (conflict detection)

    constructor(ctx, cfg) {}          // cfg = { id, type, ...device settings }
    onPinState(pin, s) {}             // pin-output change callback s={out, oe, cycles}
    onCommand(cmd, params) {}         // user action sent from the page View
    onEmuReady() {}                   // emulator (re)loaded: re-drive input levels
    getState() { return {...}; }      // serialisable state pushed to the View (~30fps)
    destroy() {}                      // release / restore pins
}

export class View {             // runs on the page, renders the device view
    constructor(el, sendCmd, host) {}  // el = details body container;
                                       // sendCmd(cmd, params);
                                       // host.updateConfig(patch) requests a config change
    rowIcon(el) {}               // optional: compact interactive row icon (~24px), see below
    render(state) {}             // state comes from Device.getState(); drives icon and body together
    setConfig(cfg) {}            // optional: called after config edits (e.g. LED colour)
}
```

## Row UI conventions (0.3.0+)

The peripherals pane is its own column in the three-pane layout
(console | peripherals | debug); each device occupies one row:

```
[icon] [name] [GPIO#] [V/G]                    [▸ expand] [× remove] [⠿ drag]
```

- **Interactive icon** (`View.rowIcon(el)`): a clickable mini widget whose
  semantics the plugin defines — LED opens a colour picker on click (writes
  back via `host.updateConfig({color})`), buttons send press/release while
  held, the toggle switch flips on click. `render(state)` refreshes the icon
  state (lit / pressed / ON) as well. Without rowIcon a placeholder letter
  chip is shown.
  **Call order**: the panel always calls `rowIcon` before `setConfig`, so
  config-driven styling covers the icon; the icon and the details body are two
  visuals of the same state — plugins must share one setter/render
  (see led.js `setColour()`), never a separate styling path for the icon.
- **Name / GPIO box / V·G badge**: rendered generically by the panel, edited
  in place on click (name and GPIO via inline editors, the V/G badge flips
  directly). The GPIO box maps to the schema's first `type:'pin'` field; the
  V/G badge maps to the checkbox marked `chip:'pull'` — when checked it shows
  V (pull-up to VCC) for `pullWhenChecked:'high'` (the default), otherwise G;
  unchecked is the opposite.
- **Expanded details**: the device widget body (`el`, the constructor's first
  argument) + the full config editor (one property per line). Advanced
  features that do not fit in the row live here.
- **Drag sorting** ⠿: dragging is armed only while the grip is held; on
  release the devices order is written back (no worker rebuild).

## ctx (worker-side device context)

| member | description |
|---|---|
| `ctx.id` / `ctx.chip` / `ctx.gpioCount` | device id, chip model, GPIO count |
| `ctx.setPinInput(pin, high)` | drive a pin's input level (firmware reads it; raises GPIO interrupts) |
| `ctx.subscribe(pins)` / `ctx.unsubscribe()` | subscribe to pin-output changes (onPinState) |
| `ctx.readMem(addr, len)` / `ctx.readU32(addr)` | bus/MMIO reads (LEDC duty, RMT RAM, …) |
| `ctx.cycles()` | emulator cycle counter |
| `ctx.markDirty()` | request getState() to be pushed to the page soon |
| `ctx.log(text, level?)` | print a `[Peris]` line on the UART console |

## Message protocol (page ↔ worker)

Added on top of the stock worker protocol (see `peris/protocol.js`):

- page→worker: `peris_config {config}` (apply a config in full),
  `peris_command {id, cmd, params}`
- worker→page: `peris_ready {ok, errors, devices}`, `peris_state {id, state}`,
  `peris_log {level, text}`

## Config files

```json
{
  "perisVersion": 1,
  "chip": "esp32c3",
  "firmware": { "name": "merged-binary.bin", "size": 250048 },
  "devices": [ { "id": "led-1", "type": "led", "pin": 8, "color": "#ff4d4d", "name": "Red" } ]
}
```

- Autosaved to localStorage (`peris.config.v1`, including `chip`, which is
  auto-selected when the page loads); the save/open icons in the panel head
  export/import `.json`.
- **Export file name**: set in the panel-head input (it doubles as the project
  name; empty = auto name `peris-{chip}-{date}.json`), remembered in
  localStorage; naming logic in `peris-panel.ts exportFileName()`.
- **`firmware` is an informational field**: records the name/size(/disk path)
  of the most recently loaded firmware at export time (the path exists only
  when the host exposes the non-standard `File.path` — the browser security
  model provides no full path). Import ignores it and never auto-loads
  firmware; `chip` selects the matching chip when the localStorage config is
  saved/restored, but in an imported JSON it is informational only (it does
  not change the current selection).
- v1 rule: each GPIO can be claimed by at most one device (either direction);
  conflicts surface in the yellow bar at the top of the pane.

## Device development notes (from M0 measurements; see FEASIBILITY.md)

1. **Pin outputs**: firmware GPIO writes are visible in `onPinState`
   (out+oe); **signals routed through the GPIO matrix (LEDC/RMT) never appear
   in the pin registers** — you must read MMIO (LEDC duty registers, RMT
   channel RAM); address tables are in `peris/mmio/`.
2. **Pin inputs**: `ctx.setPinInput` genuinely reaches the firmware (reads +
   interrupts); button-type devices must re-drive their level in
   `onEmuReady` (levels reset when the emulator reloads).
3. **Time**: emulator time fast-forwards during `vTaskDelay`; do not attempt
   pin-level waveform capture inside CPU sleep windows. Bit-banged waveforms
   while the CPU is active can be sampled between run_batch calls, but keep
   it modest (~99 MIPS with fine batches, 5000+ MIPS with coarse ones).
4. State pushes are throttled to ~30fps; the object returned by `getState()`
   is postMessaged — keep it small and serialisable.
5. **Device actions** from the View always go through `sendCmd(cmd, params)`;
   **config changes** (e.g. picking a colour from the row icon) go through
   `host.updateConfig(patch)` — the single source of truth for config is the
   page's PerisPanel; the worker side must never cache/mutate it. Never touch
   the emulator from the page side.

## Examples

- `peris/devices/led.js` — output device (sigbus subscription)
- `peris/devices/button.js` — input device (setPinInput + onEmuReady)
- `peris/devices/touch-button.js` — inherits button's Device, different View
- `peris/devices/toggle-switch.js` — latching input device
