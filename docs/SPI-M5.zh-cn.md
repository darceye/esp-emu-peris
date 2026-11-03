[English](SPI-M5.md) | **简体中文**

# 硬件 SPI 开发指南(M5 调研成果)

未来设备作者基于 M5 发现所需的一切:esp-emulator v0.51.0 **确实模拟了**
硬件 GP-SPI,其**输出**在寄存器/内存级可观察、其**输入**可经 wasm 线性
内存注入。旧的 M5 结论("硬件 SPI 无法接入")已于 2026-11-02 被推翻;
测量记录见 [FEASIBILITY.zh-cn.md](FEASIBILITY.zh-cn.md) §"M5 实测",
寄存器/信号事实见 [EMU-API.zh-cn.md](EMU-API.zh-cn.md) §3b。本文是
*怎么做*。

验证入口:

| 工具 | 证明什么 | 运行方式 |
|---|---|---|
| `tests/m5_probe.mjs` | 总线级:寄存器可读、传输完成、MISO 行为、接线、DMA 载荷、TX 微批次窗口 | `node tests/m5_probe.mjs`(需 peris_probe 固件,约 2 轮) |
| `tests/m5_mem_probe.mjs` | 内存访问:结构体发现、可写性、RX 注入(三轮:定位/学习/注入) | `node tests/m5_mem_probe.mjs` |
| `tests/m5_wasm_static.mjs` | wasm 表面:恰好 34 个导出、periph 模块字符串 | `node tests/m5_wasm_static.mjs` |
| 固件 P5 阶段 | 硬件 SPI2 主机,轮询/中断/DMA 三种传输 | `tests/firmware/peris_probe`(标记协议见 §6) |

## 1. 什么可行、什么不可行

| 方向 | 路径 | 结论 |
|---|---|---|
| 固件 → 设备(TX / MOSI) | DMA 传输:载荷在客户 RAM | ✅ 可读,粗粒度批次,无需时序技巧 |
| 固件 → 设备(TX / MOSI) | no-DMA 传输:W0..W15 窗口 | ✅ **10 指令微批次**可读(9/9 截获);300 指令批次永远截不到 |
| 设备 → 固件(RX / MISO) | MISO 焊盘上 `gpio_set_input` | ❌ 模型恒返 0xff,从不采样焊盘 |
| 设备 → 固件(RX / MISO) | wasm 线性内存 W 字段补丁 | ✅ 已证实(客户收到宿主字节 `d1 c0 ff ee`),可复现——黑科技级,偏移随构建变 |
| 接线发现 | GPIO matrix 寄存器 | ✅ 与 LEDC/RMT 同一套方法 |
| 传输生命周期 | 完成、trans_done 中断 | ✅ 全部驱动模式可用(e=0) |
| 引脚级波形 | `gpio_state()` | ❌ 经 matrix 的信号永远不可见(M0 类);CS 可能例外,未测(§8) |

## 2. 事实清单(ESP32-C3,wasm v0.51.0)

### 2.1 SPI2 寄存器表

基址 `0x60024000`(C3;各芯片表在 `src/core/mmio/`——目前只实测了
C3)。**加粗**偏移经过实测:

| 寄存器 | 偏移 | 说明 |
|---|---|---|
| **CMD** | 0x00 | bit0=USR(触发)。**宿主侧永远读不到 1**——完成在客户自身访问寄存器时就地结算 |
| **ADDR** | 0x04 | |
| CTRL | 0x08 | |
| CLOCK | 0x0C | |
| **USER** | 0x10 | 探针运行中读到 0x18000041——这个值就是**结构体发现的锚点**(§5.2) |
| USER1 / USER2 | 0x14 / 0x18 | |
| MS_DLEN | 0x1C | |
| **MISC** | 0x20 | 读到 0x3e;USER+MISC 成对校验锚点命中 |
| DMA_CONF | 0x30 | |
| **W0..W15** | 0x98..0xD4 | 64 字节暂存窗口;字节打包:tx[i] 落在 bits [8i+7:8i](tx {A0,FF,00,5A} → w0=0x5a00ffa0) |

### 2.2 GPIO matrix 接线(自动发现)

与 LEDC/RAT 完全同套路(`peris/devices/ledc-lib.js`——复用其扫描
循环形状,禁止另写一份):

- **输出侧**——`GPIO_FUNCn_OUT_SEL_CFG = 0x60004000+0x554+4*pin`。
  C3 的 SPI 信号号:FSPICLK=63、FSPIQ=64、FSPID=65、FSPIHD=66、
  FSPIWP=67、FSPICS0..5=68..73。驱动占用 11/12/13 时实测:
  sclk→63、mosi→65、miso→64(FSPIQ_OUT 已路由,oe 关)。
  **C3 字段勘误**:OUT_SEL 字段为 **8 位**、普通 GPIO 读 **0x80**
  (默认值)——不是 S3 类芯片的 9 位/0x100。SPI 信号号 63–73 都低于
  0x80,按信号号匹配的扫描不受影响。
- **输入侧**——`GPIO_FUNC(sig)_IN_SEL_CFG = 0x60004000+0x154+4*sig`;
  FSPIQ_IN(sig 64)读到 `in_sel=13`(即 MISO 引脚),补齐发现表的
  焊盘→信号方向。
- IO_MUX:GPIO0..21 连续于 `0x60009000+0x04+4n`。

### 2.3 模型行为(实测,决定所有设计取舍)

1. **每种驱动模式下传输都完成**——轮询(`spi_device_polling_transmit`)、
   中断(`spi_device_transmit`,任务阻塞:trans_done 中断*会*送达)、
   DMA(`SPI_DMA_CH_AUTO`),全部 e=0。
2. **完成在寄存器访问时结算,而非定时器**:1 MHz 32 位传输几乎不增加
   客户周期(60 ms 睡眠窗口测得 9.604M 周期 ≈ 睡眠+开销;没有强制
   32 µs 延迟)。这就是任何批尺寸下宿主都看不到 `CMD.USR=1` 的原因
   ——轮询驱动在自己的状态读取里结算;中断路径则被睡眠→IRQ 快进
   吞掉窗口。
3. **W 窗口只在驱动拷贝到完成之间持有 TX**:hal 把 TX 存进 W0..W15、
   触发 CMD,模型在完成时用 RX 结果(全 1)覆盖 W。传输后 W 读到
   0xffffffff(那是*收到*的数据,不是残留 TX)。
4. **MISO 是合成值且不看焊盘**:整段传输期间用 `gpio_set_input` 把
   焊盘拉低,回读仍是 0xff。SPI 模型不采样焊盘输入(与 GPIO 外设
   不同)。
5. **DMA 绕过 W**:DMA 传输后 W 寄存器保留 no-DMA 旧内容;载荷在
   驱动的客户 RAM 缓冲区里。
6. **GPIO 状态焊盘**:SPI 焊盘在 `gpio_state()` 里永远无边沿(经
   matrix,同 LEDC/RMT)。CS 引脚读到普通 GPIO 标记(0x80)——细批
   下 CS 的*帧边界可见性*说得通但未测(§8)。

## 3. 读 TX——实现指南

### 3.1 DMA 传输(显示屏/SD 的常态)

载荷就是普通客户 RAM。在设备的 `onBatch()` 里用 `read_memory()` 读
——粗粒度足够(实测:标记 "dma done" 后 256/256 字节的 `i^0xA5` 图案,
零时序技巧)。

不靠固件配合找到缓冲区地址是**未决项**(§8):DMA 引擎(GDMA)从
链式描述符列表取数。M5 探针走了捷径——固件自己打印缓冲区地址
(`###P5 dma buf=0x…`)。产品级嗅探器必须走 GDMA out 描述符链(IDF
头文件:`components/soc/esp32c3/register/soc/gdma_reg.h`),或用
`SPI_DMA_CONF` 活动与缓冲区归属做关联。

### 3.2 no-DMA 传输(≤64 字节:命令、控制字)

策略:在驱动装载→触发序列期间用**微批次**盯 W 窗口。

- 实测:**10 指令批次 9/9 截获 TX 载荷**(8 次轮询 + 1 次中断)。
  300 指令批次一无所获——窗口只有几十条客户指令宽。
- 检测:每批读 W0;一旦从闲置值(0xffffffff 或旧值)变成别的,
  立即记录 W0..W15。装载→触发窗口跨多个 10 指令边界,所以模型
  抹掉之前有连续几批都能看到 TX。
- 开销:这是 M4 调度器的下限尺寸(细租约下限 20;10 已低于——
  需扩下限或加"micro"租约档)。常驻 micro 租约很贵;只在接线扫描
  看到 SPI 信号且阶段处于传输活跃时武装(调度器见
  `docs/ARCHITECTURE.zh-cn.md`;逻辑分析仪的 arm/fine 模式就是
  模板)。

### 3.3 组帧(嗅探器输出什么)

合并两条路径:no-DMA 字来自 W 窗口,DMA 连发来自 RAM 缓冲区,帧
边界来自 CS 活动(测通后,§8)或每次捕获前后的 USER1/MS_DLEN 位长
读取。协议解码器(MAX7219、ILI/ST7789 命令流)随后消费字节流——
形状与 `peris/devices/max7219-lib.js` 的移位引擎相同,只是数据源
从边沿换成寄存器。

## 4. RX 不可经焊盘驱动——唯一的死路

为完整起见:MISO 上的 `gpio_set_input` 无效(恒 0xff),wasm 也没有
写内存导出(共 34 个导出,`m5_wasm_static.mjs` 负责盯防)。任何需要
*固件收到字节*的设计必须走 §5。

## 5. 注入 RX——线性内存路径

由 `tests/m5_mem_probe.mjs` 端到端证实:固件收到了宿主写入的
`d1 c0 ff ee`。对照组(不写入)收到 `ff ff ff ff`。

### 5.1 捕获 wasm 实例

胶水层(`pkg/esp_emu.js`)把 `wasm` 藏在模块内,但实例是在
`initSync()` 里创建的——包一层构造器:

```js
const OrigInstance = WebAssembly.Instance;
let captured = null;
WebAssembly.Instance = function (module, imports) {
    captured = Reflect.construct(OrigInstance, [module, imports]);
    return captured;
};
const { initSync } = await import('./pkg/esp_emu.js');
initSync(fs.readFileSync('./pkg/esp_emu_bg.wasm'));
WebAssembly.Instance = OrigInstance;            // 立刻恢复
// captured.exports.memory —— 活体机器的线性内存
```

注意:胶水层只有*第一次* `initSync` 会实例化(后续调用返回缓存的
`wasm`),所以要在首次调用前打补丁。在 worker 架构里,这个捕获属于
`src/core/worker.ts`(唯一允许复刻上游的文件——改动必须带 `peris:`
标记,见 docs/UPGRADE.zh-cn.md),并藏在能力探测后面,因为页面侧
设备必须请 worker 代为补丁。

### 5.2 定位模型结构体(无硬编码偏移)

寄存器文件存于线性内存:DataView 写入会被 `read_memory()` 反射。每个
模拟器实例的发现流程:

1. 经 `read_memory()` 读一对有特征的活动寄存器:`USER`(如
   0x18000041)与 `MISC`(0x3e)——这些是运行中固件写进去的值;
   *运行时*取值,永不硬编码。
2. 全量扫描线性内存(13.5 MiB,一趟 `Uint32Array`)找 USER 值。
   命中数应当很少(M5 运行中为 1)。
3. 校验命中 `A`:DataView 写哨兵值,确认 `read_memory(SPI_USER)`
   返回它,还原。可选:`MISC` 应在 `A + 0x10`(结构体基址 =
   A − 0x10)。
4. 若布局镜像寄存器表(v0.51.0 如此),W0 在 `structBase + 0x98`
   ——同样以写通校验;否则在邻域逐字探测。

### 5.3 完成→消费竞速

客户机内部序列(中断驱动传输):驱动把 TX 存入 W → 置 CMD →
**模型完成,用 0xff 覆盖 W** → trans_done 中断 → ISR/任务唤醒 →
驱动把 W 读进 rx 缓冲区。宿主只能注入在模型覆盖之后、驱动读取之前:

- **批尺寸 1** 赢得竞速(2/2 次);批尺寸 10 输掉(1/1)——更大尺寸
  下覆盖与读取落进同一批。
- 每个单指令批次后用 DataView 读 W0 字段(便宜——不用
  `read_memory()`)。触发态:
  1. 字段 == 期望的 TX 字 → 驱动已装载,传输在即;
  2. 紧随 (1) 之后字段 == 0xffffffff → 已完成,尚未消费。
- 在 (2):写入想要的 RX 字。tx[i] 落在 bits [8i+7:8i],字节
  {d1,c0,ff,ee} → w0 = 0xEEFFC0D1。
- 客户读取路径**直接返回字段值**——v0.51.0 中消费前后结构体 diff
  为零个字(无需清任何 pending 标志)。若未来构建引入标志,
  `m5_mem_probe.mjs` 的学习轮 diff 会把它们暴露出来。

### 5.4 可靠性策略

已证实的运行是在 (2) 边界写一次。由于"看到 0xffffffff"与"已被
消费"有歧义,产品级的稳妥模式是:

- 看到 (1) 之后,**每个批次边界都重写 RX 字**,直到确认传输结束
  (rx 位长耗尽/出现下一次 TX 装载)。模型那一次 0xff 写入随即被
  下一个边界覆盖,驱动读不到它。
- 用回环校验:能观察固件反应的设备(后续 TX 带回该值,如 P5 的
  标记行)闭合回路;窗口丢了就重试。
- 预期开销:单指令批次只在传输窗口内(几十个边界);窗口外恢复
  粗粒度。

### 5.5 版本脆弱性

- 结构体偏移**随 wasm 构建变**。版本由 `tools/fetch_esp_emu.py`
  锁定并做 sha256 校验;发现扫描让偏移自定位,新构建无需表格——
  但**每次升级后必须重跑 M5 探针**(§7)。
- 依赖注入的设备必须优雅降级:发现失败(无通过校验的命中)就退回
  TX-only 模式并在 UI 说明——绝不让面板硬失败。
- `WebAssembly.Instance` 补丁必须在 `initSync` 之后立刻还原,避免
  其它代码捕获到被包过的构造器。

## 6. P5 固件阶段(标记协议)

`tests/firmware/peris_probe/main/main.c`,每轮 P4 之后执行。引脚:
FSPICLK=11、MOSI=12、MISO=13、CS=14。重建:
`tests/firmware/build.ps1` 然后 `tests/firmware/merge.ps1`。

| 标记 | 含义 |
|---|---|
| `###P5 start` | 阶段 A 开始:总线初始化(无 DMA) |
| `###P5 init=N` / `add=N` | 初始化错误(esp_err_t)——阶段中止 |
| `###P5 tx k=K` | 睡 60 ms,**然后**轮询 4 字节传输 {0xA0\|k, ~k, k, 0x5A};探针在睡眠内驱动 MISO 焊盘电平(偶 k 低、奇 k 高) |
| `###P5 rx k=K e=E b=XX XX XX XX` | 传输完成;rx 字节 = 模型给固件的东西 |
| `###P5 irq tx` / `###P5 irq rx e=E b=…` | 同上,但为一次中断驱动传输 {C3,3C,55,AA} |
| `###P5 w0=… w1=… w2=… w3=…` | 固件自身的 W 回读(`read_memory` 交叉校验的基准) |
| `###P5 cmd=… user=… misc=… addr=…` | 固件的控制寄存器回读 |
| `###P5 dma buf=0xADDR len=256` | 总线**带 DMA** 重初始化;睡 60 ms,然后从该静态缓冲区轮询发 256 字节 `i^0xA5` |
| `###P5 dma done e=E` | DMA 传输结束 |
| `###P5 dmainit=N` / `dmadd=N` | DMA 重初始化错误 |
| `###P5 end` | 阶段结束(总线释放) |

遵守的约定:标记用 `startsWith` 风格解析(固件会追加数据);循环
按标记定界、永不按批数;每阶段每轮重新初始化总线(无跨轮状态)。

## 7. 验证与升级流程

任何 esp-emulator wasm 升级后(流程见 [UPGRADE.zh-cn.md](UPGRADE.zh-cn.md)):

1. `node tests/m0_probe.mjs`——Q1a..Q3b 结论未变。
2. `node tests/m5_wasm_static.mjs`——仍是 34 个导出、没有出现写
   内存/设备桥接导出、periph 模块字符串未变。**若官方设备桥接
   API 出现了,优先于 §5。**
3. `node tests/m5_probe.mjs`——M5a/M5b/M5e 仍 PASS;M5c 仍是
   恒 0xff;M5g 仍 9/9(若掉落,装载→触发窗口宽度变了——重调
   微批次档)。
4. `node tests/m5_mem_probe.mjs`——注入仍 PROVEN;结构体地址多半
   会变(没关系——发现是运行时的);消费 diff 应保持为空(若不
   空,读 §5.3 的标志说明)。
5. 有任何漂移就更新 FEASIBILITY/EMU-API 及两个语言版本
   (AGENT.zh-cn.md §7 双语规则)。

同时跑 `npm test`——m1_smoke 不理会 P5,但每轮长约 1.3 秒
(S12 不受影响)。

## 8. 未决项(未实测——不要想当然)

- ~~**GDMA 描述符遍历**~~——已实测并于 0.12.0 交付:见下方附录;
  `spi-lib.readDmaPayload` / `readDmaChainAt` 实现之,ILI9341 设备在用。
- **CS 帧边界**:CS 引脚是普通 GPIO 标记,细批下其边沿大概率出现在
  `gpio_state()` 里——若为真就是免费的帧分隔符。
- **其它芯片**:只实测了 C3(SPI2 @ 0x60024000)。S3/P4/C6 等需要
  各自的 mmio 表(`src/core/mmio/`,ROADMAP 维护项)并重跑探针——
  基址和信号号不同。
- **硬件 I2C 控制器**:上游已模拟(内置 0x50 EEPROM;wasm 字符串含
  `src/periph/i2c.rs`);寄存器级访问应与 SPI 同构,未实测。方法
  相同。
- **SPI 从机模式**(固件作从机、设备作主机):未测。
- **Dual/Quad(QIO)传输**:未测;四线传数据时 W 窗口的故事可能不同。
- **轮询传输上的注入**:在中断路径上已证实;轮询驱动完成得更晚才读
  W——在实测前当作更难/未证实(§5.4 的连续重写是候选策略)。

## 9. 变更历史


## 10. 0.12.0 开发附录——GDMA 段生命周期

基于本指南开发设备时实测到的 DMA 路径真实形态(P6 追踪,wasm
v0.51.0;以下全部编码进 `spi-lib.js` 与 `ili9341.js`):

1. **DMA 总线上一切事务都绕过 W**——命令也不例外。esp_lcd 风格的
   驱动连命令字节也走 GDMA,因此 W 窗口只服务无 DMA 驱动
   (Arduino 类);DMA 总线上的设备必须经描述符链分类与捕获。
2. **hal 在事务间清除 outlink**——间隙读 outlink 得 0。但 guest RAM
   里的描述符结构还在:传输进行中缓存首描述符地址、间隙期间沿该
   地址重走链即可恢复刚结束的事务(`readDmaChainAt`)——这是 1 字节
   命令事务唯一可靠的路径(其装载→清除窗口短于一个批次)。
3. **描述符内存被复用**(同一地址反复装载、hal 同一个栈描述符):
   间隙读因此会读到上一笔或已是下一笔事务的字节(错位一拍,
   P6 实测:窗口里出现陈旧的 RASET 参数与 1 字节 `0x42` hal 哨兵)。
   设备按窗口甄别:像素流内丢弃 1 字节段、命令/参数窗口取最后一个
   1 字节段、拼装前用当前内存校验各段。
4. **大事务以 ~4 kB 块到达**,每块的装载与清除都快于任何批尺寸可
   采样——段捕获只能看到部分块。但各块描述符的 `buf` 字段以精确的
   块距步进穿过驱动的 bounce/帧缓冲,因此捕获段按缓冲地址排序、
   取最大严格连续簇即可按帧序拼装;再从所见最低地址(按页回退 +
   段内容自洽校验)做帧缓冲快照,补齐不完整的窗口。
5. **已知限制(0.12.0 接受)**:当某块的描述符装载在单个批次内完成
   时,该块字节丢失或被陈旧块顶位——RGB565 流随即带一个块的旋转
   (像素数量仍精确;值移位)。分块推送驱动(TFT_eSPI 风格、P6 固件
   的形态)远比单次突发的 esp_lcd 绘制好捕获。后续可试:低于
   MIN_BATCH 的批次,或描述符 owner/序号探测。
6. **ARM 批 60 是捕获工作点**:W 装载→触发窗口在批次 60 下存活
   (实测 10/10),批次 100 即漏(1/9)——与位绑定设备同等的常驻代价
   档;no-DMA 捕获无需细租约。

| 日期 | 变更 |
|---|---|
| 2026-11-02 | M5 调研:推翻旧结论、实测事实、新增探针与固件 P5、撰写本指南 |
| 2026-11-03 | 0.12.0 附录:实测 GDMA 段生命周期、交付设备(max7219 hwspi、ili9341)、记录限制 |
