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
| RMT_CHnSTATUS | 0x60016028+4n | bits[11:9] = 通道状态机(1 = 发送中)——M3 |

### 实测行为要点

1. **LEDC duty 布局**:`DUTY_CH0` 字段在 bits[18:4],寄存器值 = duty × 16(与真机一致)。
2. **GPIO matrix 路由可读**:固件把 GPIO9 配给 LEDC0 后 `FUNC9_OUT_SEL=0x2d`(=45,
   LEDC_LS_CH0_SIG),GPIO4 配给 RMT 后 `FUNC4_OUT_SEL=0x33`(=51,RMT_SIG_0)。
   **外设接线的自动发现**可据此实现:轮询所有引脚的 OUT_SEL + IO_MUX 即可知道每个
   pad 当前由哪个外设信号驱动。(M2 补充实测:C3 LEDC 完整信号区间 ch0–5 =
   45–50 已实机验证——tests/m1_smoke.mjs S8 的 rgb-led 自动绑定——占空比
   分数经 conf0.TIMER_SEL → timer DUTY_RES 解码,见 peris/devices/ledc-lib.js。
   M3 补充:RMT_SIG_OUT0/1 = 51/52 是 C3 仅有的 RMT pad 信号——ch2/3 仅接收,
   ws2812 因此只提供两个发送通道。)
3. **RMT RAM 留存**:发送完成后符号不清除;48 字/通道。(M3 补充实测细化了模型:
   copy encoder **每个 WS2812 位写一个 RMT 字**——d0/l0 = 高电平段,d1/l1 = 同一位
   的低电平段——字序落在 `k mod 48` 并回绕,因此发送结束后 RAM 里恰好是复位字、
   **一个全零的发送终止字**和**帧的最后 46 位**。帧以 reset 符号(低电平 ≥30µs,
   即 d0≥300 且 l0=0)分界;复位字落在 `24·L mod 48`(只可能是 0 或 24),任何新帧
   的前 26 次写入都会覆盖可能残留的旧复位字。推论,与真实 C3 硬件一致:长于约
   2 颗的灯带只能恢复尾部——⌊46/24⌋ 个 LED 槽,最老的那个还缺头部 2 位。)
4. **位网格重同步**:RAM 窗口是帧的尾部,位流相对 LED 字节网格缺少头部位(被 RAM
   回绕覆盖);前置补 `(24 − 可见位数 mod 24) mod 24` 个零即可对齐(M0 实测 8 LED
   帧缺 2 位;M3 的逐 LED "grad" 突发 + `tests/m1_smoke.mjs` S9 在真实固件上钉死
   了该行为——ws2812-lib 的 `decodeWs2812` 即其实现)。`CHnSTATUS` bits[11:9]
   ≠ 0 表示 TX 状态机正在发送,M3 设备据此跳过半覆盖的窗口。
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

## M4 实测(位绑定协议设备 + IR)

固件 `tests/firmware/peris_probe` P4 阶段,wasm v0.51.0;脚本为一次性
探针(结论已由正式测试复验):

1. **ROM 延迟的客户时钟失真**:`esp_rom_delay_us` 推进的仿真时间只有
   名义值的 **~50%**——"9 ms" 的 NEC 引导突发实测 4.505 ms,"13 µs" 的
   载波半周期约 6.5 µs(处处精确 0.50;通过追踪边沿间周期排除了
   run_batch 尺寸因素)。后果:NEC 解码器**按比值判定**
   (`nec-lib.decodeNec`——引导突发占优、引导间隔 ½ 对 ¼、位间隔/突发
   ≈1 对 ≈3);I2C 引擎**按电平驱动**(完全不用时序);`vTaskDelay`
   睡眠保持完整仿真时长(失真在 ROM 延迟循环,不在睡眠路径)。
2. **警戒批的睡眠快进**:警戒租约常设(~1000 指令/批)时,`vTaskDelay`
   期间每批跳跃 **~68 万周期**——整个固件轮(P1–P4,仿真约 11 秒)只需
   ~2500 个警戒批,而 P4 的 CPU 活跃细窗口(300 指令/批)需要 ~16.6 万
   批。按批数定的测试窗口会跑过整轮;m1_smoke 的所有窗口均按标记符
   定界。
3. **GPIO ISR 的输入脉冲节奏**(警戒批下的按键语义):每 **8 批按压、
   保持 3 批**(睡眠快进下约 10–40 ms 仿真时间)计数 4/4;一个批间隙内
   完成 press+release 会丢边沿(已知),而 M0 的指令数形状(保持
   15 万指令 / 间隔 200 万指令)在 P1(~470 个警戒批)里放不下——只能
   计到约 1/3。ISR 需要的是仿真时间,不是指令数。
4. **`CHnSTATUS.APB_MEM_WADDR`(bits[20:12])恒读 0**——模拟器未实现
   RMT 写指针。发送中途拼接通道 RAM 不可行;发送后的 RAM 窗口是唯一的
   RMT 解码路径(NEC 装得下:34 字 ≤ 46)。
5. **同总线两个 I2C 从机需要线与输入仲裁**:`gpio_set_input` 是单赢家的
   电平写,第二个从机引擎的"释放"会静默覆盖被寻址从机的 ACK 拉低
   (每笔事务都 NACK)。runtime 现在把共享总线焊盘驱动解析为线与
   (设备元数据 `sharedBus`)。
6. **soft-I2C 回读精确**:固件 ~20 kHz(半周期 25 µs → 仿真 ~12.5 µs)
   下,写入+连续读、指针回绕、33 字节出厂校准块、强制测量全部
   `ack=0`。C↔JS 补偿一致性校验抓到 `dig_P1` 必须为 **uint16**(36477
   在 int16 里回绕成负数——T/H 一致而 P 偏离,正是据此定位的)。
