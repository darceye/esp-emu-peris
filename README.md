# esp-emu-peris

为乐鑫 [esp-emulator](https://github.com/espressif/esp-emulator) 浏览器形态(wasm)做的**模拟外设面板**:LED、按键、触摸按键、拨动开关……以插件方式不断添加,不需要改动官方 `www/` 里的任何基础文件。

```
esp-emu-peris.html      入口页面(UART0 控制台 + 右侧 Peripherals/Debug 双标签)
src/                    TypeScript 源码(npm run build → peris/core + peris/ui)
  core/                 worker 侧框架:types/protocol/chips/mmio/sigbus/registry/runtime/worker
  ui/                   页面侧模块:app/worker-client/terminal/chart/debug-panels/peris-panel/config-editor
peris/
  core/  ui/            编译产物(tsc,未入 git;npm run build 生成)
  devices/              外设插件(原生 JS,丢文件即用):led/button/touch-button/toggle-switch
  vendor/ peris.css     xterm 本地化 + 面板样式
examples/               接线配置示例(JSON,可直接 Import)
tests/unit/             单元测试(node:test)
tests/m1_smoke.mjs      集成冒烟(真实 wasm+固件全链路)
tests/m0_probe.mjs      模拟器能力探针(上游升级时先跑)
tests/firmware/         ESP-IDF 测试固件
docs/                   ARCHITECTURE / FEASIBILITY / DEVICE-API / UPGRADE / ROADMAP
```

架构、数据流、状态归属与扩展点见 **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**。

## 快速开始

```bash
# 一次性:npm 依赖(自动用 npmmirror 源装 typescript)
npm install

# 开发循环:改 src/ → 构建 → 测试 → 起 merged 开发服务器
npm run build
npm test
npm run serve               # http://127.0.0.1:8080/esp-emu-peris.html

# 浏览器打开上面的地址,选择芯片、拖入 merged flash image(.bin)
# 注意:必须是 idf.py merge-bin 生成的完整镜像,裸 app bin 无法启动

# 右侧 Peripherals 标签:Add 添加 LED/按键等,选好 GPIO;
# Export/Import 导出/导入接线配置(JSON,自动存 localStorage)
```

把外设面板**发布**进官方 www 目录(只增不改;先 build):

```bash
npm run sync                 # 复制入口 html + peris/(含编译产物)+ examples/
```

## 能力与限制(实测结论,详见 docs/FEASIBILITY.md)

| 外设 | 状态 | 途径 |
|---|---|---|
| 各色 LED | ✅ M1 | 轮询 GPIO 输出寄存器 |
| 物理按键 / 触摸按键(GPIO 语义)/ 拨动开关 | ✅ M1 | 驱动引脚输入,固件可读到并触发中断 |
| PWM 调光 LED / RGB | 🔜 M2 | 读 LEDC duty 寄存器(引脚级 PWM 不可见) |
| WS2812 幻彩灯 | 🔜 M3 | 读 RMT 通道 RAM 解码(引脚级波形不可见) |
| 位绑定 I2C/SPI 设备、IR | 🔜 M4 | 高速引脚采样(需固件位绑定) |
| 硬件 I2C/SPI 设备、显示屏、ADC、真触摸、I2S、SD | ⏸ M5 | 等 esp-emulator 上游暴露 API |

注:触摸**外设**未被模拟——触摸按键以 GPIO 输入呈现,固件按 GPIO 读取即可
(`tests/firmware/peris_probe` 有示例:GPIO3 输入 + 下降沿 ISR)。

## 添加一个新外设

1. 在 `peris/devices/` 放一个模块,导出 `Device` 与 `View`(接口见
   `peris/device-api.js` 顶部注释或 docs/DEVICE-API.md);
2. 在 `peris/devices/manifest.json` 加一行。完成——页面和 worker 会自动加载。

```js
// peris/devices/my-dev.js
export class Device {
    static typeId = 'my-dev'; static title = 'My Device'; static category = 'misc';
    static defaultConfig = { name: 'My', pin: 6 };
    static configSchema = [{ key: 'pin', label: 'GPIO pin', type: 'pin' }];
    static pins(cfg) { return [cfg.pin]; }
    constructor(ctx, cfg) { this.ctx = ctx; ctx.subscribe([cfg.pin]); }
    onPinState(pin, s) { this.on = s.oe && s.out; this.ctx.markDirty(); }
    getState() { return { on: this.on }; }
    destroy() { this.ctx.unsubscribe(); }
}
export class View {
    constructor(el, sendCmd) { el.textContent = 'hello'; }
    render(state) { }
}
```

## 测试固件与测试

```powershell
# 构建固件(用 C:\Users\A\Desktop\quick\idfm.bat 的 IDF 环境)
powershell -ExecutionPolicy Bypass -NoProfile -File tests\firmware\build.ps1
# 生成 merged image(加载用):
#    tests/firmware/peris_probe/build/merged-binary.bin
```

```bash
npm test                     # 单元测试 + 集成冒烟(见 docs/ARCHITECTURE.md 测试分层)
npm run test:m0              # 模拟器能力探针(上游 wasm 升级时先跑)
```

固件三阶段循环:GPIO8 闪烁 / GPIO9 LEDC 呼吸 / GPIO4 RMT-WS2812 发帧,
并配合 GPIO3 输入中断计数,用于端到端验证。

注:页面自身不依赖任何 CDN——xterm/xterm-addon-fit 已本地化到
`peris/vendor/`(取自 npm 包的非压缩构建),离线可用。
