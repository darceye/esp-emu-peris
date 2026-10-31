[English](CHANGELOG.md) | **简体中文**

# 变更日志

版本三处同步:`src/core/version.ts`、`package.json`、本文件(双语维护——CHANGELOG.zh-cn.md
与英文版 CHANGELOG.md)。
规则:主版本=协议/架构破坏性变更;次版本=新能力;修订=修复与小改。

## peris 0.8.1

- **测试固件 P1b**(数字输入采样):每轮循环新增 2 秒采样阶段,用
  `gpio_get_level()` 读取拨动开关电平(GPIO0)、按键电平(GPIO3)与触摸
  板(GPIO18,低有效)——每 125 ms 打印一行 `###P1b`,闪烁 LED 实时镜像
  开关状态,触摸按压沿计数。拨动开关与触摸板设备(普通 GPIO 驱动;触摸
  外设本身未仿真)由此也被探针固件覆盖。
- **`examples/esp32c3-probe.json` 覆盖全部设备**:可导入的接线配置从 4
  个设备扩到 11 个,引脚与固件一一对应(LED、按键、开关、触摸板、PWM
  LED、RGB LED、WS2812 灯带、共享 I2C 总线上的 24C02 + BME280、红外
  NEC 的 GPIO 与 RMT 两路捕获)。加载
  `tests/firmware/peris_probe/build/merged-binary.bin` 后导入该示例,
  每个固件阶段都会驱动到对应外设。
- 冒烟测试:新增 S4b 三项检查(开关电平到达客户机、触摸按压被计数、
  LED 镜像开关),以 `###P1b` 标记为界;冒烟配置携带 11 个设备。

## peris 0.8.0(M4)

- **细粒度采样调度器**(`src/core/scheduler.ts`):run_batch 尺寸改为按
  设备租约分配。**警戒租约**(arm)在设备监视空闲总线期间保持约 1000
  条指令的常设批(开销可接受,又足以分辨 ~20 kHz 总线上的 START);
  **细粒度租约**(fine,约 300 条指令)在传输进行期间生效,让 CPU 驱动
  的每个边沿都能在采样间隙中存活——租约按周期预算到期,或当模拟器
  快进穿越 CPU 睡眠窗口时自动放弃(那时无可采样,M0)。worker 运行循环
  与冒烟测试统一走 `runtime.batchSize()`,不存在第二条执行路径。
  `DeviceCtx` 新增成员:`armSampling` / `fineSampling` /
  `releaseSampling` 与 `cyclesPerUs`。
- **Bit-bang I2C 从机**(`bitbang-i2c-slave.js` v1.0.0,逻辑在
  `i2c-lib.js`):在固件位拆 GPIO 上仿真 **24C02 EEPROM**(256 字节、
  按字节写入、指针回绕、跨模拟器重载保持非易失、UI 可预写/擦除)或
  **BME280**(芯片 ID、出厂校准块、控制寄存器、强制测量(伪信号随
  计数推进)、JS 侧逐位精确镜像 Bosch 整数补偿)。协议引擎按电平驱动
  (开漏模型:拉低 = out0∧oe;从机经 SDA *输入* 路径应答,主机释放
  焊盘为输入时即可读到——标准 soft-I2C 惯用法)。不仿真时钟拉伸;
  从不释放 SDA 的推挽主机无法应答(已写入文档)。
- **IR NEC 接收器**(`ir-nec.js` v1.0.0,逻辑在 `nec-lib.js`):双路捕获
  固件 NEC 码——GPIO 上**位拆 38 kHz 载波**(细批窗口内边沿→突发包络)
  与**无载波 RMT 符号**(34 字的帧能完整留在发送结束后的 48 字通道
  RAM 里,故像 M3 ws2812 一样直接从 MMIO 解码;模拟器不实现
  `CHnSTATUS.APB_MEM_WADDR`(恒为 0),发送中途拼接 RAM 不可行——
  M4 探针)。解码器**完全按比值判定**(引导突发占优、引导间隔 1/2 对
  1/4、位间隔/突发 ≈1 对 ≈3),因为该模拟器版本的客户时钟并不按墙钟
  走。`source: auto` 在引脚路由到 RMT TX 通道时选 RMT,否则选 gpio。
- **共享总线**:`static sharedBus = true` 的设备之间允许共享引脚(两个
  I2C 从机共用一对 SCL/SDA 是合法接线)。runtime 把共享焊盘的输入驱动
  解析为**线与**(任一拉低即低)——没有它,两个从机引擎会互相覆盖
  ACK(真实 M4 缺陷:地址不匹配的从机在匹配从机的 ACK 上把 SDA 释放
  成高)。非共享设备仍按 v1 规则冲突;页面的引脚选项构建按候选设备
  感知共享。
- **测试固件 P4**:~20 kHz soft-I2C 主机(开漏惯用法)跑 EEPROM
  写/回读/指针回绕、BME280 ID/校准块/强制测量循环;NEC 码发两遍
  (GPIO5 位拆含重复帧;GPIO10 上 RMT ch1 @1 MHz)。固件打印原始 adc
  **和** C 侧 Bosch 补偿结果;冒烟测试断言与 JS 模型逐位一致——由此
  抓到两个真 bug:`dig_P1` 必须是 **uint16**(36477 在 int16 里静默回绕
  成负数);NEC 反码字节需要 `& 0xFF`。
- 测试:新增 `tests/unit/protocol.test.mjs`(26 例——调度器策略、合成
  开漏主机下的引擎状态机、寄存器模型、补偿锚点、NEC 解码(含载波包络
  与 RMT 字)、设备级 fake-MMIO 路径、sharedBus 规则);真实固件上的
  冒烟 S10/S11。所有循环改为**按标记符定界**(armed 批每批快进约
  68 万周期,按批数的窗口会跑过整轮),状态采样用强制刷新(无墙钟
  抖动)。
- 文档:FEASIBILITY 增补 M4 实测(客户时钟失真、快进速率、输入脉冲
  节奏、WADDR=0);DEVICE-API 记录采样租约与 sharedBus;ROADMAP M4 →
  已交付。

| 设备 | 版本 |
|---|---|
| led | 1.1.1 |
| button / touch-button / toggle-switch | 1.1.0 |
| pwm-led / rgb-led | 1.0.0 |
| ws2812 | 1.0.0 |
| bitbang-i2c-slave | 1.0.0 |
| ir-nec | 1.0.0 |

## peris 0.7.0(M3)

- **WS2812 灯带**(`ws2812.js` v1.0.0):挂在单个 RMT 发送通道上的可寻址
  LED 灯带。每个 batch 后从 RMT 通道 RAM 解码帧(M0 Q3b 路线;焊盘级
  波形永远到不了 GPIO 寄存器)。M3 探针实证了解码器所依赖的 RAM 布局:
  copy encoder **每个 WS2812 位占一个 RMT 字**,字序写到 48 后回绕,发送
  结束后 RAM 里只剩复位符号、全零的发送终止字和**帧的最后 46 位**——
  因此长于约 2 颗的灯带只能恢复尾部 LED(与真实 C3 硬件同样的限制;
  View 把恢复不出的 LED 画成空心占位,标题栏显示 `可见/总数`)。帧边界
  以复位符号(低电平 ≥ 30 µs)重同步,LED 字节网格靠补回丢失的头部位
  对齐(实测:8 LED 帧丢 2 位)。
- **RMT 通道自动/手动绑定**:通道由 GPIO 矩阵路由发现(C3 的
  `RMT_SIG_OUT0/1` = 51/52;ch2/3 仅接收,不进选项)并持续跟随固件重新
  接线,也可手动指定——与 M2 LEDC 设备同一套语义,复用 `ledc-lib` 的
  `parseChannel` 与重扫描节拍。
- **发送忙判定**:`CHnSTATUS` bits[11:9](RMT 状态机,1 = 发送中)在
  模拟器中可读;发送进行中设备跳过解码,半覆盖的 RAM 窗口不会被锁存
  (模拟器未实现 STATUS 时退化为"最新快照优先")。
- **灯带/环形/矩阵三种 View**,GRB/RGB 顺序、亮度上限与伽马可配置;
  帧切换在 canvas 上插值,与 M2 灯泡一致(`ledc-lib` 动画器经同一条
  绘制路径同时驱动详情画布和行内图标)。共享的解码/几何/绘制逻辑集中在
  `peris/devices/ws2812-lib.js`(不在 manifest 内,由插件与单元测试引用)。
- C3 MMIO 表:RMT 段新增 `ch(n)`(通道 RAM 与 STATUS 地址)、通道数与
  `rmtCh1` 信号号;删除未使用的 `ch0conf0`/`ch1conf0` 字段。
- 测试固件:P3 末尾追加一帧非均匀 "grad" 突发(全红,n-2 绿,n-1 蓝),
  用于逐 LED 校验尾部对齐——对齐正确的解码器应读出最后一颗纯蓝、倒数
  第二颗 G=0x3f 的绿色(其 G 字节高 2 位被 RAM 回绕丢掉)。
- 测试:基于合成通道 RAM 的单元测试(按实测写入模型构造:单 LED 完整
  解码、8 LED 46 位尾窗、grad 对齐、无复位/终止字防护、STATUS 忙门控、
  自动/手动绑定、数量裁剪、布局、上限/伽马数学);真实固件上的集成冒烟
  S9(自动绑定 ch0→GPIO4、色彩走动、grad 对齐)。固件变更后六项 M0 结论
  已全部复测。
- 文档:ROADMAP M3 → 已交付;FEASIBILITY 补充实测的 RMT RAM/STATUS 细节;
  DEVICE-API 示例列入新插件/库;README 能力表更新。

## peris 0.6.0(M2)

- **PWM 调光 LED**(`pwm-led.js` v1.0.0):由单个 LEDC 通道调光的 LED。
  每个 batch 后读 LEDC `DUTY_R` 寄存器取占空比——精确无混叠(M0 Q2b
  路线;焊盘级 PWM 波形永远到不了 GPIO 寄存器)。通道由 GPIO 矩阵路由
  (`GPIO_FUNCn_OUT_SEL_CFG`)自动发现,并持续跟随固件重新接线;也可手动
  指定;标题栏实时显示 `LEDC ch → GPIO` 接线。
- **RGB LED**(`rgb-led.js` v1.0.0):三只二极管各占一个 LEDC 通道。
  自动模式把序号最小的已路由通道依次映射到 R/G/B(匹配固件常见的
  ch0/ch1/ch2 接法);手动指定的颜色通道不参与自动分配。View 在 canvas
  上做加法混色,与真实二极管一致。
- **呼吸灯平滑渲染**:状态推送只有 ~30fps,两个新 View 均在 canvas 上
  做亮度插值——每个插件一个 rAF 动画器,经单一 `_apply` 路径同时重绘
  详情灯泡**和**行内图标(AGENT §3.8),指数时间常数缓动。
- **设备 API v1 扩展**(向后兼容):可选的 `Device.onBatch()`——每个
  `run_batch` 后的节拍(MMIO 轮询设备的挂载点,这类信号不会产生引脚
  变化事件);`ctx.mmio`(经 `mmioFor(chip)` 解析的芯片寄存器地址表,
  芯片无表时为 null)。C3 表补齐 LEDC timer 配置寄存器地址与完整的
  LEDC ch0–5 GPIO 矩阵信号号(45–50)。设备侧共享逻辑集中在
  `peris/devices/ledc-lib.js`(接线扫描、占空比解码、canvas/动画器
  辅助)——两个插件与单元测试都以相对路径引用;不在 manifest 内,
  永不作为设备加载。
- 测试固件:P2 相位在 ch0 之外同时驱动 LEDC ch1(GPIO6,反向渐变)与
  ch2(GPIO7,恒定半占空比);`###P2` 标记仍只描述 ch0,m0 探针不受影响
  (六项 M0 结论已复测)。新增 `tests/firmware/merge.ps1`——`idf.py
  merge-bin` 的 `-o` 相对 build 目录(直觉写法会落到 `build/build/`)。
- 测试:基于假 MMIO 的单元测试(DUTY_R 跨分辨率/跨 timer 解码、矩阵
  扫描、自动绑定/跟随重接线语义、渲染数学);集成冒烟 S7/S8(真实固件
  上的自动接线、占空比跟踪含 r+g 镜像和校验)。文档:ROADMAP M2 →
  已交付;DEVICE-API 补 `onBatch`/`ctx.mmio` 与共享库模式;README
  能力表。

## peris 0.5.1

- **文档双语化**:所有文档提供英文版(默认文件名)与中文版(`*.zh-cn.md`)
  (README、AGENT、docs/*);两版顶部互链一键切换,文内链接保持同语言跳转。
  AGENT.zh-cn.md §7 记录"两种语言需同步修改"的约定。

## peris 0.5.0

- **恢复缓存时自动选中芯片**:localStorage 保存的配置附带 `chip`,页面加载时
  自动同步 Target 芯片下拉与机器信息(GPIO 网格、寄存器表、引脚可选项随之
  正确),不用再手选一次。未知芯片名安全忽略。
- **面板头部合并**:项目名(导出文件名)输入框移到 `PERIPHERALS` 标题后,
  保存/打开改为图标按钮紧跟其后(节约一行版面);工具栏只留 添加下拉+图标
  Add 按钮。
- 实现要点:面板构造提前到 GPIO 默认初始化之前,恢复的芯片才能喂给初始网格;
  `PerisPanelDeps` 新增 `selectChip(chip)`。

## peris 0.4.0

- **导出文件名可设置**:外设工具栏新增文件名输入框,导出按它命名(自动去非法
  字符、补单个 .json 后缀);留空回退自动名 `peris-{chip}-{date}.json`。输入
  记忆于 localStorage(`peris.exportName.v1`)。命名逻辑为纯函数
  `exportFileName()`(单测覆盖)。
- **导出附带固件信息**:导出的 JSON 新增 `firmware {name, size, path?}` 备忘
  字段(芯片 `chip` 原已有)。受浏览器安全模型限制,磁盘全路径一般拿不到:
  `path` 仅在宿主环境暴露非标准 `File.path`/`filePath` 属性时填充,常规浏览器
  只有文件名与大小。导入时忽略该字段,不自动加载固件。
- 工具栏改为两行(添加行 + 导入导出行)。

## peris 0.3.1

- **修复**:LED 行内图标颜色不随配置(与详情灯泡不一致)。根因有二:面板先
  `setConfig` 后 `rowIcon`(图标元素尚不存在,颜色没应用到它),插件里两处各自
  设色。现 led 插件统一 `setColour()` 同时应用到灯泡与行图标,面板固定
  **先 rowIcon 后 setConfig**。
- **修复**:加载固件换芯片后,展开详情的 GPIO 选项仍停留在旧芯片(行内 chip
  一直正确)。引脚选项构建抽取为 `fillPinOptions()` 单一实现(详情编辑器与
  行内 chip 共用);`PerisPanel.refreshForChip()` 在固件加载/复位重载后检测
  芯片变化并重建详情编辑器。
- **AGENT.md 新增铁律 §3.8**:"同语义代码必须复用"——以上两个 bug 皆为复制
  代码只改一处所致;同时登记两条 bug 记录(§4)。
- `npm test`/`npm run test:unit` 改为显式传 .test.mjs 文件列表(AGENT.md §1
  记录的 Windows/Git Bash 目录解析坑,目录形式在本机直接 MODULE_NOT_FOUND)。

## peris 0.3.0

- **三栏同屏布局**:外设面板独立成栏,置于 UART 控制台与 Debug 之间,与 Debug
  同宽(360px,窄屏自适应收窄/堆叠);移除 Peripherals/Debug 标签切换,三栏同时可见。
  外设面板改为内部滚动(工具栏常驻),Debug 面板加标题条。
- **行式外设列表**(类 Photoshop 图层):每外设一行——左侧依次为交互图标、名称
  (点击原地改名)、GPIO 号方框(点击弹出选单)、V/G 闲置电平徽章(点击翻转,
  V=上拉到 VCC、G=下拉到 GND);右侧靠齐展开按钮、删除按钮、拖动排序柄。
  展开后的详情区(类 Blender 属性分组)显示设备控件主体 + 全量配置编辑器
  (一条属性一行);行内放不下的高级功能都收进详情。
- **View API 扩展**(可选项,向后兼容):`View.rowIcon(el)` 定制行内交互图标;
  View 构造函数新增第三参 `host.updateConfig(patch)`,供 View 请求改配置
  (如 LED 行内图标点击换色);configSchema 新增 `chip:'pull'` /
  `pullWhenChecked` 字段声明 V/G 徽章。类型契约见 `build/core/types.d.ts`。
- **拖动排序**:拖柄按下才允许拖拽(避免误触);松手后按 DOM 序回写配置并持久化
  (设备集合不变,不重建 worker 实例)。文件拖放导入与行排序互不干扰(按
  dataTransfer 类型区分)。
- 新增单测:内置插件 rowIcon 存在性、`rowChips()` 引脚/V·G 徽章推导
  (含 GPIO0、`pullWhenChecked:'low'` 反例)。

## peris 0.2.0

- **架构重构**:框架层 TypeScript 化(`src/core` + `src/ui`,tsc 逐文件编译到
  `build/`,不打包);千行 app.js 拆为 7 个 UI 模块;peris 样式独立 `peris/peris.css`;
  chips/MMIO/协议常量单一来源;构建产物集中 `build/`(gitignore)。
- **测试金字塔**:单元测试(node:test,14 用例)+ 集成冒烟 + M0 探针接入 npm scripts。
- **修复**:状态推送节流窗口静默丢弃最后一次变化的缺陷(尾随 flush)。
- **版本管理**:项目版本(`version.ts`/`package.json`/本文件)与设备版本
  (`Device.version`,卡片头展示,registry 校验)。
- **文档**:ARCHITECTURE(分层/数据流/状态归属)、EMU-API(闭源 wasm 能力
  摘要)、AGENT(环境坑与约定)。
- xterm 本地化(无 CDN 依赖)。

## peris 0.1.0

- M0 可行性验证(GPIO 轮询/输入中断 ✅;引脚级 PWM/RMT 不可见;LEDC 寄存器与
  RMT RAM 可读)→ docs/FEASIBILITY。
- M1 外设框架:入口页(当时为 Peripherals/Debug 双标签)、自有 worker(上游复刻+
  采样钩子)、设备插件 API v1(manifest 注册)、LED/按键/触摸按键/拨动开关、
  配置导入导出 + localStorage、serve.py/sync_www.py、IDF 测试固件与探针。

## 设备插件版本

| typeId | 版本 | 变更 |
|---|---|---|
| ws2812 | 1.0.0 | 初版(M3):RMT 通道 RAM 帧解码(复位重同步+头部补零对齐)、通道自动/手动绑定、发送忙门控、灯带/环形/矩阵 View(上限/伽马) |
| pwm-led | 1.0.0 | 初版(M2):LEDC DUTY_R 占空比、通道自动/手动绑定、canvas 亮度插值 |
| rgb-led | 1.0.0 | 初版(M2):三 LEDC 通道加法混色、最小通道号自动分配 |
| led | 1.1.1 | 修复:行图标颜色与配置不一致——统一 setColour 应用到灯泡+行图标 |
| button | 1.1.0 | 行内按压图标(press/release);activeLow 声明为 V/G 徽章 |
| touch-button | 1.1.0 | 行内触摸图标(继承 button 的徽章声明) |
| toggle-switch | 1.1.0 | 行内迷你拨动开关(点击 toggle);activeLow 声明为 V/G 徽章 |

历史:led/button/touch-button/toggle-switch 1.0.0 初版(见 peris 0.1.0/0.2.0 条目)。
