[English](AGENT.md) | **简体中文**

# AGENT.md — 后续 Agent 必读(坑与约定)

本文件沉淀开发至今的全部环境坑、架构约定与验证方法。**动手前先读完本文。**
(英文版:AGENT.md——两种语言需同步修改,见 §7。)

## 0. 快速上手

```bash
npm install                # typescript 走 npmmirror(见 §1)
npm run build              # prebuild 先把 esp-emulator 浏览器构建下载到
                           # vendor/esp-emu-browser/(首次),然后 tsc:src/ → build/
                           #(改 src 后必须;build/ 不入 git)
npm test                   # 单元测试 + 集成冒烟
npm run serve              # http://127.0.0.1:8080/esp-emu-peris.html
npm run sync               # 发布进 vendor/esp-emu-browser/www(先 build;--clean 清残留)
```

架构与数据流见 `docs/ARCHITECTURE.zh-cn.md`;外设开发见 `docs/DEVICE-API.zh-cn.md`;
esp-emulator wasm 能力边界见 `docs/EMU-API.zh-cn.md` 与 `docs/FEASIBILITY.zh-cn.md`(M0 实测)。

## 1. 环境坑(本机)

- **CDN 不可达**:jsdelivr 直连被重置。npm 用镜像:
  `npm --registry=https://registry.npmmirror.com install ...`;静态资源从
  `https://registry.npmmirror.com/<pkg>/-/<name>-<ver>.tgz` 下 tarball 解包
  (xterm 就是这样 vendor 进 `peris/vendor/` 的;包内是**非压缩**版,无 .min)。
- **GitHub 下载要走本机代理**:`https_proxy=http://127.0.0.1:10809`。
  esp-emulator 浏览器(wasm)构建由 `tools/fetch_esp_emu.py` 从
  espressif/esp-emulator 的 GitHub release 下载(`npm run build`/`npm test`
  自动触发;识别 `https_proxy`;sha256 校验;tarball 缓存在
  `vendor/downloads/`;解压到 `vendor/esp-emu-browser/www`)。用
  `ESP_EMU_WWW=/path/to/www` 可改指向。
- **Playwright 浏览器二进制**未装(网络);要装:
  `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright`。
- **ESP-IDF**:master 检出在 `C:\esp\master\esp-idf`,环境启用用
  `C:\Users\A\Desktop\quick\idfm.bat`(PowerShell profile)。脚本化调用**必须清掉
  `MSYSTEM` 环境变量**(Git Bash 继承它,idf.py 会拒绝),参考 `tests/firmware/build.ps1`。
- 固件加载进浏览器**必须 `idf.py merge-bin`** 的 merged image;裸 app bin 无声不启动
  (症状:UART 永远无输出)。产物:`tests/firmware/peris_probe/build/merged-binary.bin`,
  用 `tests/firmware/merge.ps1` 生成——**merge-bin 的 `-o` 相对 build 目录**,
  直觉写法 `build/merged-binary.bin` 会落到 `build/build/` 且无声失败。
- `node --test <目录>` 在 Windows/Git Bash 下解析异常,**显式传 .test.mjs 文件列表**
  (package.json 已如此)。

## 2. esp-emulator wasm 行为(实测,勿凭直觉)

- **没有回调**,一切靠 `run_batch()` 批间轮询;UART 输出是 `run_batch` 的返回字符串。
- **LEDC/RMT 波形不出现在 `gpio_state()`**(它们走 GPIO matrix);只有 CPU 直写 GPIO 可见。
  PWM→读 LEDC `DUTY_R`(值=duty×16,bits[18:4];满量程经 `conf0.TIMER_SEL`→timer
  `DUTY_RES` bits[3:0];`conf0` bit2=sig_out_en),接线→扫 `GPIO_FUNCn_OUT_SEL_CFG`
  低 9 位(LEDC ch0–5=45–50,0x100=普通 GPIO),WS2812→读 RMT 通道 RAM(发送后留存)。
  以上全部只有一份实现:`peris/devices/ledc-lib.js`——复用,禁止另写。
  地址表:`src/core/mmio/`,来源与验证:FEASIBILITY.zh-cn.md。
- **RMT 通道 RAM(WS2812,M3 实测)**:copy encoder **每个 WS2812 位写一个
  RMT 字**;字写到 48 后回绕;发送结束后 RAM 里只有复位符号、一个全零终止字
  和**最后 46 位**——解码帧尾,以复位符号(低 ≥30µs)重同步并前置补零对齐
  LED 网格。`CHnSTATUS` bits[11:9] ≠ 0 表示正在发送(此时跳过解码)。C3 的
  RMT pad 信号只有 ch0/1(51/52)。唯一实现:`peris/devices/ws2812-lib.js`
  ——复用,禁止另写。
- **`vTaskDelay` 期间时间快进**:睡眠窗口内引脚级波形不可捕获,与采样率无关。
  CPU 活跃的位绑定波形可采样,但**同一批次间隙内连续翻转输入会丢边沿**
  (press→release 必须隔批次,见 m1_smoke S3)。警戒租约常设(~1000 指令/批)
  时,睡眠批次跳跃 **~68 万周期**——一整轮固件 ~2500 批就跑完,而 P4 的细批
  窗口要 ~16.6 万批。测试窗口**永不按批数定界**,一律按 UART 标记。
- **客户时钟失真(M4)**:`esp_rom_delay_us` 推进的仿真时间只有名义值的
  ~50%("9 ms" 引导突发实测 4.505 ms);`vTaskDelay` 保持完整时长。解码器
  必须基于电平或比值,绝不能用绝对微秒窗口(见 FEASIBILITY.zh-cn.md
  "M4 实测")。
- **GPIO 输入脉冲需要仿真时间间隔(M4)**:警戒批尺寸下,每 8 批按压、保持
  3 批(仿真约 10–40 ms)计数可靠;更密会丢边沿,M0 的指令数形状放不进
  一个相位。
- **RMT `CHnSTATUS.APB_MEM_WADDR` 恒读 0**(未实现)——发送中途拼接通道
  RAM 不可行,只能用发送后的窗口。
- **BME280 的 dig_T1/dig_P1 是 uint16**(Bosch 布局):36477 在 int16 里静默
  变负——T/H 仍吻合、只有 P 偏离(正是靠这个特征定位的 bug)。
- `gpio_set_input` 默认电平高(上拉);能触发固件 GPIO 中断(可靠)。
- 新 `WasmEmulator` 实例后输入电平复位 → 设备必须在 `onEmuReady()` 重驱动。

## 3. 架构铁律(docs/ARCHITECTURE.zh-cn.md 有完整图)

1. **模拟器只在 worker**:页面永不 import wasm;一切经 `src/ui/worker-client.ts`。
2. **worker 里唯一允许复刻上游逻辑的文件是 `src/core/worker.ts`**,改动必须带
   `peris:` 标记,便于上游升级 diff(docs/UPGRADE.zh-cn.md 流程)。
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
9. **寄存器级设备(LEDC/RMT)在 `onBatch()` 里轮询 MMIO**,地址来自
   `ctx.mmio`(各芯片表在 `src/core/mmio/`;无表=设备必须闲置)。设备侧共享
   语义放在 `peris/devices/` 下**不进 manifest** 的原生 JS 辅助模块
   (`ledc-lib.js`——接线扫描、占空比解码、灯泡绘制+动画器),插件与单元测试
   引用同一份实现。LEDC 设备的 `pins()` 返回 `[]`(接线是固件侧路由,无可声明);
   通用编辑器的 `<select>` 回传**字符串**(`parseChannel` 归一化;小心
   `Number(null)===0`)。
10. **位绑定设备依托采样调度器(M4)**:构造时 `ctx.armSampling` 一次(空闲
   监视),每个边沿 `ctx.fineSampling`(可续约租约;CPU 睡眠快进自动失效)。
   禁止常驻细批轮询——调度器是唯一的批量路径(`runtime.batchSize()`,worker
   与测试共用)。总线设备声明 `static sharedBus = true`;runtime 对共享焊盘
   的输入驱动做线与(gpio_set_input 是单赢家电平写——两个从机引擎否则会
   互相覆盖 ACK 拉低,真实 M4 缺陷)。
11. **View 可以持有行以外的 DOM**(逻辑分析仪的浮动窗口挂在
   `document.body` 上、`position: fixed`,刻意非模态——绝不加遮罩)。此类
   View 必须实现 `destroy()`(面板在行移除与列表重建时调用),多引脚选择
   器必须基于 `host.pinInfo()` 构建——与通用编辑器同一份、按候选设备感知
   的引脚集合,禁止另抄一份。`ctx.pinLevel(pin)` 只用于快照式读取当前驱动
   电平;变化流仍然走 `onPinState`。

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
| 节流窗口丢最后一次状态 | 尾随 flush(见 §3.6) |
| LED 行图标颜色与详情灯泡不一致(0.3.0) | 面板曾先 setConfig 后 rowIcon,且插件两处各自设色;统一 setColour + 固定调用顺序(§3.8) |
| 换芯片加载固件后,详情编辑器 GPIO 选项仍是旧芯片(0.3.0) | 编辑器把 validPins 快照在构建时;芯片变化必须重建编辑器;选项构建统一走 fillPinOptions(§3.8) |
| m1 标记:`line === '###P1 end'` 永不匹配(固件打印 `###P1 end btn=N`),inP1 卡在 true,循环跑过整轮(M4) | 固件在标记后追加数据时要用 `startsWith` 匹配;卡死的相位标志会静默出错——一切循环按标记定界 |
| 同总线两个 I2C 从机每笔事务都 NACK(M4) | gpio_set_input 是单赢家电平写;共享总线焊盘需要 runtime 的线与仲裁(`sharedBus` 元数据) |
| 引擎从不应答读方向地址字节(M4,单测抓出) | ACK 决定属于**刚完成的字节**(`ackThisByte`),不能按(已切换的)phase 判断 |
| C 补偿与 JS 模型只在气压上分歧(M4) | dig_P1 在 Bosch 布局里是 uint16;36477 在 int16 回绕成负——靠冒烟测试保持 C/JS 逐位一致 |
| 逻辑分析仪弹窗打开后是空的(0.10.0 GUI 冒烟):构造中途一个漏写 `this.` 的 `trigSel` 抛错,半成品窗口留在屏上 | 单元测试从不执行 View 的 DOM 代码——构建弹窗的插件要用带 `window.addEventListener('error')` 陷阱的 GUI 冒测;`setPointerCapture` 还要 try/catch(合成/自动化的指针事件没有活跃指针 id,会抛 NotFoundError 直接弄死拖动) |

## 5. 测试与验证约定

- **单元测试**(node:test,零依赖):纯逻辑——sigbus 位运算、电平语义、配置校验、
  MMIO 地址表,以及基于**假 MMIO** 的 LEDC 占空比解码/接线扫描/自动绑定语义
  (`Map<addr,u32>` + 真实 C3 表,见 tests/unit/devices.test.mjs 的 `makeMmioCtx`)。
  M4 协议层(调度器租约、合成开漏主机驱动的 I2C 引擎、寄存器模型、补偿
  锚点、NEC 解码、sharedBus 规则)在 `tests/unit/protocol.test.mjs`。
  改 core/devices 必跑;新增设备按类型仿照 `tests/unit/devices.test.mjs`
  (GPIO 语义)或 `tests/unit/protocol.test.mjs`(协议引擎)补用例。
- **集成冒烟** `tests/m1_smoke.mjs`:真实 wasm+固件+runtime+设备
  (S1–S6 GPIO 设备——其中 S4b 驱动 `###P1b` 数字输入采样:开关/触摸/
  按键电平被客户机读回并镜像到 LED,S7/S8 LEDC 寄存器级设备按 `###P2`
  标记驱动,S9 ws2812 按 `###P3`,S10/S11 为 M4 的 I2C+IR 设备按
  `###P4`,S13 逻辑分析仪在 P4 软 I2C 总线上武装捕获(SCL/SDA 与 i2c
  从机合法共享);S12 为**本机可选用例**:在第二个模拟器实例里启动 gun 0.1.0
  发布件——真实 ESP32-S3 固件,无延时位绑定驱动 MAX7219——
  `D:/d3/_git/gun_flag_monster/gun/release/0.1.0/gun-0.1.0-merged.bin`
  缺失时打印提示跳过;gun 项目是只读参考,绝不可改动,且其后续版本改用
  硬件 SPI(按 M0 不可见))。**时序经验**:
  - **按 UART 标记驱动,永不按批数**——M4 租约常设时一个睡眠批次快进
    ~68 万周期,按批数的窗口会跑过整轮(固件打印 `###P1/P1b..P4 start/end`
    与 `###ROUND`,见 `tests/firmware/peris_probe/main/main.c`);
  - 固件在标记后追加数据时用 `startsWith` 匹配——`###P1 end btn=N` 曾
    让全等匹配失效;
  - 固件在每轮 P1 start 把按键计数**清零**,计数可能只出现在
    `###P1 end btn=N` 行;按压需要仿真节奏(每 8 批保持 3 批,§2);
  - 测试里采样状态用强制 `rt.flushStates(true)`——等墙钟节流会让断言抖动。
- **M0 探针** `tests/m0_probe.mjs`:上游 wasm 升级后**第一个跑**的东西,六项
  结论(Q1a..Q3b)若有变化先改 FEASIBILITY/EMU-API 文档再动其它代码。
- **GUI 冒测**(手动,清单在 ARCHITECTURE §5):本会话所用 IAB 自动化易劣化
  (点击 actionability 超时、截图 surface 失败、xterm DOM 只渲染视口行且 rAF
  停滞时整块冻结)——**DOM 只读断言最可靠**;固件注入可用页面自身 drop 处理器
  (同源 fetch → File → DataTransfer → drop 事件)作为环境准备。

## 6. 版本与发布

- 项目版本:`src/core/version.ts` + `package.json` + `docs/CHANGELOG.zh-cn.md`(英文版
  CHANGELOG.md 同步)三处同步。
- 设备版本:各插件 `static version`,行头展示;CHANGELOG 有设备版本表。
- 发进 www 用 `npm run sync`(--clean 清旧产物);www 原版文件(index.html/app.js/
  worker.js/pkg/serve.py)**永远不动**。

## 7. 文档约定(双语)

- 所有文档两种语言:**英文版用默认文件名**,**中文版 `*.zh-cn.md`**
  (README/AGENT/docs/*);两版第一行互链,文内链接保持同语言跳转。
- 任何文档改动必须在**同一次提交**里落到两种语言——不许"以后再翻译"。
