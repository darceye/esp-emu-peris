**English** | [简体中文](EMU-PERIPHERALS.zh-cn.md)

# Emulator hardware-peripheral support report

Which peripherals the two esp-emulator 0.51.0 builds actually model —
the **wasm browser build** this project rides (`esp_emu_bg.wasm`,
4,940,328 bytes, fetched/sha256-pinned by `tools/fetch_esp_emu.py`) and
the **native Linux CLI build** (`esp-emu-0.51.0-x86_64-unknown-linux-gnu`,
ELF static-pie, 8,976,336 bytes, BuildID `90f7b79c…`). Analysis date:
2026-11-04; method and raw numbers below. Everything here was measured
on the binaries themselves (the upstream repo ships no Rust sources),
cross-checked against the 0.51.0 release README and our own M0–M6
runtime measurements in [FEASIBILITY.md](FEASIBILITY.md).

## TL;DR

- The two builds share **the same 63 periph modules**; the native build
  adds exactly two (`sdio_bridge`, `wifi_radius`) behind CLI-only
  features. Anything absent below is absent in **both**.
- **Not modelled at all (either build): I2S, ADC/DAC (SARADC), LCD_CAM
  (I8080 / RGB panel / DVP camera), SDMMC host outside P4, TWAI, touch
  peripheral, and any SD-card / flash-disk device model.**
- "Supported" has levels — a modelled peripheral is not necessarily
  usable the way firmware expects (see "Levels of support"); our device
  plugins exist precisely to bridge that gap.

## Support matrix

| Peripheral | wasm | native | Notes |
|---|---|---|---|
| CPU / ROM / flash / partitions | ✅ | ✅ | boots the real mask ROM through the IDF bootloader; `--skip-rom`, `--skip-bootloader` (native) |
| PSRAM (SPIRAM) | ✅ | ✅ | quad & octal; S3 via `--psram-size` 2M–64M |
| GPIO + GPIO matrix + IO_MUX | ✅ | ✅ | CPU-direct pad writes observable; matrix-routed signals are pad-invisible (M0 Q2a) |
| UART0 (console) | ✅ | ✅ | wasm: `run_batch` return; native: stdout + `--uart-tcp` (esptool works over `socket://`) |
| UART1 | ❌ | ✅ | native `--uart1-tcp` side channel for an external serial device |
| UART2 | 🔶 | 🔶 | same generic `uart.rs` model; undocumented, untested |
| I2C (HP) | ✅ | ✅ | built-in 24Cxx EEPROM slave at 0x50 on every chip; native adds `--i2c-dev` register-file devices |
| GP-SPI2 / SPI3 | ✅ | ✅ | register-level: polling/IRQ/DMA transfers complete; TX readable from W window + DMA RAM; **RX always 0xff** (no pad sampling — injection is a linear-memory hack, SPI-M5.md) |
| SPI0/1 (flash) | ✅ | ✅ | `spimem.rs`; memory-mapped reads work |
| GDMA | ✅ | ✅ | outlink descriptors walkable in guest RAM (the ILI9341 DMA feed rides this) |
| LEDC (PWM) | ✅ | ✅ | duty registers readable; **pads never toggle in `gpio_state()`** — peris decodes registers instead |
| MCPWM | ✅ | ✅ | module present; S3 has MCPWM0/1 |
| RMT | ✅ | ✅ | channel RAM readable post-TX (`CHnSTATUS.APB_MEM_WADDR` unimplemented); native adds `--rmt-loopback TX:RX` |
| PCNT | ✅ | ✅ | module present |
| systimer / timer groups / watchdogs | ✅ | ✅ | |
| eFuse | ✅ | ✅ | `--efuse` load; `espefuse` round-trips over the native UART bridge |
| USB-Serial/JTAG | ✅ | ✅ | console mux (`--console` on native) |
| Crypto (AES/SHA/RSA/HMAC/DS/ECDSA/ECC/XTS-AES) | ✅ | ✅ | drives flash-encryption / key-manager paths |
| Ethernet | ✅ | ✅ | OpenETH (and DW-GMAC on P4); `--net` user/tap/vmnet on native |
| WiFi station/AP (+WPA3/SAE) | ✅ | ✅ | native adds `--wifi-radius` (enterprise) |
| BLE | ✅ | ✅ | HCI to Bumble / physical adapter (`--ble-hci`, native) |
| 802.15.4 / Thread | ✅ | ✅ | UDP bridge to OT-POSIX / second instance |
| LP core + sleep (C6) | ✅ | ✅ | LP IO/I2C wake-ups not modelled |
| SDMMC host (SD cards) | — | P4 only | `esp32p4/sdmmc_host.rs`; **S3's SDMMC (0x60028000) unmodelled**; SPI-mode SD cards have no device model to answer either |
| SDIO slave | — | C6 only | `esp32c6/sdio_slave.rs` |
| ESP-Hosted SDIO bridge | ❌ | ✅ | `sdio_bridge.rs` + `--hosted`: two emulator instances (P4 host ↔ C6 slave) networked over SDIO — networking, not storage |
| **I2S** | ❌ | ❌ | **zero support** — see the evidence chain (M6 / below) |
| **ADC / DAC (SARADC)** | ❌ | ❌ | no module/flag/strings; "adc" hits are GPIO-signal names + ROM symbols |
| **LCD_CAM (I8080/RGB LCD, DVP camera)** | ❌ | ❌ | no module; `CAM_DATA*_IN_PAD` / `LCD_H_ENABLE_PAD` strings are just the S3 signal-name table |
| **TWAI (CAN)** | ❌ | ❌ | |
| **Touch peripheral** | ❌ | ❌ | the peris touch button stands in with GPIO semantics |
| SD-card / disk device models | ❌ | ❌ | no flag, no device behind any bus |

## Levels of support (what firmware actually sees)

Our M0–M6 measurements graded the *usable* surface; a "✅" above means
the register block is modelled, not that every hardware behaviour holds:

1. **Register-level, observable** — firmware drivers work (LEDC, RMT,
   GP-SPI TX, I2C, UART, timers).
2. **Register-level with holes** — GP-SPI RX returns constant 0xff and
   ignores pad input; RMT write pointers read 0; the wasm exposes **no
   memory-write API** (34 exports, `read_memory` capped at 4 KiB/call),
   so host→guest injection is the fragile linear-memory patch
   ([SPI-M5.md](SPI-M5.md)).
3. **Pad-invisible** — anything routed through the GPIO matrix (LEDC,
   RMT, SPI pads) never appears in `gpio_state()`; only CPU-direct
   writes do. Peris devices therefore decode registers or ride
   bit-banged buses.
4. **Unmodelled** — reads return 0, writes are ignored, drivers hang:
   I2S, ADC, LCD_CAM, TWAI, touch, SD storage. The 0.13.0 soft-I2S
   audio device is the workaround for the I2S row.

## wasm vs native — what differs

| | wasm browser build | native Linux build |
|---|---|---|
| periph modules | 63 | 65 (`+sdio_bridge`, `+wifi_radius`) |
| device-model flags | none (no CLI) | `--i2c-dev`, `--rmt-loopback`, `--hosted`, `--uart1-tcp` |
| host tooling | 34-export JS API (read-only memory) | esptool/espefuse via `--uart-tcp`+`--strap-mode`, `--control-tcp`, `--gdb`, `--trace`, `--save-state`, `--inject/--inject-on`, `--net` |
| CLI-only features | — | WiFi RADIUS, BLE HCI adapters, ESP-Hosted, strap modes |
| execution control | `run_batch` polling | continuous; `--batch-size`, `--timeout`, `--exit-on` |

## Evidence chain (I2S and friends)

- **wasm — decisive**: `i2s` occurs **0 times** (case-insensitive) in the
  binary; the 63-module inventory has no i2s.rs; and the ESP32-C3 I2S
  block (0x6002D000..+0x1FF) scores **0 hits in every encoding** —
  signed/unsigned LEB128 immediates, LE-u32 data, ASCII hex — while every
  modelled peripheral's base scores 4–26. Runtime: the block reads all
  zero after boot. Full method: [FEASIBILITY.md](FEASIBILITY.md) M6a.
- **native — same verdict, different weight of evidence**: `i2s`/
  `pdm`/`pcm`/`audio` all 0; no module; no CLI flag (verified by running
  `--help` under WSL). Address constants are **not decisive here**: this
  is a multi-chip static binary whose memory-map tables include
  unimplemented regions — the certainly-unmodelled SARADC base scores 7
  LE-u32 hits — so only strings/modules/flags discriminate.
- Upstream cross-check: releases ≤ 0.51.0 mention I2S once (0.48.0, a
  native-build task-hang fix for the bring-up chip S31); the release
  README's peripheral list matches the tables above.

### Reproducing

```bash
# strings + module inventory (either build)
python - <<'EOF'
import re
d = open('<binary>','rb').read()
print(d.lower().count(b'i2s'))
print(*sorted(set(re.findall(rb'src/periph/[a-z_0-9/]+\.rs', d))), sep='\n')
EOF
# wasm LEB128 block scan: see FEASIBILITY.md M6a (0 hits across 512 addrs × 4 encodings)
# native: wsl <esp-emu> --help   (full flag surface)
```

## Implications for esp-emu-peris

- Register-level devices (LEDC/RMT/GP-SPI/GDMA/I2C) are the productive
  surface — everything shipped so far rides it.
- I2S audio works only as the **soft bit-bang bus**
  (`bitbang-i2s-audio`, 0.13.0); hardware esp_i2s firmware hangs in both
  builds.
- SD cards, cameras and ADC sensors remain blocked on upstream; the
  native build's `--i2c-dev` can stand in for I2C sensors there, but
  nothing answers an SPI/SDIO probe today.
