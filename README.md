# esp-emu-peris

为乐鑫 [esp-emulator](https://github.com/espressif/esp-emulator) 浏览器形态(wasm)做的**模拟外设面板**:LED、按键、触摸按键、拨动开关……以插件方式不断添加,不需要改动官方 `www/` 里的任何基础文件。

```
esp-emu-peris.html      入口页面(UART0 控制台 + 右侧 Peripherals/Debug 双标签)
peris/                  全部前端代码(自有 worker + 设备插件框架)
  worker.js             官方 worker 的复刻 + 每批引脚采样钩子(改动均标 peris:)
  app.js                官方页面逻辑复刻 + Peripherals 面板
  device-api.js         外设接口契约 v1(见 docs/DEVICE-API.md)
  registry.js           插件注册表(manifest 驱动)
  runtime.js            worker 侧设备宿主
  sigbus.js             引脚信号总线(变化分发)
  protocol.js / chips.js / mmio/
  devices/              外设插件:led / button / touch-button / toggle-switch
examples/               接线配置示例(JSON,可直接 Import)
tests/                  M0 探针(Node)+ 测试固件(ESP-IDF)
docs/                   FEASIBILITY(M0 验证报告)/ DEVICE-API / UPGRADE / ROADMAP
```

## 快速开始

```bash
# 1) 开发服务器(合并服务本仓库与 _tools/esp-emu-browser/www 的 pkg/)
python serve.py                # http://127.0.0.1:8080/esp-emu-peris.html

# 2) 浏览器打开上面的地址,选择芯片、拖入 merged flash image(.bin)
#    注意:必须是 idf.py merge-bin 生成的完整镜像,裸 app bin 无法启动

# 3) 右侧 Peripherals 标签:Add 添加 LED/按键等,选好 GPIO;
#    Export/Import 导出/导入接线配置(JSON,自动存 localStorage)
```

把外设面板**发布**进官方 www 目录(只增不改):

```bash
python sync_www.py             # 或 sync_www.bat;之后 www/esp-emu-peris.html 即可用
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

## 测试固件与 M0 探针

```powershell
# 构建(用 C:\Users\A\Desktop\quick\idfm.bat 的 IDF 环境)
powershell -ExecutionPolicy Bypass -NoProfile -File tests\firmware\build.ps1
# 生成 merged image(加载用):
#    tests/firmware/peris_probe/build/merged-binary.bin

# Node 里直接验证模拟器能力(GPIO 可见性 / MMIO / WS2812 解码)
node tests/m0_probe.mjs

# M1 框架集成冒烟(真实 runtime+设备模块+wasm:配置应用/LED 状态/
# 按键 ISR 计数/开关命令/引脚冲突/未知类型拒绝)
node tests/m1_smoke.mjs
```

固件三阶段循环:GPIO8 闪烁 / GPIO9 LEDC 呼吸 / GPIO4 RMT-WS2812 发帧,
并配合 GPIO3 输入中断计数,用于端到端验证。

注:页面自身不依赖任何 CDN——xterm/xterm-addon-fit 已本地化到
`peris/vendor/`(取自 npm 包的非压缩构建),离线可用。
