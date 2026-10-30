[English](ROADMAP.md) | **简体中文**

# 路线图

## M3 · WS2812 幻彩灯(下一期)

- `ws2812.js`:轮询 RMT 通道 RAM(M0 验证 Q3b PASS),符号→位流→GRB 帧;
  ping-pong 分组 + reset 符号重同步 + 前置补零对齐(细节见 FEASIBILITY.zh-cn.md)。
- 灯条/灯环/矩阵三种 View;GRB/RGB 顺序、亮度限制、Gamma 可配;帧平滑
  复用 M2 PWM 灯泡的做法(`ledc-lib.js` 动画器)。
- 性能策略:JS 解码先行;若实测不够,把"采样+解码"热路径用 C/C++ 编成独立 wasm
  辅助模块在 worker 内调用(不动模拟器的闭源 wasm,不影响设备 JS 接口)。

## M2 · PWM 调光 LED——已于 peris 0.6.0 交付

- ✅ `pwm-led.js` + `rgb-led.js`:每个 batch 读 LEDC 各通道 `DUTY_R` 寄存器,
  精确占空比,无混叠(路线已在 M0 验证:Q2b PASS)。
- ✅ 通道→引脚映射:`GPIO_FUNCn_OUT_SEL_CFG`(LEDC ch0–5 = 45–50)实现
  自动发现接线并跟随固件重接线;也允许手动指定通道。
- ✅ 呼吸灯平滑渲染:canvas 亮度插值(每插件一个 rAF 动画器,同时驱动
  灯泡与行图标)。
- 共享逻辑在 `peris/devices/ledc-lib.js`;框架挂载点为
  `Device.onBatch()` + `ctx.mmio`(见 DEVICE-API.zh-cn.md)。

## M4 · 位绑定协议设备 + IR

- `bitbang-i2c-slave.js`(SCL/SDA 上模拟 24Cxx/BME280 等)、`ir-nec.js`(捕获固件 RMT/位绑定发射)。
- 前提:固件用 GPIO 位绑定(硬件 I2C/SPI 总线无法从外部接入,M0 已确认)。
  需要配套测试固件与文档说明此约束。
- 高速采样调度(sigbus 扩展:临时小批量窗口,CPU 活跃期有效)。

## M5 · 上游能力跟进(不可控)

以下能力当前 wasm 无 API,只能跟进 esp-emulator 新版本(升级流程见 UPGRADE.zh-cn.md):

| 能力 | 依赖的上游接口 | 现状 |
|---|---|---|
| 硬件 I2C 设备模型 | i2c slave/设备桥 API(仅 CLI `--i2c-dev`,且只有哑寄存器) | ❌ |
| 硬件 SPI 外设(SD 卡等) | spi 设备桥 | ❌ |
| SPI/RGB565 显示屏 | spi/lcd_cam(外设本身未模拟) | ❌ |
| 真触摸外设 | touch 外设模拟 | ❌(触摸按键以 GPIO 语义代替) |
| ADC(电位器等) | adc 模拟 | ❌ |
| I2S 音频 | i2s 模拟 | ❌ |
| UART1 外设 | wasm 暴露 uart1(CLI 有 `--uart1-tcp`) | ❌ |
| 状态快照保存/恢复 | save/load API | ❌ |

## 维护项

- `update_esp_emu_browser.bat`(在 `_tools`,当前为空):按 UPGRADE.zh-cn.md 流程脚本化。
- `src/core/mmio/`:补 C5/C6/H2/P4/S3 地址表(从各自 IDF soc 头文件提取,方法同 M0)。
