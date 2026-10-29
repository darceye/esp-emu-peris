# 跟进上游 esp-emulator / esp-emu-browser 升级

## 锁定版本

当前基线:**esp-emulator v0.51.0**(`_tools/esp-emu-browser/www/pkg`,wasm-bindgen `--target web`)。

## 升级步骤

1. 下载新版 wasm 包(如 `esp-emu-<ver>-wasm.tar.gz`)解压出新的 `www/`
   (`_tools` 下已有 `update_esp_emu_browser.bat`,目前为空,可按此逻辑补全)。
2. **先跑 M0 探针**:`node tests/m0_probe.mjs <新固件路径不动,直接对 pkg>`。
   探针直接 import 新 `pkg/esp_emu.js`,六项结论(Q1a/Q1b/Q2a/Q2b/Q3a/Q3b)若有变化,
   先更新 `docs/FEASIBILITY.md` 与 `peris/mmio/` 地址表,再动其它代码。
3. **diff 官方 worker.js**:
   `diff <new_www>/worker.js peris/worker.js`
   我们对原文件的改动全部带 `peris:` 注释,逐块把上游新逻辑移植进 `peris/worker.js`:
   - 新增/变更的消息类型 → 同步到 peris/worker.js 与 peris/app.js 的 switch
   - 运行循环(run_batch/throttle/restart)变化 → 保持 `peris.onBatchEnd()` 钩子在每批之后
4. **diff 官方 app.js / index.html**:页面功能(终端/图表/寄存器/内存面板)改动按需
   移植进 `peris/app.js` 与 `esp-emu-peris.html`(我们的文件是它们的超集复刻)。
5. 若 `WasmEmulator` API 变化(新增 GPIO/PWM/RMT 接口!),优先改用官方 API 简化设备实现——
   那正是 ROADMAP.md 里等的东西。
6. GUI 冒测(加载固件、LED/按键、配置导入导出),提交。

## 需要盯的上游能力(详见 ROADMAP.md)

- GPIO 之外的外设 API(i2c/spi 设备模型、rmt 回调、touch、adc)
- 事件回调机制(目前只能轮询)
- 浏览器包的 UART1 / 快照保存
