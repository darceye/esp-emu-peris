**English** | [简体中文](CHANGELOG.zh-cn.md)

# Changelog

The project version is synced in three places: `src/core/version.ts`,
`package.json`, and this file (kept in both languages — CHANGELOG.md /
CHANGELOG.zh-cn.md).
Rules: major = breaking protocol/architecture change; minor = new capability;
patch = fixes and small changes.

## peris 0.5.1

- **Bilingual documentation**: every document now has an English version under
  the default filename and a Chinese version as `*.zh-cn.md` (README, AGENT,
  docs/*); the two cross-link in their first line for one-click switching, and
  in-document links stay within the same language. AGENT.md §7 records the
  keep-both-languages-in-sync rule.

## peris 0.5.0

- **Chip auto-selected when the cached wiring loads**: the localStorage config
  now carries `chip`; on page load the Target chip select and machine info are
  synced automatically (GPIO grid, register table and pin options follow), so
  the user does not have to pick the chip again. Unknown chip names are
  safely ignored.
- **Panel head merged**: the project-name (export file name) input moved next
  to the `PERIPHERALS` title, followed by save/open icon buttons (saves one
  toolbar row); the toolbar now holds only the add select + an icon-only Add
  button.
- Implementation notes: the PerisPanel is constructed before the GPIO
  defaults are initialised so the restored chip feeds the initial grid;
  `PerisPanelDeps` gained `selectChip(chip)`.

## peris 0.4.0

- **Configurable export file name**: a file-name input in the peripherals
  toolbar; exports use it (illegal characters stripped, a single .json suffix
  appended); empty falls back to the auto name `peris-{chip}-{date}.json`.
  The input is remembered in localStorage (`peris.exportName.v1`). Naming
  lives in the pure function `exportFileName()` (unit-tested).
- **Firmware provenance in exports**: exported JSON gains an informational
  `firmware {name, size, path?}` field (the `chip` field already existed).
  Limited by the browser security model, the full disk path is usually
  unavailable: `path` is filled only when the host exposes the non-standard
  `File.path`/`filePath` property; regular browsers get name and size only.
  Import ignores the field and never auto-loads firmware.
- Toolbar split into two rows (add row + import/export row).

## peris 0.3.1

- **Fix**: the LED row-icon colour did not follow the config (disagreed with
  the details bulb). Two root causes: the panel called `setConfig` before
  `rowIcon` (the icon element did not exist yet when the colour was applied),
  and the plugin styled the two visuals separately. The led plugin now has a
  single `setColour()` applied to both bulb and row icon, and the panel
  fixed the order: **`rowIcon` first, then `setConfig`**.
- **Fix**: after loading firmware for another chip, the details editor's GPIO
  options stayed on the old chip (the row chip was always correct). Pin-option
  building was extracted into `fillPinOptions()` as the single implementation
  (shared by the details editor and the row chip);
  `PerisPanel.refreshForChip()` detects chip changes after firmware
  load/reset-reload and rebuilds the details editors.
- **AGENT.md gained iron rule §3.8**: "same-semantic code must be reused" —
  both bugs above came from copying code and changing one copy; two bug
  records added (§4).
- `npm test`/`npm run test:unit` now pass the explicit .test.mjs file list
  (the Windows/Git Bash directory-resolution pitfall recorded in AGENT.md §1;
  the directory form fails outright with MODULE_NOT_FOUND on this machine).

## peris 0.3.0

- **Three-pane layout**: the peripherals pane became its own column between
  the UART console and Debug, the same width as Debug (360px, narrowing/
  stacking on small screens); the Peripherals/Debug tab switch was removed —
  all three panes are visible at once. The peripherals pane scrolls
  internally (toolbar stays visible); the Debug pane gained a title bar.
- **Row-based peripherals list** (photoshop-layers style): each device is one
  row — on the left the interactive icon, the name (click to rename in
  place), the GPIO-number box (click for a picker) and the V/G idle-pull
  badge (click to flip; V = pull-up to VCC, G = pull-down to GND); on the
  right the expand button, remove button and drag-sort grip. The expanded
  details (blender-style property groups) show the device widget body + the
  full config editor (one property per line); advanced features that do not
  fit the row live there.
- **View API extension** (optional, backwards compatible): `View.rowIcon(el)`
  customises the row icon; the View constructor gained a third argument
  `host.updateConfig(patch)` so Views can request config changes (e.g. the
  LED row icon's colour picker); configSchema gained `chip:'pull'` /
  `pullWhenChecked` to declare the V/G badge. Type contracts in
  `build/core/types.d.ts`.
- **Drag sorting**: dragging is armed only while the grip is held (no
  accidental drags); on release the DOM order is written back to the config
  and persisted (device set unchanged → no worker rebuild). File-drop import
  and row sorting do not interfere (distinguished by dataTransfer type).
- New unit tests: rowIcon presence on built-in plugins, `rowChips()` pin/V·G
  badge derivation (including GPIO0 and a `pullWhenChecked:'low'` case).

## peris 0.2.0

- **Architecture refactor**: framework layer moved to TypeScript
  (`src/core` + `src/ui`, tsc per-file compilation to `build/`, no bundling);
  the 1000-line app.js split into 7 UI modules; peris styles extracted into
  `peris/peris.css`; chips/MMIO/protocol constants single-sourced; build
  output centralised in `build/` (gitignored).
- **Test pyramid**: unit tests (node:test, 14 cases) + integration smoke +
  M0 probe wired into npm scripts.
- **Fix**: silently dropped last state inside the throttle window (trailing
  flush).
- **Versioning**: project version (`version.ts`/`package.json`/CHANGELOG)
  and device versions (`Device.version`, shown in the row header, validated
  by the registry).
- **Docs**: ARCHITECTURE.md (layering/data flow/state ownership), EMU-API.md
  (closed-source wasm capability summary), AGENT.md (environment pitfalls and
  conventions).
- xterm vendored locally (no CDN dependency).

## peris 0.1.0

- M0 feasibility verification (GPIO polling/input interrupts ✅; pin-level
  PWM/RMT invisible; LEDC registers and RMT RAM readable) → docs/FEASIBILITY.
- M1 peripherals framework: entry page (Peripherals/Debug tabs at the time),
  own worker (upstream replica + sampling hooks), device plugin API v1
  (manifest registration), LED/button/touch button/toggle switch, config
  import/export + localStorage, serve.py/sync_www.py, IDF test firmware and
  probes.

## Device plugin versions

| typeId | version | change |
|---|---|---|
| led | 1.1.1 | fix: row-icon colour disagreed with config — one `setColour` for bulb + row icon |
| button | 1.1.0 | row press icon (press/release); activeLow declared as the V/G badge |
| touch-button | 1.1.0 | row touch icon (inherits button's badge declaration) |
| toggle-switch | 1.1.0 | mini row switch (click to toggle); activeLow declared as the V/G badge |

History: led/button/touch-button/toggle-switch 1.0.0 initial versions (see the
peris 0.1.0/0.2.0 entries).
