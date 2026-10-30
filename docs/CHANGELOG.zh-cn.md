[English](CHANGELOG.md) | **简体中文**

# 变更日志

版本三处同步:`src/core/version.ts`、`package.json`、本文件(双语维护——CHANGELOG.zh-cn.md
与英文版 CHANGELOG.md)。
规则:主版本=协议/架构破坏性变更;次版本=新能力;修订=修复与小改。

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
| pwm-led | 1.0.0 | 初版(M2):LEDC DUTY_R 占空比、通道自动/手动绑定、canvas 亮度插值 |
| rgb-led | 1.0.0 | 初版(M2):三 LEDC 通道加法混色、最小通道号自动分配 |
| led | 1.1.1 | 修复:行图标颜色与配置不一致——统一 setColour 应用到灯泡+行图标 |
| button | 1.1.0 | 行内按压图标(press/release);activeLow 声明为 V/G 徽章 |
| touch-button | 1.1.0 | 行内触摸图标(继承 button 的徽章声明) |
| toggle-switch | 1.1.0 | 行内迷你拨动开关(点击 toggle);activeLow 声明为 V/G 徽章 |

历史:led/button/touch-button/toggle-switch 1.0.0 初版(见 peris 0.1.0/0.2.0 条目)。
