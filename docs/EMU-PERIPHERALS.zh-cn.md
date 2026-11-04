[English](EMU-PERIPHERALS.md) | **简体中文**

# 模拟器硬件外设支持报告

esp-emulator 0.51.0 的两个构建各自实际模拟了哪些外设——本项目骑乘的
**wasm 浏览器构建**(`esp_emu_bg.wasm`,4,940,328 字节,由
`tools/fetch_esp_emu.py` 拉取并 sha256 锁定)与**原生 Linux CLI 构建**
(`esp-emu-0.51.0-x86_64-unknown-linux-gnu`,ELF 静态 PIE,
8,976,336 字节,BuildID `90f7b79c…`)。分析日期:2026-11-04;方法与
原始数据见下文。所有结论都直接测自二进制本身(上游仓库不含 Rust
源码),并与 0.51.0 release README 及我们自己的 M0–M6 运行时测量
([FEASIBILITY.zh-cn.md](FEASIBILITY.zh-cn.md))交叉核对。

## 速览

- 两个构建共享**同样的 63 个外设模块**;原生构建恰好多两个
  (`sdio_bridge`、`wifi_radius`),对应 CLI 独有功能。下表缺失的,
  在**两个构建里都缺失**。
- **两个构建都完全没有模拟:I2S、ADC/DAC(SARADC)、LCD_CAM
  (I8080/RGB 面板/DVP 摄像头)、P4 之外的 SDMMC host、TWAI、触摸
  外设,以及任何 SD 卡/闪存盘设备模型。**
- "支持"是分层的——被模拟的外设未必按固件预期的方式可用
  (见"支持层级");本项目的外设插件正是为弥合这一落差而存在。

## 支持矩阵

| 外设 | wasm | 原生 | 备注 |
|---|---|---|---|
| CPU / ROM / flash / 分区表 | ✅ | ✅ | 从真掩膜 ROM 经 IDF 引导启动;原生有 `--skip-rom`、`--skip-bootloader` |
| PSRAM(SPIRAM) | ✅ | ✅ | quad 与 octal;S3 经 `--psram-size` 2M–64M |
| GPIO + GPIO 矩阵 + IO_MUX | ✅ | ✅ | CPU 直写焊盘可观察;矩阵路由信号焊盘不可见(M0 Q2a) |
| UART0(控制台) | ✅ | ✅ | wasm:`run_batch` 返回串;原生:stdout + `--uart-tcp`(esptool 可走 `socket://`) |
| UART1 | ❌ | ✅ | 原生 `--uart1-tcp` 旁路,可接外部串口设备 |
| UART2 | 🔶 | 🔶 | 同一通用 `uart.rs` 模型;未文档化、未实测 |
| I2C(HP) | ✅ | ✅ | 每芯片内置 0x50 处的 24Cxx EEPROM 从机;原生另加 `--i2c-dev` 寄存器文件设备 |
| GP-SPI2 / SPI3 | ✅ | ✅ | 寄存器级:轮询/中断/DMA 传输均完成;TX 可从 W 窗口 + DMA RAM 读出;**RX 恒 0xff**(无焊盘采样——注入是线性内存黑科技,见 SPI-M5.zh-cn.md) |
| SPI0/1(flash) | ✅ | ✅ | `spimem.rs`;内存映射读可用 |
| GDMA | ✅ | ✅ | outlink 描述符可在客机 RAM 中遍历(ILI9341 的 DMA 供给即骑乘此) |
| LEDC(PWM) | ✅ | ✅ | 占空比寄存器可读;**焊盘永不出现在 `gpio_state()`**——peris 改读寄存器 |
| MCPWM | ✅ | ✅ | 模块在列;S3 有 MCPWM0/1 |
| RMT | ✅ | ✅ | 发送后通道 RAM 可读(`CHnSTATUS.APB_MEM_WADDR` 未实现);原生另加 `--rmt-loopback TX:RX` |
| PCNT | ✅ | ✅ | 模块在列 |
| 系统定时器 / 定时器组 / 看门狗 | ✅ | ✅ | |
| eFuse | ✅ | ✅ | `--efuse` 加载;原生 UART 桥上 espefuse 可往返 |
| USB-Serial/JTAG | ✅ | ✅ | 控制台复用(原生 `--console`) |
| 加密(AES/SHA/RSA/HMAC/DS/ECDSA/ECC/XTS-AES) | ✅ | ✅ | 支撑 flash 加密 / key-manager 路径 |
| 以太网 | ✅ | ✅ | OpenETH(P4 另有 DW-GMAC);原生 `--net` user/tap/vmnet |
| WiFi STA/AP(+WPA3/SAE) | ✅ | ✅ | 原生另加 `--wifi-radius`(企业级) |
| BLE | ✅ | ✅ | HCI 转 Bumble / 物理适配器(`--ble-hci`,原生) |
| 802.15.4 / Thread | ✅ | ✅ | UDP 桥接 OT-POSIX / 第二实例 |
| LP core + 睡眠(C6) | ✅ | ✅ | LP IO/I2C 唤醒未模拟 |
| SDMMC host(SD 卡) | — | 仅 P4 | `esp32p4/sdmmc_host.rs`;**S3 的 SDMMC(0x60028000)未模拟**;SPI 模式 SD 卡同样无设备模型应答 |
| SDIO slave | — | 仅 C6 | `esp32c6/sdio_slave.rs` |
| ESP-Hosted SDIO 桥 | ❌ | ✅ | `sdio_bridge.rs` + `--hosted`:两个模拟器实例(P4 主机 ↔ C6 从机)经 SDIO 组网——是网络,不是存储 |
| **I2S** | ❌ | ❌ | **零支持**——证据链见 M6 / 下文 |
| **ADC / DAC(SARADC)** | ❌ | ❌ | 无模块/旗标/字符串;"adc" 命中全是 GPIO 信号名 + ROM 符号 |
| **LCD_CAM(I8080/RGB LCD、DVP 摄像头)** | ❌ | ❌ | 无模块;`CAM_DATA*_IN_PAD` / `LCD_H_ENABLE_PAD` 字符串只是 S3 信号名表 |
| **TWAI(CAN)** | ❌ | ❌ | |
| **触摸外设** | ❌ | ❌ | peris 触摸按键以 GPIO 语义代替 |
| SD 卡 / 磁盘设备模型 | ❌ | ❌ | 无旗标,任何总线后面都没有设备 |

## 支持层级(固件实际看到什么)

我们的 M0–M6 测量对*可用*面做过分级;上表的"✅"指寄存器块被模拟,
不代表全部硬件行为成立:

1. **寄存器级、可观察**——固件驱动正常工作(LEDC、RMT、GP-SPI TX、
   I2C、UART、定时器)。
2. **寄存器级但有洞**——GP-SPI RX 恒返 0xff 且无视焊盘输入;RMT 写
   指针读 0;wasm **不暴露内存写 API**(34 个导出,`read_memory`
   每次上限 4 KiB),宿主→客机注入只能用脆弱的线性内存补丁
   ([SPI-M5.zh-cn.md](SPI-M5.zh-cn.md))。
3. **焊盘不可见**——一切经 GPIO 矩阵路由的信号(LEDC、RMT、SPI
   焊盘)都不出现在 `gpio_state()`;只有 CPU 直写可见。peris 设备
   因此或读寄存器、或骑乘位捆绑总线。
4. **未模拟**——读返 0、写忽略、驱动挂死:I2S、ADC、LCD_CAM、TWAI、
   触摸、SD 存储。0.13.0 的软 I2S 音频设备即 I2S 行的替代方案。

## wasm 与原生——差异何在

| | wasm 浏览器构建 | 原生 Linux 构建 |
|---|---|---|
| 外设模块 | 63 | 65(`+sdio_bridge`、`+wifi_radius`) |
| 设备模型旗标 | 无(没有 CLI) | `--i2c-dev`、`--rmt-loopback`、`--hosted`、`--uart1-tcp` |
| 宿主工具链 | 34 导出的 JS API(只读内存) | esptool/espefuse 经 `--uart-tcp`+`--strap-mode`、`--control-tcp`、`--gdb`、`--trace`、`--save-state`、`--inject/--inject-on`、`--net` |
| CLI 独有功能 | — | WiFi RADIUS、BLE HCI 适配器、ESP-Hosted、strap 模式 |
| 执行控制 | `run_batch` 轮询 | 连续运行;`--batch-size`、`--timeout`、`--exit-on` |

## 证据链(I2S 及同类)

- **wasm——决定性**:`i2s`(大小写不敏感)在二进制中 **0 次**;
  63 个模块清单无 i2s.rs;且 ESP32-C3 的 I2S 块
  (0x6002D000..+0x1FF)在**所有编码形式下 0 命中**——带/无符号
  LEB128 立即数、LE-u32 数据、ASCII 十六进制——而每个被模拟外设
  的基址命中 4–26 次。运行时:启动后该块全零读。完整方法:
  [FEASIBILITY.zh-cn.md](FEASIBILITY.zh-cn.md) M6a。
- **原生——同一结论,证据权重不同**:`i2s`/`pdm`/`pcm`/`audio`
  全 0;无模块;无 CLI 旗标(WSL 实跑 `--help` 核对)。地址常量
  在此**不具鉴别力**:这是多芯片静态二进制,内存映射表包含未实现
  区域——确证未模拟的 SARADC 基址都有 7 次 LE-u32 命中——只有
  字符串/模块/旗标可作判据。
- 上游交叉核对:≤ 0.51.0 的 release 只提过一次 I2S(0.48.0,针对
  bring-up 芯片 S31 的原生构建任务挂死修复);release README 的
  外设清单与上表一致。

### 复现方法

```bash
# 字符串 + 模块清单(任一构建)
python - <<'EOF'
import re
d = open('<binary>','rb').read()
print(d.lower().count(b'i2s'))
print(*sorted(set(re.findall(rb'src/periph/[a-z_0-9/]+\.rs', d))), sep='\n')
EOF
# wasm LEB128 块扫描:见 FEASIBILITY.zh-cn.md M6a(512 地址 × 4 编码全 0 命中)
# 原生:wsl <esp-emu> --help   (完整旗标面)
```

## 对 esp-emu-peris 的意义

- 寄存器级设备(LEDC/RMT/GP-SPI/GDMA/I2C)是高产出面——目前已
  发布的一切都骑乘它。
- I2S 音频只有**软件位捆绑总线**一条路(`bitbang-i2s-audio`,
  0.13.0);硬件 esp_i2s 固件在两个构建里都会挂死。
- SD 卡、摄像头与 ADC 传感器仍被上游阻塞;原生构建的 `--i2c-dev`
  可顶替 I2C 类传感器,但今天没有任何东西应答 SPI/SDIO 探测。
