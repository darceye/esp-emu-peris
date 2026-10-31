[English](ROADMAP.md) | **简体中文**

# 路线图

## M4 · 位绑定协议设备 + IR——已于 peris 0.8.0 交付

- ✅ `bitbang-i2c-slave.js`:固件位绑定 GPIO(SCL/SDA)上的 24C02 EEPROM
  与 BME280 模型。电平驱动引擎(开漏模型);从机经 SDA 输入路径应答,
  主机释放焊盘为输入时即可读到。共享逻辑在 `peris/devices/i2c-lib.js`
  (引擎、寄存器模型、逐位精确的 Bosch 补偿)。约束已写入文档:硬件
  I2C/SPI 总线无法接入(M0);从不释放 SDA 的推挽主机无法应答;不仿真
  时钟拉伸。
- ✅ `ir-nec.js`:双路捕获固件 NEC 码——**位绑定**(细批边沿采样→突发
  包络)与 **RMT** 通道(34 字的帧完整留在发送后的通道 RAM 里;模拟器
  不实现 `APB_MEM_WADDR`(恒 0),发送中途拼接不可行——M4 探针)。解码器
  完全按比值判定:客户时钟经 `esp_rom_delay_us` 只走名义时间的 ~50%
  (实测),绝对微秒窗口会误判。共享逻辑在 `peris/devices/nec-lib.js`。
- ✅ 高速采样调度器(`src/core/scheduler.ts`):按设备租约——总线空闲期
  常设警戒批(~1000 指令),传输进行期细批(~300 指令);租约按期限或
  CPU 睡眠快进自动失效。worker 与测试共用 `runtime.batchSize()`。
- ✅ 框架:设备元数据 `sharedBus`(I2C 从机合法共享 SCL/SDA),输入驱动
  线与仲裁;设备 ctx 新增 `cyclesPerUs`。
- 测试固件 P4(~20 kHz soft-I2C 主机、BME280 强制测量(冒烟测试逐位
  交叉验证其 C 侧补偿)、双路 NEC)+ 单测 `tests/unit/protocol.test.mjs`
  + 冒烟 S10/S11。

## M3 · WS2812 幻彩灯——已于 peris 0.7.0 交付

- ✅ `ws2812.js`:轮询 RMT 通道 RAM(M0 验证 Q3b PASS),符号→位流→GRB 帧;
  reset 符号重同步 + 前置补零对齐(M3 探针进一步实证:每个 WS2812 位占一个
  RMT 字、48 字回绕、复位后跟一个全零发送终止字——细节见
  FEASIBILITY.zh-cn.md)。共享逻辑在 `peris/devices/ws2812-lib.js`。
- ✅ 灯条/灯环/矩阵三种 View;GRB/RGB 顺序、亮度限制、Gamma 可配;帧平滑
  复用 M2 PWM 灯泡的做法(`ledc-lib.js` 动画器)。
- ✅ 已知限制(已文档化并在 UI 呈现):48 字通道 RAM 只保留**帧的最后 46 位**,
  长于约 2 颗的灯带只能显示尾部(与真实 C3 硬件一致);View 把恢复不出的
  LED 画成空心。发送进行中由 `CHnSTATUS` 门控跳过解码。
- 性能:实测 JS 解码远低于任何预算(每 batch 一次 192 字节读 + 48 字比较),
  无需 wasm 辅助模块方案。要突破 46 位限制需要 M4 的细粒度 batch 调度
  (在发送*过程中*反复采样 RAM),而不是更快的解码。

## M2 · PWM 调光 LED——已于 peris 0.6.0 交付

- ✅ `pwm-led.js` + `rgb-led.js`:每个 batch 读 LEDC 各通道 `DUTY_R` 寄存器,
  精确占空比,无混叠(路线已在 M0 验证:Q2b PASS)。
- ✅ 通道→引脚映射:`GPIO_FUNCn_OUT_SEL_CFG`(LEDC ch0–5 = 45–50)实现
  自动发现接线并跟随固件重接线;也允许手动指定通道。
- ✅ 呼吸灯平滑渲染:canvas 亮度插值(每插件一个 rAF 动画器,同时驱动
  灯泡与行图标)。
- 共享逻辑在 `peris/devices/ledc-lib.js`;框架挂载点为
  `Device.onBatch()` + `ctx.mmio`(见 DEVICE-API.zh-cn.md)。

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
