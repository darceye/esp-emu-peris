**English** | [简体中文](EMU-API.zh-cn.md)

# esp-emulator browser API summary (wasm v0.51.0)

A reverse-engineered inventory of everything the **closed-source**
`esp_emu_bg.wasm` exposes to JS. Sources: the official `www/pkg/esp_emu.js`
(wasm-bindgen glue), official docs (esp-emulator README/BROWSER.md), and this
project's M0 measurements (`tests/m0_probe.mjs`, conclusions in
[FEASIBILITY.md](FEASIBILITY.md)). Re-run the probe and re-check this document
after an upstream upgrade.

## 1. Loading & initialisation

```js
import init, { WasmEmulator, initSync } from './pkg/esp_emu.js';
await init();                     // fetch+instantiate esp_emu_bg.wasm (relative to esp_emu.js)
// or in Node: initSync(fs.readFileSync('esp_emu_bg.wasm'))   // synchronous init
const emu = new WasmEmulator('esp32c3');   // 'esp32c3'|'esp32c5'|'esp32c6'|'esp32h2'|'esp32p4'|'esp32s3'|'esp32s31'
```

## 2. Method inventory (all synchronous; **no callbacks — polling only**)

### Lifecycle / loading
| method | notes |
|---|---|
| `load_firmware(Uint8Array)` | **must be a merged flash image** (bootloader@0x0 + partition table@0x8000 + app@0x10000, from `idf.py merge-bin`); a bare app bin never boots |
| `load_rom_elf(Uint8Array)` / `load_default_rom()` / `has_default_rom()` | ROM; embedded version used by default |
| `load_efuse(Uint8Array)` / `load_app_elf(Uint8Array)` | eFuse / app ELF (for BLE symbol interception) |
| `set_boot_from_rom(bool)` | call before `load_firmware` |
| `restart()` / `needs_restart()` | soft reset (flash preserved) / firmware called esp_restart |

### Execution (host-driven loop)
| method | notes |
|---|---|
| `run_batch(n) → string` | executes ≤n instructions, returns the batch's **UART0 output string** (the only output channel) |
| `throttle_delay_ms(now) → number` | drift from wall clock; the host sleeps by this to pace to real time |
| `cycles()` / `cycles_per_us()` | cycle counter / clock (C3 = 160) |

### CPU state
| method | notes |
|---|---|
| `pc()` / `hart_pc(h)` / `num_harts()` / `is_xtensa()` | PC, per-hart PC, hart count, ISA |
| `registers() → Uint32Array` / `get_reg(i)` | RV32: x0..x31; Xtensa: a0..a15 + PS,SAR,WINDOWBASE,WINDOWSTART,EXCCAUSE,EXCVADDR,EPC1,LBEG,LEND,LCOUNT |
| `read_memory(addr, len) → Uint8Array` | **bus read; MMIO is readable** (LEDC/RMT/GPIO matrix etc.), unmapped returns 0, 4 KiB per call |

### GPIO (this project's main interface)
| method | notes |
|---|---|
| `gpio_set_input(pin, high)` | drives a pad input level; firmware reads it and **GPIO interrupts fire** (M0: 6/6); default level high |
| `gpio_state() → [out_lo, out_hi, enable_lo, enable_hi]` | mirror of the GPIO0-63 output and output-enable registers; **only CPU-direct GPIO writes appear here** — signals through the GPIO matrix (LEDC/RMT etc.) do not (M0 measurement) |

### UART / network
| method | notes |
|---|---|
| `uart_input(Uint8Array)` | inject bytes into UART0 RX |
| `set_wifi_config(ssid, pwd)` / `set_wifi_auth(ssid, pwd, auth, sae_pwe)` | simulated soft AP |
| `wifi_rx_push(Uint8Array)` / `wifi_tx_drain() → Uint8Array` | ethernet frames ↔ WiFi; TX is u32-length-prefixed concatenation, needs an external WebSocket TAP proxy (`tools/ws-net-proxy.py`) |

## 3. Register-level facts measured in M0 (ESP32-C3)

| fact | value / notes |
|---|---|
| LEDC duty registers | `0x60019000 + 0x14*n + {0,4,8,C,10}` (CONF0/HPOINT/DUTY/CONF1/DUTY_R); **reg = duty×16** (bits[18:4]); precisely readable via `read_memory` (M0 Q2b 53/53) |
| RMT channel RAM | `0x60016400 + 0xC0*n`, 48 words/channel; symbols **remain after transmission** and can be decoded afterwards (M0 Q3b); word format `d0:15,l0:1,d1:15,l1:1` |
| GPIO matrix routing | `GPIO_FUNCn_OUT_SEL = 0x60004000+0x554+4n`; LEDC0 signal = 0x2d, RMT ch0 = 0x33 → **wiring can be auto-discovered** |
| IO_MUX (C3) | GPIO0..11 contiguous at `0x60009000+0x04+4n` |
| Time fast-forward | during `vTaskDelay` `cycles()` jumps ahead without spending full CPU cycles → **pin waveforms inside CPU sleep windows cannot be captured** (independent of sample rate) |
| Misc | GPIO_COUNT: C3=22 / C5=29 / C6=31 / H2=28 / P4=55 / S3=49 (no 22-25) / S31=32 |

## 4. Official worker message protocol (www/worker.js; this project replicates and extends it)

- page→worker: `init{wasmUrl}`, `load{chip,firmware,ssid,password,rom?,efuse?}`,
  `start`, `stop`, `step`, `reset{chip}`, `uart_input{data}`,
  `gpio_input{pin,high}`, `read_mem{addr,len}`, `mem_watch{addr,len|null}`,
  `net_connect{url}`, `net_disconnect`, `set_batch_size{size}`
- worker→page: `ready`, `loaded{chip,pc,isXtensa,numHarts,cyclesPerUs}`,
  `uart_output{data}`, `status{pc,cycles,mips,now}`,
  `snapshot{regs,pcs,gpio,cycles,mem?}` (150ms throttle), `mem{addr,bytes}`,
  `step{output,pc,cycles}`, `restarted`, `reset{reloaded,pc?}`,
  `net_status{connected}`, `error{message}`

## 5. Beyond the wasm surface (browser build lacks these; CLI-only)

`--uart1-tcp` (external serial device), `--i2c-dev` (dumb-register I2C slave),
`--rmt-loopback`, `--control-tcp` (flash write/erase), `--ble-hci`,
`--thread-sim`, GDB stub, snapshot saving.
These are exactly the capabilities the M5 roadmap waits on
(see [ROADMAP.md](ROADMAP.md)).
