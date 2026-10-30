# 变更日志

版本三处同步:`src/core/version.ts`、`package.json`、本文件。
规则:主版本=协议/架构破坏性变更;次版本=新能力;修订=修复与小改。

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
- **文档**:ARCHITECTURE.md(分层/数据流/状态归属)、EMU-API.md(闭源 wasm 能力
  摘要)、AGENT.md(环境坑与约定)。
- xterm 本地化(无 CDN 依赖)。

## peris 0.1.0

- M0 可行性验证(GPIO 轮询/输入中断 ✅;引脚级 PWM/RMT 不可见;LEDC 寄存器与
  RMT RAM 可读)→ docs/FEASIBILITY.md。
- M1 外设框架:入口页(Peripherals/Debug 双标签)、自有 worker(上游复刻+
  采样钩子)、设备插件 API v1(manifest 注册)、LED/按键/触摸按键/拨动开关、
  配置导入导出 + localStorage、serve.py/sync_www.py、IDF 测试固件与探针。

## 设备插件版本

| typeId | 版本 | 变更 |
|---|---|---|
| led | 1.1.1 | 修复:行图标颜色与配置不一致——统一 setColour 应用到灯泡+行图标 |
| button | 1.1.0 | 行内按压图标(press/release);activeLow 声明为 V/G 徽章 |
| touch-button | 1.1.0 | 行内触摸图标(继承 button 的徽章声明) |
| toggle-switch | 1.1.0 | 行内迷你拨动开关(点击 toggle);activeLow 声明为 V/G 徽章 |

历史:led/button/touch-button/toggle-switch 1.0.0 初版(见 peris 0.1.0/0.2.0 条目)。
