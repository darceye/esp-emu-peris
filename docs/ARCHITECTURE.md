# esp-emu-peris 系统架构

## 1. 分层总览

```
┌───────────────────────────────── 页面(page)─────────────────────────────────┐
│ esp-emu-peris.html   上游样式原块(便于升级 diff)+ <link peris/peris.css>    │
│ build/ui/*  (TypeScript 编译产物)                                           │
│   app.ts          编排器:机器状态、Run/Pause/固件/网络控件、消息路由          │
│   worker-client   Worker 唯一入口(其它模块一律经由它收发消息)               │
│   terminal / chart / debug-panels     UART 控制台 / 性能图 / Debug 只读面板  │
│   peris-panel + config-editor         Peripherals 面板与通用配置编辑器      │
└───────────────▲───────────────────────────────────────────────▲────────────┘
        postMessage(协议见 core/protocol.ts)                     │ DOM
┌───────────────┴───────────────────────────────────────────────▼────────────┐
│ 页面侧设备 View(peris/devices/*.js 的 View 类,由 peris-panel 实例化)      │
├─────────────────────────────────────────────────────────────────────────────┤
│                            ← peris_state / peris_command →                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ build/core/worker.ts  上游 worker 复刻 + 6 处 peris: 钩子(唯一可碰上游逻辑) │
│ build/core/runtime.ts 设备宿主:配置校验/实例化/命令/状态节流推送             │
│ build/core/sigbus.ts  引脚信号总线:每批 gpio_state() 差分分发               │
│ build/core/registry.ts 插件注册表(manifest 驱动 + 元数据校验)              │
│ build/core/{version,types,protocol,chips,mmio}.ts  版本/契约/消息/芯片表/寄存器表 │
│ worker 侧设备 Device(peris/devices/*.js 的 Device 类)                      │
└───────────────────────────┬─────────────────────────────────────────────────┘
                            │ WasmEmulator(闭源 wasm,只此一处触碰)
                    esp_emu_bg.wasm v0.51.0
```

## 2. 关键决策与理由

| 决策 | 理由 |
|---|---|
| 模拟器只存在于 worker | 页面永不触碰 wasm;所有交互走 postMessage,线程模型不可能被破坏 |
| 框架层 TypeScript、设备插件原生 JS | 类型检查覆盖 bug 高发区(本次重构即修掉状态丢弃缺陷);插件保持"丢文件即用",不引入构建依赖 |
| tsc 逐文件编译、不打包 | 产物仍是标准 ESM 目录,部署模型不变(www 只增不改);上游同构,升级 diff 容易 |
| 样式拆 peris.css,上游样式原块留 HTML | 升级时直接 diff HTML 里的上游段 |
| 数据在 TS 常量(chips/mmio)而非 JSON | tsc 原生携带、类型检查、无运行时拷贝问题 |
| registry 运行时校验插件元数据 | 插件作者没有编译期检查,缺 `pins()`/`typeId` 在加载时即报错(真实 bug 类) |

## 3. 数据流与状态归属

- **固件 → 设备**:worker 每批 `run_batch()` 后 `runtime.onBatchEnd()` → `sigbus.sample()`
  读 `gpio_state()`(4 个 32 位字),按**联合变化掩码**(out|oe)对每个变化引脚分发一次
  `onPinState`。无变化时成本 = 1 次 wasm 调用 + 4 次 XOR。
- **设备 → 页面**:设备 `markDirty()` → `flushStates` 节流 ~30fps;**节流窗口内挂尾随
  定时器,保证最后一次 dirty 必达**(否则静止在窗口内的最终状态会被丢弃)。
- **页面 → 设备**:View `sendCmd()` → `peris_command` → `runtime.command()` → `onCommand`。
- **输入引脚电平**:唯一写者是 `ctx.setPinInput`(设备)与 Debug 网格的 `gpio_input`。
  页面侧 `gpioInputLevels[]` 只是 Debug 网格自己的镜像,不是权威状态;权威状态在设备里
  (`onEmuReady` 时重驱动)。
- **配置**:页面 `PerisPanel.config` 是唯一事实源;每次变更全量 `peris_config` 下发
  (worker 销毁重建实例)并写 localStorage。引脚冲突由 worker 校验后回报
  `peris_ready.errors`,页面黄条展示。

## 4. 目录职责

```
src/core/        worker 侧框架(TS 源)        → 编译到 build/core/
src/ui/          页面侧模块(TS 源)            → 编译到 build/ui/
build/           tsc 产物(未入 git;HTML/worker/测试都引用这里)
peris/devices/   设备插件(JS 源,不编译;manifest.json 注册;各自版本号)
peris/vendor/    xterm 本地化
peris/peris.css  peris 专属样式
tests/unit/      单元测试(node:test,零依赖)
tests/m1_smoke.mjs  集成冒烟(真实 wasm+固件+runtime+设备)
tests/m0_probe.mjs  模拟器能力探针(升级上游时先跑它)
tests/firmware/  IDF 测试固件
```

## 5. 构建与测试

```bash
npm install                 # 一次性(typescript 走 npmmirror 源)
npm run build               # tsc → peris/core + peris/ui(改 src 后必须)
npm run check               # 仅类型检查
npm test                    # 单测 + 集成冒烟
npm run serve               # python serve.py(合并服务仓库与 www/pkg)
npm run sync                # 发布进官方 www(先 build)
```

测试分层:**单元**(纯逻辑:位运算/电平语义/校验——快、定位准)→ **集成**(真实
wasm+固件全链路)→ **GUI**(手动清单:页面加载、加设备、载固件、Run 后 LED 翻转、
配置导入导出往返;浏览器自动化待网络环境允许时引入 Playwright,
`PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`)。

## 6. 升级流程(摘要,详见 UPGRADE.md)

1. 新 wasm 包就位后先跑 `npm run test:m0`,对比 FEASIBILITY.md 结论;
2. diff 上游 worker.js ↔ `src/core/worker.ts`(改动均标 `peris:`);
3. diff 上游 app.js/index.html ↔ `src/ui/*.ts` 与 HTML 的上游样式段;
4. `npm run build && npm test`,GUI 冒测。

## 7. 扩展点

- **新外设**:`peris/devices/` 放模块 + manifest 一行(见 docs/DEVICE-API.md);Worker/页面
  自动加载,元数据即时校验。
- **新芯片**:`src/core/mmio/<chip>.ts` 加地址表 + 注册到 `mmio.ts`;`chips.ts` 补引脚数。
- **新页面面板**:ui/ 加模块,在 app.ts 的消息路由注册——worker 协议不动。
