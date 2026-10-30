# AGENT.md — 后续 Agent 必读(坑与约定)

本文件沉淀开发至今的全部环境坑、架构约定与验证方法。**动手前先读完本文。**

## 0. 快速上手

```bash
npm install                # typescript 走 npmmirror(见 §1)
npm run build              # tsc:src/ → build/(改 src 后必须;build/ 不入 git)
npm test                   # 单元测试 + 集成冒烟
npm run serve              # http://127.0.0.1:8080/esp-emu-peris.html
npm run sync               # 发布进 _tools/esp-emu-browser/www(先 build;--clean 清残留)
```

架构与数据流见 `docs/ARCHITECTURE.md`;外设开发见 `docs/DEVICE-API.md`;
esp-emulator wasm 能力边界见 `docs/EMU-API.md` 与 `docs/FEASIBILITY.md`(M0 实测)。

## 1. 环境坑(本机)

- **CDN 不可达**:jsdelivr 直连被重置。npm 用镜像:
  `npm --registry=https://registry.npmmirror.com install ...`;静态资源从
  `https://registry.npmmirror.com/<pkg>/-/<name>-<ver>.tgz` 下 tarball 解包
  (xterm 就是这样 vendor 进 `peris/vendor/` 的;包内是**非压缩**版,无 .min)。
- **Playwright 浏览器二进制**未装(网络);要装:
  `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`。
- **ESP-IDF**:master 检出在 `C:\esp\master\esp-idf`,环境启用用
  `C:\Users\A\Desktop\quick\idfm.bat`(PowerShell profile)。脚本化调用**必须清掉
  `MSYSTEM` 环境变量**(Git Bash 继承它,idf.py 会拒绝),参考 `tests/firmware/build.ps1`。
- 固件加载进浏览器**必须 `idf.py merge-bin`** 的 merged image;裸 app bin 无声不启动
  (症状:UART 永远无输出)。产物:`tests/firmware/peris_probe/build/merged-binary.bin`。
- `node --test <目录>` 在 Windows/Git Bash 下解析异常,**显式传 .test.mjs 文件列表**。

## 2. esp-emulator wasm 行为(实测,勿凭直觉)

- **没有回调**,一切靠 `run_batch()` 批间轮询;UART 输出是 `run_batch` 的返回字符串。
- **LEDC/RMT 波形不出现在 `gpio_state()`**(它们走 GPIO matrix);只有 CPU 直写 GPIO 可见。
  PWM→读 LEDC `DUTY_R`(值=duty×16),WS2812→读 RMT 通道 RAM(发送后留存)。
  地址表:`src/core/mmio/`,来源与验证:FEASIBILITY.md。
- **`vTaskDelay` 期间时间快进**:睡眠窗口内引脚级波形不可捕获,与采样率无关。
  CPU 活跃的位绑定波形可采样,但**同一批次间隙内连续翻转输入会丢边沿**
  (press→release 必须隔批次,见 m1_smoke S3)。
- `gpio_set_input` 默认电平高(上拉);能触发固件 GPIO 中断(可靠)。
- 新 `WasmEmulator` 实例后输入电平复位 → 设备必须在 `onEmuReady()` 重驱动。

## 3. 架构铁律(docs/ARCHITECTURE.md 有完整图)

1. **模拟器只在 worker**:页面永不 import wasm;一切经 `src/ui/worker-client.ts`。
2. **worker 里唯一允许复刻上游逻辑的文件是 `src/core/worker.ts`**,改动必须带
   `peris:` 标记,便于上游升级 diff(docs/UPGRADE.md 流程)。
3. **设备插件是原生 JS**(丢文件即用,不参与构建);框架是 TS。别给 devices/ 加
   import 依赖到 src/ 运行时模块(可用 `build/core/*.d.ts` 类型做 JSDoc 提示)。
4. 插件元数据必须含 `static pins(cfg)`(冲突检测)、`typeId`、`title`、
   `defaultConfig`,可选 `version`;registry 加载时校验,**缺了当场报错**。
5. 配置以页面 `PerisPanel.config` 为唯一事实源,变更全量下发+localStorage;
   不要在 worker 侧缓存/修改配置。
6. 状态推送有 33ms 节流 + **尾随定时器**(保证最后一次 dirty 必达)——别删掉尾随逻辑,
   那是修过的真实缺陷(状态静默丢失)。
7. sigbus 按批做 gpio_state 差分,**联合掩码**(out|oe)每引脚每批至多通知一次。
8. **同语义代码必须复用,禁止复制一份再改**:同一逻辑只允许一份实现,所有
   入口(行内 chip / 详情编辑器 / 行图标 / 新插件)调用同一函数——
   GPIO 可选项= `config-editor.ts fillPinOptions()`;V·G 徽章推导=`rowChips()`;
   插件多视觉元素(如 LED 灯泡+行图标)共用同一 setter/render,不许给图标
   单写一份样式逻辑;面板对 View 固定 **先 `rowIcon` 后 `setConfig`**,
   保证配置式样能覆盖到图标。改行为前先找有没有既有函数,有就复用;
  review 发现两处雷同代码时,先抽公共函数再改。

## 4. 曾踩过的 bug(防止回潮)

| bug | 教训 |
|---|---|
| registry 把 manifest 模块路径解析到 `peris/` 根 | manifest 路径相对 devices/ 目录,编译位置变化要同步改 `DEVICES_DIR` |
| 设备构造函数里 `ctx.subscribe()` 时实例未注册 | sigbus 存**取值函数**惰性解析,不要存实例 |
| 错误条 `style.display=''` 回退 CSS `none` 永不可见 | 显式 `display='block'`,且无错时清空 textContent(避免读到陈旧报错) |
| `peris_config` 早于 registry init 到达 → 全部 unknown type | `applyConfig` 先 await init |
| 设备漏写 `static pins()` → 冲突检测静默失效 | registry 强制校验 + 单测覆盖 |
| 按键 activeLow 电平写反 | idle=高、pressed=低(active-low 上拉接法);单测固定语义 |
| Worker URL 相对**页面**解析,不是相对 import 的模块 | worker-client 里写页面相对路径 `build/core/worker.js` |
| 节流窗口丢最后一次状态 | 尾随 flush(见 §3.7) |
| LED 行图标颜色与详情灯泡不一致(0.3.0) | 面板曾先 setConfig 后 rowIcon,且插件两处各自设色;统一 setColour + 固定调用顺序(§3.8) |
| 换芯片加载固件后,详情编辑器 GPIO 选项仍是旧芯片(0.3.0) | 编辑器把 validPins 快照在构建时;芯片变化必须重建编辑器;选项构建统一走 fillPinOptions(§3.8) |

## 5. 测试与验证约定

- **单元测试**(node:test,零依赖):纯逻辑——sigbus 位运算、电平语义、配置校验、
  MMIO 地址表。改 core/devices 必跑;新增设备请仿照 `tests/unit/devices.test.mjs`
  补电平/状态语义用例。
- **集成冒烟** `tests/m1_smoke.mjs`:真实 wasm+固件+runtime+设备。**时序经验**:
  - boot 约占 500+ 批(50k 指令/批),别盲选批次号,**按 UART 标记驱动**
    (固件用 `###P1 start/end` 等标记,见 `tests/firmware/peris_probe/main/main.c`);
  - 固件在每轮 P1 start 把按键计数**清零**,计数可能只出现在 `###P1 end btn=N` 行,
    断言正则别只匹配 `i=` 行;
  - flushStates 有节流,读状态断言前 `await` ~60ms。
- **M0 探针** `tests/m0_probe.mjs`:上游 wasm 升级后**第一个跑**的东西,六项
  结论(Q1a..Q3b)若有变化先改 FEASIBILITY.md/EMU-API.md 再动其它代码。
- **GUI 冒测**(手动,清单在 ARCHITECTURE.md §5):本会话所用 IAB 自动化易劣化
  (点击 actionability 超时、截图 surface 失败、xterm DOM 只渲染视口行且 rAF
  停滞时整块冻结)——**DOM 只读断言最可靠**;固件注入可用页面自身 drop 处理器
  (同源 fetch → File → DataTransfer → drop 事件)作为环境准备。

## 6. 版本与发布

- 项目版本:`src/core/version.ts` + `package.json` + `docs/CHANGELOG.md` 三处同步。
- 设备版本:各插件 `static version`,卡片头展示;CHANGELOG 有设备版本表。
- 发进 www 用 `npm run sync`(--clean 清旧产物);www 原版文件(index.html/app.js/
  worker.js/pkg/serve.py)**永远不动**。
