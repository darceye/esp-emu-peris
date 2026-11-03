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

- ~~硬件 SPI~~ **M5 已修订**:GP-SPI **被上游完整模拟**,寄存器级可观察、
  可注入——见下文 M5 章节。
- 硬件 I2C 控制器:上游已模拟(每片内置 0x50 地址的 24Cxx EEPROM 从机,
  CLI 另有 `--i2c-dev` 寄存器文件设备——上游 README;wasm 字符串含
  `src/periph/i2c.rs`)。此处未实测;预期与 SPI 同一套寄存器级结论。
- 真触摸外设、ADC、I2S、SD 卡设备模型、UART1:wasm 无对应 API,需等
  esp-emulator 上游(见 docs/ROADMAP.zh-cn.md)。
- 引脚级 PWM/RMT/SPI 波形观察:结构性不可行(Q2a/Q3a、M5d),不依赖采样率。

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

## M5 实测(硬件 SPI——"不可行"的 M5 复查)

日期:2026-11-02 · wasm v0.51.0 · 固件 P5 阶段(硬件 SPI2 主机,
FSPICLK=11/MOSI=12/MISO=13/CS=14;轮询、中断、DMA 三种传输)。
探针:`tests/m5_probe.mjs`(总线级观察)、`tests/m5_mem_probe.mjs`
(线性内存访问 + RX 注入)、`tests/m5_wasm_static.mjs`(导出/字符串
清单)。**旧 M5 结论("硬件 SPI 无法接入——外设未被模拟")被推翻。**
设备作者的实操指南:[SPI-M5.zh-cn.md](SPI-M5.zh-cn.md)。

1. **GP-SPI2 被完整模拟**(上游 README 将 GP-SPI 列入已模拟外设,实测
   属实):IDF 主机驱动正常初始化,**轮询/中断/DMA 传输全部完成
   (e=0)**,trans_done 中断正常送达,探针经 `read_memory()` 读到的每个
   寄存器都与固件自身寄存器转储完全一致(USER=0x18000041、MISC=0x3e、
   ADDR=0、W 窗口……)。
2. **C3 SPI2 寄存器表(可直接当 MMIO 表用)**:基址 0x60024000——CMD
   +0x00、ADDR +0x04、CTRL +0x8、CLOCK +0xC、USER +0x10、USER1 +0x14、
   USER2 +0x18、MS_DLEN +0x1C、MISC +0x20、DMA_CONF +0x30、W0..W15
   +0x98..+0xD4(64 字节缓冲)。接线与 LEDC/RMT 一样可自动发现:
   `FUNC11_OUT_SEL=63`(FSPICLK)、`FUNC12=65`(FSPID)、`FUNC13=64`
   (FSPIQ_OUT 已路由但 oe 关)、CS 引脚为普通 GPIO 标记值,输入侧
   `GPIO_FUNC64_IN_SEL_CFG`(FSPIQ_IN)读到 `in_sel=13`。**C3 勘误:
   `GPIO_FUNCn_OUT_SEL` 是 8 位字段,普通 GPIO 值为 0x80(默认)——
   不是 S3 类芯片的 9 位/0x100;LEDC 信号号 45–50 与 SPI 信号号
   63–73 都低于 0x80,现有扫描不受影响。**
3. **TX(固件发出的数据)可读,有两条路径**:
   - **DMA 传输**(显示屏/SD 的常态):载荷就在驱动缓冲区的普通客户
     RAM 里;"dma done" 后 256 字节图案经 `read_memory()` **256/256**
     完整读出(粗粒度批次,无任何时序技巧)。W 寄存器被绕过(保留
     no-DMA 旧数据)。嗅探器经 UART 标记/描述符链走缓冲区地址即可。
   - **no-DMA 传输**(≤64 字节):hal 先装载 W0..W15、再触发 CMD,模型
     在完成时把 W 填成 RX 结果——所以 TX 只在驱动拷贝到传输结束之间
     存在于 W 里。300 指令/批永远截不到 `CMD.USR=1`(完成在客户自身
     读状态寄存器时就地结算——轮询与中断路径皆然),但 **10 指令
     微批次跨装载→触发窗口,9/9 全部截获 TX 载荷**(每字 4 字节,
     tx[i] 落在 bits [8i+7:8i];如 tx {A0,FF,00,5A} → w0=0x5a00ffa0)。
     这就是 M4 调度器的下限尺寸——警戒租约 20–10 可用;窗口过不了
     300。
4. **MISO 是合成值且不看引脚**:主机永远收到 0xff——整个传输期间用
   `gpio_set_input` 把 MISO 拉低,回读仍是 0xff(与 GPIO 外设不同,
   SPI 模型不采样焊盘输入)。wasm 也没有写内存导出。**因此焊盘级
   从机模型不可能**——与 M0 Q2a/Q3a 同类结论。
5. **经 wasm 线性内存的 RX 注入可行**(逃生通道):wasm 的 `memory`
   导出是公开的,且**外设寄存器文件就存在线性内存里**——通过扫描
   特征 USER 值定位 GPSPI2 模型结构体(唯一命中;基址 0x97d2e8,
   寄存器布局镜像:W0 在 +0x98),并验证宿主可写(DataView 写入 →
   `read_memory()` 返回写入值)。实例捕获方法:在 `initSync()` 前后
   猴子补丁 `WebAssembly.Instance`(胶水层把 `wasm` 藏在模块内)。
   完成→消费之间隔着客户指令,所以用**单指令批次**在该间隙写 W
   字段即可抵达驱动的读取:固件打出了
   `###P5 irq rx e=0 b=d1 c0 ff ee`(宿主字节 d1 c0 ff ee;可复现,
   不写入的对照组打印 ff ff ff ff)。消费前后结构体 diff 为
   **零个字**——读取路径直接返回字段值,注入就是与模型那一次写
   0xff 的纯竞速,策略是看到 TX 载荷后每个边界都重写。注意:偏移
   随 wasm 构建变化(锁定版本、运行时按值扫描重新发现——探针就是
   这么做的,无硬编码地址),且这是逐传输的指令窗口工作,不是
   白送的 API。
6. **时序**:轮询与中断传输在标记符之外几乎不消耗客户周期(60 ms
   睡眠窗口测得 9.604M 周期 ≈ 睡眠+开销;1 MHz 下没有强制 32 µs
   传输延迟)——模型在客户访问寄存器时结算传输,所以宿主侧永远
   看不到 `USR=1`。

### M5 设备层面的影响

- **TX-only SPI 设备是坦途**:嗅探器/协议分析仪和只写显示屏(硬件
  SPI 上的 MAX7219 类、ILI/ST7789 命令流)走 DMA-RAM 路径(粗粒度)
  + 小控制传输的 no-DMA 微批次窗口,接线由矩阵寄存器自动发现。
- **完整从机模型(SD 卡等)可行但属于黑科技**:如上 TX 嗅探 + 经
  线性内存 W 字段的 RX 注入(按版本定偏移、指令窗口竞速)。记录为
  脆弱但已证实;若上游将来暴露设备桥接则回退到正规路径。
- **硬件 I2C** 上游也已模拟(内置 0x50 EEPROM、CLI `--i2c-dev` 寄存器
  文件;浏览器版既无该旗标也无导出——但寄存器级应当与 SPI 同构,
  未实测)。
