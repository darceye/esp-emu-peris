[English](UPGRADE.md) | **简体中文**

# 跟进上游 esp-emulator / esp-emu-browser 升级

## 锁定版本

当前基线:**esp-emulator v0.51.0**(`vendor/esp-emu-browser/www/pkg`,由
`tools/fetch_esp_emu.py` 从 GitHub release 下载,wasm-bindgen `--target web`)。

## 升级步骤

1. 拉取新版 wasm 包:`python tools/fetch_esp_emu.py --version <ver>`——从
   espressif/esp-emulator 的 GitHub release 下载 `esp-emu-<ver>-wasm.tar.gz`
   并把其中的 `www/` 解压到 `vendor/esp-emu-browser/www`(识别 `https_proxy`;
   事后把脚本里的 `DEFAULT_VERSION` 一并升级)。也可以用
   `ESP_EMU_WWW=/path/to/new/www` 直接指向任意解压副本。
2. **先跑 M0 探针**:`node tests/m0_probe.mjs <新固件路径不动,直接对 pkg>`。
   探针直接 import 新 `pkg/esp_emu.js`,六项结论(Q1a/Q1b/Q2a/Q2b/Q3a/Q3b)若有变化,
   先更新 `docs/FEASIBILITY.zh-cn.md` 与 `peris/mmio/` 地址表,再动其它代码。
3. **diff 官方 worker.js**:
   `diff <new_www>/worker.js peris/worker.js`
   我们对原文件的改动全部带 `peris:` 注释,逐块把上游新逻辑移植进来:
   - 新增/变更的消息类型 → 同步到 worker 与页面的消息路由 switch
   - 运行循环(run_batch/throttle/restart)变化 → 保持 `peris.onBatchEnd()` 钩子在每批之后
4. **diff 官方 app.js / index.html**:页面功能(终端/图表/寄存器/内存面板)改动按需
   移植进我们的 UI 模块与 `esp-emu-peris.html`(我们的文件是它们的超集复刻)。
5. 若 `WasmEmulator` API 变化(新增 GPIO/PWM/RMT 接口!),优先改用官方 API 简化设备实现——
   那正是路线图等的东西。
6. GUI 冒测(加载固件、LED/按键、配置导入导出),提交。

## 需要盯的上游能力(详见 ROADMAP.zh-cn.md)

- GPIO 之外的外设 API(i2c/spi 设备模型、rmt 回调、touch、adc)
- 事件回调机制(目前只能轮询)
- 浏览器包的 UART1 / 快照保存
