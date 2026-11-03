[English](EMU-API.md) | **简体中文**

# esp-emulator 浏览器 API 摘要(wasm v0.51.0)

本文档是对 **闭源** `esp_emu_bg.wasm` 对 JS 暴露的全部能力的逆向整理,来源:官方
`www/pkg/esp_emu.js`(wasm-bindgen 胶水)、官方文档(esp-emulator README/BROWSER.md)
与本项目的 M0 实测(`tests/m0_probe.mjs`,结论详见 [FEASIBILITY.zh-cn.md](FEASIBILITY.zh-cn.md))。
上游升级后请重跑探针核对本文。

## 1. 加载与初始化

```js
import init, { WasmEmulator, initSync } from './pkg/esp_emu.js';
await init();                     // fetch+instantiate esp_emu_bg.wasm(相对 esp_emu.js)
// 或 Node 环境:initSync(fs.readFileSync('esp_emu_bg.wasm'))   // 同步初始化
const emu = new WasmEmulator('esp32c3');   // 'esp32c3'|'esp32c5'|'esp32c6'|'esp32h2'|'esp32p4'|'esp32s3'|'esp32s31'
```

## 2. 方法一览(全部同步;**无任何回调,只能轮询**)

### 生命周期 / 加载
| 方法 | 说明 |
|---|---|
| `load_firmware(Uint8Array)` | **必须是 merged flash image**(bootloader@0x0+分区表@0x8000+app@0x10000,`idf.py merge-bin` 生成);裸 app bin 无法启动 |
| `load_rom_elf(Uint8Array)` / `load_default_rom()` / `has_default_rom()` | ROM;缺省用内嵌版本 |
| `load_efuse(Uint8Array)` / `load_app_elf(Uint8Array)` | eFuse / app ELF(BLE 符号拦截用) |
| `set_boot_from_rom(bool)` | 在 `load_firmware` 前调用 |
| `restart()` / `needs_restart()` | 软复位(保留 flash)/ 固件调用了 esp_restart |

### 执行(宿主驱动循环)
| 方法 | 说明 |
|---|---|
| `run_batch(n) → string` | 执行 ≤n 条指令,返回这批的 **UART0 输出字符串**(唯一输出通道) |
| `throttle_delay_ms(now) → number` | 距墙钟的漂移,宿主按此 sleep 以配速到实时 |
| `cycles()` / `cycles_per_us()` | 周期计数 / 主频(C3=160) |

### CPU 状态
| 方法 | 说明 |
|---|---|
| `pc()` / `hart_pc(h)` / `num_harts()` / `is_xtensa()` | PC、每核 PC、核数、ISA |
| `registers() → Uint32Array` / `get_reg(i)` | RV32: x0..x31;Xtensa: a0..a15 + PS,SAR,WINDOWBASE,WINDOWSTART,EXCCAUSE,EXCVADDR,EPC1,LBEG,LEND,LCOUNT |
| `read_memory(addr, len) → Uint8Array` | **总线读,MMIO 可读**(LEDC/RMT/GPIO matrix 等),未映射返回 0,单次上限 4 KiB |

### GPIO(本项目的主要接口)
| 方法 | 说明 |
|---|---|
| `gpio_set_input(pin, high)` | 驱动 pad 输入电平;固件可读到,**可触发 GPIO 中断**(M0 实测 6/6);默认电平高 |
| `gpio_state() → [out_lo, out_hi, enable_lo, enable_hi]` | GPIO0-63 输出与输出使能寄存器镜像;**仅 CPU 直写 GPIO 出现于此**——LEDC/RMT 等经 GPIO matrix 的信号不体现(M0 实测) |

### UART / 网络
| 方法 | 说明 |
|---|---|
| `uart_input(Uint8Array)` | 字节注入 UART0 RX |
| `set_wifi_config(ssid, pwd)` / `set_wifi_auth(ssid, pwd, auth, sae_pwe)` | 模拟 soft AP |
| `wifi_rx_push(Uint8Array)` / `wifi_tx_drain() → Uint8Array` | 以太网帧 ↔ WiFi;TX 为 u32 长度前缀拼接,需外部 WebSocket TAP 代理(`tools/ws-net-proxy.py`) |

## 3. M0 实测的寄存器级事实(ESP32-C3)

| 事实 | 数值/说明 |
|---|---|
| LEDC duty 寄存器 | `0x60019000 + 0x14*n + {0,4,8,C,10}`(CONF0/HPOINT/DUTY/CONF1/DUTY_R);**reg = duty×16**(bits[18:4]);`read_memory` 精确可读(M0 Q2b 53/53) |
| RMT 通道 RAM | `0x60016400 + 0xC0*n`,48 字/通道;符号发送后**留存**可事后解码(M0 Q3b);字格式 `d0:15,l0:1,d1:15,l1:1` |
| GPIO matrix 路由 | `GPIO_FUNCn_OUT_SEL = 0x60004000+0x554+4n`;LEDC0 信号=0x2d,RMT ch0=0x33 → **可自动发现接线**。C3:OUT_SEL 字段为 **8 位、普通 GPIO=0x80**(非 S3 类的 9 位/0x100);输入侧 `GPIO_FUNCn_IN_SEL_CFG = 0x60004000+0x154+4*sig` |
| IO_MUX(C3) | GPIO0..21 连续于 `0x60009000+0x04+4n`(与 IDF io_mux_reg.h 偏移核对;如 GPIO11=+0x30、GPIO13=+0x38) |
| 时间快进 | `vTaskDelay` 期间 `cycles()` 大跳、不消耗完整 CPU 周期 → **CPU 睡眠窗口的引脚波形不可捕获**(与采样率无关) |
| 其它 | GPIO_COUNT:C3=22/C5=29/C6=31/H2=28/P4=55/S3=49(无 22-25)/S31=32 |

## 3b. M5 实测的硬件 SPI 事实(ESP32-C3,wasm v0.51.0)

GP-SPI2 **被完整模拟**——传输完成(轮询/中断/DMA)、trans_done 中断
送达、`read_memory()` 与固件自身寄存器视图一致。完整细节:
FEASIBILITY.zh-cn.md "M5 实测"。

| 事实 | 数值/说明 |
|---|---|
| SPI2 寄存器块 | 基址 0x60024000;CMD +0x00、ADDR +0x04、USER +0x10、MISC +0x20、W0..W15 +0x98..+0xD4(64 字节缓冲) |
| SPI 接线信号 | FSPICLK=63、FSPIQ=64、FSPID=65、FSPIHD=66、FSPIWP=67、FSPICS0..5=68..73——经 `FUNCn_OUT_SEL`/`FUNC(sig)_IN_SEL` 可发现 |
| TX 可观察性 | DMA 传输:载荷在客户 RAM 缓冲区,`read_memory()` 粗粒度可读。no-DMA:TX 只存在于驱动拷贝到完成之间的 W0..W15——**10 指令微批次** 9/9 截获;300 指令批次截不到(完成在客户读寄存器时就地结算,`USR=1` 宿主不可见) |
| RX 行为 | 主机永远收到 **0xff**;MISO 焊盘上的 `gpio_set_input` 被忽略(模型不采样焊盘) |
| RX 注入(黑科技) | wasm 的 `memory` 导出公开且寄存器文件**存于线性内存**:按 USER 值(0x18000041)扫描定位模型结构体,在完成→消费的指令窗口内(单指令批次)用 DataView 补丁 W 字段——已证实,客户收到了宿主写入的字节(m5_mem_probe) |
| wasm 导出面 | 恰好 34 个导出(m5_wasm_static.mjs):即 §2 的 EMU API 加 `memory`——**不存在写内存/设备桥接导出**;实例捕获=在 `initSync()` 前后猴子补丁 `WebAssembly.Instance` |

## 4. 官方 worker 消息协议(www/worker.js,本项目 worker 复刻并扩展)

- 页面→worker:`init{wasmUrl}`、`load{chip,firmware,ssid,password,rom?,efuse?}`、`start`、`stop`、`step`、`reset{chip}`、`uart_input{data}`、`gpio_input{pin,high}`、`read_mem{addr,len}`、`mem_watch{addr,len|null}`、`net_connect{url}`、`net_disconnect`、`set_batch_size{size}`
- worker→页面:`ready`、`loaded{chip,pc,isXtensa,numHarts,cyclesPerUs}`、`uart_output{data}`、`status{pc,cycles,mips,now}`、`snapshot{regs,pcs,gpio,cycles,mem?}`(150ms 节流)、`mem{addr,bytes}`、`step{output,pc,cycles}`、`restarted`、`reset{reloaded,pc?}`、`net_status{connected}`、`error{message}`

## 5. wasm 导出面之外(浏览器形态缺失,CLI 才有)

`--uart1-tcp`(外部串口设备)、`--i2c-dev`(哑寄存器 I2C 从机)、`--rmt-loopback`、
`--control-tcp`(flash 写擦)、`--ble-hci`、`--thread-sim`、GDB stub、快照保存。
M5 修订:硬件 SPI **不需要**这些——外设已被模拟,寄存器/内存访问
(§3b)覆盖 TX 嗅探乃至 RX 注入;其余真正缺失项见
[ROADMAP.zh-cn.md](ROADMAP.zh-cn.md)。
