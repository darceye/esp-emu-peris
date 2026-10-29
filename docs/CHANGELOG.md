# 变更日志

版本三处同步:`src/core/version.ts`、`package.json`、本文件。
规则:主版本=协议/架构破坏性变更;次版本=新能力;修订=修复与小改。

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
| led | 1.0.0 | 初版:输出轮询、颜色、active-low、floating 提示 |
| button | 1.0.0 | 初版:瞬时按压驱动输入(含 0.2.0 前的电平语义修复) |
| touch-button | 1.0.0 | 初版:继承 button,触摸板视图(触摸外设未模拟,GPIO 语义) |
| toggle-switch | 1.0.0 | 初版:保持型开关、初始状态、onEmuReady 重驱动 |
