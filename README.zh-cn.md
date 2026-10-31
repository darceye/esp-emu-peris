[English](README.md) | **简体中文**

# esp-emu-peris

为乐鑫 [esp-emulator](https://github.com/espressif/esp-emulator) 浏览器形态(wasm)做的**模拟外设面板**:LED、按键、触摸按键、拨动开关、PWM/RGB 调光 LED……以插件方式不断添加,不需要改动官方 `www/` 里的任何基础文件。

```
esp-emu-peris.html      入口页面(UART0 控制台 | 外设行式面板 | Debug,三栏同屏)
src/                    TypeScript 源码(npm run build → build/)
  core/                 worker 侧框架:version/types/protocol/chips/mmio/sigbus/registry/runtime/worker
  ui/                   页面侧模块:app/worker-client/terminal/chart/debug-panels/peris-panel/config-editor
build/                  编译产物(tsc,未入 git;core/ + ui/)
peris/
  devices/              外设插件(原生 JS,丢文件即用,含各自版本号):led/button/touch-button/
                        toggle-switch + pwm-led/rgb-led(寄存器级,共享辅助在 ledc-lib.js)
                        + ws2812(RMT 通道 RAM,ws2812-lib.js)
                        + bitbang-i2c-slave(24C02/BME280,i2c-lib.js)+ ir-nec(NEC 接收,
                          nec-lib.js;两者都依托 M4 细批采样调度器)
  vendor/ peris.css     xterm 本地化 + 面板样式
examples/               接线配置示例(JSON,可直接 Import;esp32c3-probe.json
                        按探针固件引脚接线全部 11 个设备——导入即可测遍外设)
tests/unit/             单元测试(node:test)
tests/m1_smoke.mjs      集成冒烟(真实 wasm+固件全链路)
tests/m0_probe.mjs      模拟器能力探针(上游升级时先跑)
tests/firmware/         ESP-IDF 测试固件
docs/                   ARCHITECTURE / EMU-API / FEASIBILITY / DEVICE-API / CHANGELOG / UPGRADE / ROADMAP
AGENT.md                环境/架构/坑(贡献前必读)
```

架构、数据流、状态归属与扩展点见 **[docs/ARCHITECTURE.zh-cn.md](docs/ARCHITECTURE.zh-cn.md)**;
版本规则见 **[docs/CHANGELOG.zh-cn.md](docs/CHANGELOG.zh-cn.md)**(项目版本三处同步,设备有独立版本)。

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

# 外设栏(控制台右侧):+ 图标添加 LED/按键等;每外设一行——行内图标可交互
# (LED 点击换色/按键按压),名称、GPIO 方框、V/G 电平徽章点击即改,
# ▸ 展开详情与高级配置,⠿ 拖动排序;面板头部:项目名输入框 + 保存/打开图标
# (导出/导入接线配置 JSON,自动存 localStorage 并记忆芯片,下次打开自动
# 选中)
```

把外设面板**发布**进官方 www 目录(只增不改;先 build):

```bash
npm run sync                 # 复制入口 html + peris/(含编译产物)+ examples/
```

## 能力与限制(实测结论,详见 docs/FEASIBILITY.zh-cn.md)

| 外设 | 状态 | 途径 |
|---|---|---|
| 各色 LED | ✅ M1 | 轮询 GPIO 输出寄存器 |
| 物理按键 / 触摸按键(GPIO 语义)/ 拨动开关 | ✅ M1 | 驱动引脚输入,固件可读到并触发中断 |
| PWM 调光 LED / RGB LED | ✅ M2 | 读 LEDC duty 寄存器;通道→引脚接线从 GPIO 矩阵自动发现(引脚级 PWM 不可见);canvas 亮度插值呈现呼吸效果 |
| WS2812 幻彩灯 | ✅ M3 | 读 RMT 通道 RAM 解码(引脚级波形不可见);灯带/环形/矩阵 View。长灯带只能恢复尾部——48 字通道 RAM 只保留帧的最后 46 位(与真实 C3 硬件一致) |
| 位绑定 I2C 从机(24C02 EEPROM、BME280) | ✅ M4 | 两个位绑定 GPIO(SCL/SDA)上的电平驱动协议引擎;经 SDA 输入路径应答(开漏惯用法);多个从机可共享一条总线(线与仲裁);BME280 补偿逐位精确镜像 |
| IR NEC 接收器 | ✅ M4 | 双路捕获固件码:位绑定 GPIO(细批边沿采样)或 RMT TX 通道(通道 RAM);按比值解码(客户时钟不按墙钟走);支持重复帧 |
| 硬件 I2C/SPI 设备、显示屏、ADC、真触摸、I2S、SD | ⏸ M5 | 等 esp-emulator 上游暴露 API |

注:触摸**外设**未被模拟——触摸按键以 GPIO 输入呈现,固件按 GPIO 读取即可
(`tests/firmware/peris_probe` 有示例:GPIO3 输入 + 下降沿 ISR)。

## 添加一个新外设

1. 在 `peris/devices/` 放一个模块,导出 `Device` 与 `View`(接口见
   docs/DEVICE-API.zh-cn.md);
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
# 生成 merged image(加载用;-o 相对 build 目录!)
powershell -ExecutionPolicy Bypass -NoProfile -File tests\firmware\merge.ps1
#    tests/firmware/peris_probe/build/merged-binary.bin
```

```bash
npm test                     # 单元测试 + 集成冒烟(见 docs/ARCHITECTURE.zh-cn.md 测试分层)
npm run test:m0              # 模拟器能力探针(上游升级时先跑)
```

固件五阶段循环:GPIO8 闪烁 / 数字输入采样(`###P1b`:GPIO0 拨动开关电平、
GPIO18 触摸板、GPIO3 按键电平,每 125 ms 一行,LED 镜像开关,触摸沿计数)/
GPIO9+GPIO6+GPIO7 上 LEDC 呼吸(ch0 渐变、ch1 反向、ch2 恒半占空比)/
GPIO4 RMT-WS2812 发帧 / SCL=GPIO1+SDA=GPIO2 上 ~20 kHz soft-I2C 主机
(24C02 + BME280 事务,BME 补偿逐位交叉验证)加 GPIO5 位绑定与 GPIO10
RMT ch1 两路 NEC 红外码——并配合 GPIO3 输入中断计数,用于端到端验证。
加载合并镜像后导入 `examples/esp32c3-probe.json`(按上述引脚接线全部 11
个设备),每个阶段都会驱动到对应外设。

注:页面自身不依赖任何 CDN——xterm/xterm-addon-fit 已本地化到
`peris/vendor/`(取自 npm 包的非压缩构建),离线可用。
