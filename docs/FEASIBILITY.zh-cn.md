[English](FEASIBILITY.md) | **简体中文**

# M0 可行性验证报告(esp-emu-peris)

日期:2026-10-29 · 环境:esp-emulator browser wasm v0.51.0(`_tools/esp-emu-browser/www/pkg`)
固件:ESP-IDF master(`C:\esp\master\esp-idf`,经 `C:\Users\A\Desktop\quick\idfm.bat` 环境)
复现:`node tests/m0_probe.mjs`(探针)+ `tests/firmware/peris_probe`(测试固件,`idf.py build && idf.py merge-bin` 后加载 `build/merged-binary.bin`)

## 结论总表

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| Q1a | 固件 GPIO 输出能否被 `gpio_state()` 轮询观察到 | **PASS** | 8 次翻转全部可见(采样粒度 5 万指令/批) |
| Q1b | `gpio_set_input()` 驱动引脚能否触发固件 GPIO 中断 | **PASS** | 探针驱动 6 个下降沿,固件 ISR 计数 6/6 |
| Q2a | LEDC PWM 波形是否体现在 GPIO 输出寄存器(pad 级轮询测占空比) | **FAIL** | 引脚 oe=1 但 out 恒 0;duty=50%/100% 期间估计值恒 0 |
| Q2b | LEDC duty 寄存器能否用 `read_memory()` 读到且跟踪设定值 | **PASS** | 53/53 样本跟踪;`half(4096)→DUTY_R=0x10000=4096×16`,`max(8191)→0x1fff0` |
| Q3a | RMT/WS2812 波形能否用小批量 `run_batch(40)` 在引脚级采样解码 | **FAIL** | 2472 批采样中 out4 恒 0,无任何电平变化 |
| Q3b | RMT 通道 RAM 能否用 `read_memory()` 读出并解码 WS2812 帧 | **PASS** | 93 次快照解出 46 帧,匹配固件日志颜色 0x111111/0x222222/0x333333 |

## 对外设方案的决定性影响

- **LED/物理按键/触摸按键(GPIO 语义)**:直接可行——Q1a+Q1b 全通过。
- **PWM 调光 LED**:走 **MMIO 寄存器路径**(Q2b),不走引脚采样(Q2a 已证不可行)。读
  `LEDC_CHn_DUTY_R` 即得精确占空比,无混叠、无开销。
- **WS2812**:走 **RMT 通道 RAM 路径**(Q3b),不走引脚采样(Q3a 已证不可行)。符号在
  发送后仍留存于 RAM,可事后解码。
- **位绑定(bit-bang)I2C/SPI/IR**:仍可行——Q1a 证明 CPU 主动翻转 GPIO_OUT 可见;
  CPU 在翻转时不睡眠,不存在下面的"时间快进"问题。高速采样仅在 CPU 活跃窗口有效。

## 关键技术细节

### ESP32-C3 寄存器地址(来自 IDF soc 头文件)

| 寄存器 | 地址 | 备注 |
|---|---|---|
| GPIO_OUT / GPIO_ENABLE | 0x60004004 / 0x60004020 | `gpio_state()` 即这两个字的镜像 |
| GPIO_FUNCn_OUT_SEL_CFG | 0x60004000+0x554+4n | 低 9 位 = GPIO matrix 输出信号选择 |
| IO_MUX_GPIO0..11_REG | 0x60009000+0x04+4n | bit10..12 MCU_SEL 等pad配置 |
| LEDC_CHn_(CONF0/HPOINT/DUTY/CONF1/DUTY_R) | 0x60019000+0x14n(+0/4/8/C/10) | C3 用 LSCHn 命名 |
| RMT_CHnCONF0 / 通道 RAM(RMTMEM) | 0x60016010+8n / 0x60016400+0xC0n | 每通道 48 字(192 字节) |

### 实测行为要点

1. **LEDC duty 布局**:`DUTY_CH0` 字段在 bits[18:4],寄存器值 = duty × 16(与真机一致)。
2. **GPIO matrix 路由可读**:固件把 GPIO9 配给 LEDC0 后 `FUNC9_OUT_SEL=0x2d`(=45,
   LEDC_LS_CH0_SIG),GPIO4 配给 RMT 后 `FUNC4_OUT_SEL=0x33`(=51,RMT_SIG_0)。
   **外设接线的自动发现**可据此实现:轮询所有引脚的 OUT_SEL + IO_MUX 即可知道每个
   pad 当前由哪个外设信号驱动。(M2 补充实测:C3 LEDC 完整信号区间 ch0–5 =
   45–50 已实机验证——tests/m1_smoke.mjs S8 的 rgb-led 自动绑定——占空比
   分数经 conf0.TIMER_SEL → timer DUTY_RES 解码,见 peris/devices/ledc-lib.js。)
3. **RMT RAM 留存**:发送完成后符号不清除;48 字/通道;>192 符号的帧走 ping-pong
   (TX_THR_EVENT 重填+wrap),快照中可能同时存在相邻帧的片段,帧间以 reset 符号
   (低电平 ≥30µs,即 d0≥300 且 l0=0)分界。
4. **位网格重同步**:本测试中 RAM 内位流相对 LED 字节网格缺头部 2 位(ping-pong 写入
   顺序所致),前置补 0 搜索(0..7)即可对齐;真实设备解码器需实现该重同步。
5. **时间快进**:`vTaskDelay` 期间模拟器不消耗完整 CPU 周期(一批 `run_batch(40)` 中
   `cycles()` 可跳数千),因此 **CPU 睡眠期间的外设波形在引脚级不可捕获**——这是 Q3a
   失败的根本原因,与采样率无关。
6. **性能**(Node 24,直接 wasm 调用):粗粒度(50k 指令/批)≈ **5000+ MIPS**;细粒度
   (40 指令/批 + 每批 `gpio_state()`)≈ **99 MIPS**(约 53 倍开销)。浏览器 worker 内
   大致同量级——细粒度采样只应作为 CPU 活跃窗口的临时手段,常驻采样用粗粒度+MMIO。
7. **加载固件必须是合并镜像**(bootloader@0x0 + 分区表@0x8000 + app@0x10000),
   用 `idf.py merge-bin` 生成;裸 app bin 不能启动。

## 已排除 / 仍受上游限制的能力

- 硬件 I2C/SPI 外接设备模型、真触摸外设、ADC、I2S、SPI/RGB565 屏、SD 卡、UART1:
  wasm 无对应 API,需等 esp-emulator 上游(见 docs/ROADMAP.zh-cn.md)。
- 引脚级 PWM/RMT 波形观察:结构性不可行(Q2a/Q3a),不依赖采样率。
