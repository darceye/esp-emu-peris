[English](DEVICE-API.md) | **简体中文**

# esp-emu-peris 外设接口规范(v1)

一个外设 = `peris/devices/` 下的一个 ES 模块 + `manifest.json` 里的一行。除此之外不需要改动项目任何其它文件。

> **语言**:插件用**原生 JavaScript**(丢文件即用,无需构建)。框架是 TypeScript 编译
> 产物,完整契约类型在 `peris/core/types.d.ts`(`DeviceMeta`/`DeviceLike`/`DeviceCtx`/
> `PinState` 等),插件里可通过 JSDoc 引用获得编辑器提示。注册表加载时会**运行时校验**
> 元数据(缺 `typeId`/`title`/`pins()`/`defaultConfig` 立即报错),单元测试
> `tests/unit/devices.test.mjs` 是插件电气语义的范例。

## 模块导出

```js
export class Device {          // 运行在 worker,与模拟器交互
    static typeId      = 'led';       // 唯一、稳定、kebab-case
    static version     = '1.0.0';     // 插件自身版本(行头展示,登记于 docs/CHANGELOG.zh-cn.md)
    static title       = 'LED';       // UI 显示名
    static category    = 'basic';     // Add 菜单分组
    static description = '...';       // 一行说明(tooltip)
    static defaultConfig = {...};     // 新建实例的默认配置
    static configSchema = [           // 通用配置编辑器字段(展开详情内,一条一行)
        { key: 'pin',    label: 'GPIO pin', type: 'pin' },
        { key: 'color',  label: 'Colour',   type: 'color' },
        { key: 'name',   label: 'Label',    type: 'text' },
        // type 还支持: number(min/max/step)、select(options:[{value,label}])、checkbox
        // checkbox 可加 chip:'pull' + pullWhenChecked:'high'|'low'
        //   → 设备行上显示 V/G 闲置电平徽章(点击翻转),详见下文"行式 UI 约定"
    ];
    static sharedBus = true;          // 可选(M4):允许与其他 sharedBus 设备
                                      //   共享引脚(总线接线,如两个 I2C 从机)
    static pins(cfg) { return [cfg.pin]; }   // 声明占用的 GPIO(用于冲突检测)

    constructor(ctx, cfg) {}          // cfg = { id, type, ...设备配置 }
    onPinState(pin, s) {}             // 引脚输出变化回调 s={out, oe, cycles}
    onBatch() {}                      // 每个 run_batch 后的节拍(MMIO 轮询,
                                      //   寄存器级设备专用,见下文)
    onCommand(cmd, params) {}         // 页面 View 发来的用户操作
    onEmuReady() {}                   // 模拟器(重)加载后:重新驱动输入电平/
                                      //   复位缓存的寄存器状态
    getState() { return {...}; }      // 可序列化状态,推给页面 View(~30fps)
    destroy() {}                      // 释放/恢复引脚
}

export class View {             // 运行在页面,渲染设备视图
    constructor(el, sendCmd, host) {}  // el=详情区主体容器; sendCmd(cmd, params);
                                       // host.updateConfig(patch) 请求改本设备配置;
                                       // host.pinInfo?() → { valid, used } 供多引脚选择器
    rowIcon(el) {}               // 可选:行内交互图标(el≈24px 容器),见下文
    render(state) {}             // state 来自 Device.getState();行图标与详情主体一起驱动
    setConfig(cfg) {}            // 可选:配置编辑后回调(如换 LED 颜色)
    destroy() {}                 // 可选:行被移除/列表重建时回调——持有行外 DOM
                                       //   (浮动窗口)的 View 必须在此清理
}
```

## 行式 UI 约定(0.3.0+)

外设面板是三栏布局中的独立一栏(控制台 | 外设 | Debug),每种外设占一行:

```
[交互图标] [名称] [GPIO号] [V/G]                [▸展开] [×删除] [⠿拖动]
```

- **交互图标**(`View.rowIcon(el)`):可点击的迷你控件,操作语义由插件定义——
  LED 点击换色(取色器,经 `host.updateConfig({color})` 写回配置)、按键按下/
  松开(连发 press/release)、拨动开关点击 toggle。`render(state)` 里同步刷新
  图标状态(亮灭/按下/ON)。不实现 rowIcon 时显示首字母占位块。
  **调用顺序**:面板固定先 `rowIcon` 后 `setConfig`,配置式样可覆盖到图标;
  图标与详情主体是同一状态的两个视觉,插件必须共用同一 setter/render
  (参考 led.js 的 `setColour()`),禁止为图标单写一份样式逻辑。
- **名称 / GPIO 方框 / V·G 徽章**:由面板通用渲染,点击原地修改
  (名称与 GPIO 走内联编辑,V/G 徽章直接翻转)。GPIO 方框取 schema 第一个
  `type:'pin'` 字段;V/G 徽章取标记 `chip:'pull'` 的 checkbox——勾选时若
  `pullWhenChecked:'high'`(默认)显示 V(上拉到 VCC),否则 G;未勾选相反。
- **展开详情**:设备控件主体(`el`,即构造函数第一个参数)+ 全量配置编辑器
  (一条属性一行)。行内放不下的高级功能一律放详情。
- **拖动排序** ⠿:按下拖柄才启用拖拽,松手回写 devices 顺序(不重建 worker)。

## ctx(worker 侧设备上下文)

| 成员 | 说明 |
|---|---|
| `ctx.id` / `ctx.chip` / `ctx.gpioCount` | 设备 id、芯片型号、GPIO 数 |
| `ctx.mmio` | 当前芯片的寄存器地址表(LEDC/RMT/GPIO 矩阵);芯片暂无表时为 null——寄存器级设备此时必须闲置 |
| `ctx.setPinInput(pin, high)` | 驱动引脚输入电平(固件可读到、可触发 GPIO 中断) |
| `ctx.subscribe(pins)` / `ctx.unsubscribe()` | 订阅引脚输出变化(onPinState) |
| `ctx.readMem(addr, len)` / `ctx.readU32(addr)` | 总线/MMIO 读取(LEDC duty、RMT RAM 等) |
| `ctx.pinLevel(pin)` | 直接读 `gpio_state()` 的当前驱动电平——客机驱动引脚(oe)时为 true/false,释放时为 null。一次 wasm 读:快照要节制(逻辑分析仪仅在捕获起点采样),不要每批都读 |
| `ctx.cycles()` | 模拟器周期计数 |
| `ctx.cyclesPerUs` | 模拟器时钟(周期/µs),边沿计时换算真实时间用 |
| `ctx.armSampling(batch)` | M4 调度器:设备监视空闲总线期间的常设 run_batch 尺寸 |
| `ctx.fineSampling(batch, forCycles)` | M4 调度器:接下来 `forCycles` 周期内用细批(传输期间持续续约);CPU 睡眠快进时自动失效 |
| `ctx.releaseSampling()` | 释放本设备的调度器租约(destroy 时调用) |
| `ctx.markDirty()` | 请求尽快把 getState() 推给页面 |
| `ctx.log(text, level?)` | 在 UART 控制台打一条 `[Peris]` 日志 |

## 寄存器级设备(M2+)

经 **GPIO 矩阵路由的信号(LEDC、RMT)不会出现在 `onPinState`**(M0
Q2a/Q3a)——这类外设的设备改为轮询 MMIO:

- 实现 `onBatch()`(每个 `run_batch` 后、引脚采样之后调用):用
  `ctx.readU32` + `ctx.mmio` 地址读寄存器,仅在派生状态**真正变化**时
  `ctx.markDirty()`(ledc-lib 把占空比量化到 1/1000,次可见变化不推送);
- 在 `onEmuReady()` 里复位缓存的寄存器/接线状态——新模拟器实例全表读 0;
- 接线由固件侧路由决定时 `static pins(cfg)` 返回 `[]`(LEDC 设备不声明
  GPIO;两个设备盯同一通道只是镜像显示)。

M2 插件把所有共享语义集中在 **`peris/devices/ledc-lib.js`**(通道值解析、
`GPIO_FUNCn_OUT_SEL_CFG` 接线扫描、DUTY_R/定时器 DUTY_RES 占空比解码、
canvas 灯泡绘制 + 电平动画器):这类辅助模块放在 `peris/devices/` 下但
**不进 manifest**(只有 manifest 列出的模块才作为设备加载),由插件与
单元测试以相对路径引用——禁止另起一份占空比解码或接线扫描。

辅助函数已处理好的两个坑:通用编辑器的 `<select>` 回传**字符串**
(`parseChannel` 接受 `'3'`,并防住 `Number(null)===0`);`idf.py merge-bin`
的 `-o` 相对 build 目录(`tests/firmware/merge.ps1`)。

M3 的 WS2812 插件遵循同一模式,共享库为 **`peris/devices/ws2812-lib.js`**
(RMT 通道 RAM 读取、`CHnSTATUS` 发送忙门控、接线扫描、复位重同步+前置补零
对齐的帧解码、LED 网格几何/绘制;通道解析与动画器直接从 ledc-lib 引入——
同一语义只有一份实现)。其实测约束已在 UI 呈现:48 字通道 RAM 只保留帧的
最后 46 位,长灯带只能解码出尾部 LED(见 FEASIBILITY.zh-cn.md
"关键技术细节" 3–4)。

## 仪器类设备(0.10.0)

- `peris/devices/logic-analyzer.js` —— 多通道 GPIO 波形捕获(最多 8 个引
  脚,一个触发:通道 + 上升/下降/任意沿或"立即",客机时间窗口,自动重新
  武装)。读数数学、波形绘制器与浮动窗口都在 `peris/devices/la-lib.js`;
  绘制器只有一份实现,弹窗、详情迷你预览与行图标共用。采样复用 M4 调度
  器,与位绑定设备一致(等触发时持 arm 租约,录制期间每次边沿续租细批
  ——`resolution` 配置决定细批:20/100/300 条指令)。电平为驱动 1/0、
  客机释放引脚时 -1(Z);分析仪从不驱动任何东西,因此声明 `sharedBus`,
  合法搭接其他总线设备占用的引脚。捕获数据仅在缓冲冻结(`done`)时全量
  推送;运行中的推送只带进度 + 各通道实时边沿计数。
- **浮动窗口**(`la-lib.makeFloatingWindow`):大界面以可拖动、可调大小、
  **非模态**弹窗打开——`position: fixed`、无遮罩,下层页面的一切指针事件
  照常。几何位置钳制在视口内并持久化到 localStorage。此类窗口挂在
  `document.body`(不在设备行内),其 View 必须实现 `destroy()` 在行销毁
  时移除——面板在行移除与列表重建时都会调用 `destroy()`。View 内的多引
  脚选择器通过 `host.pinInfo()` 将被占用 GPIO 置灰(与通用编辑器同一份、
  按候选设备感知的引脚集合)。
- **Saleae 风格绘图模型**(同在 `la-lib`):可缩放视图 `{t0, spanUs}` 配
  `viewXform`/`clampView`/`zoomAt`(滚轮以光标为锚点缩放、拖拽平移、双击
  复位适配),悬停测量(`pulseAround` 找光标所在脉冲,`pwmOf` 按相邻上升
  沿算周期/频率/占空比),A/B 游标读 Δt 与 1/Δt,边沿跳转(`levelAt`、
  `fmtHz`)。设备在每次捕获开始时递增 `capId`,View 据此在新数据到来时
  重置缩放与游标。

## 消息协议(页面 ↔ worker)

在原版 worker 协议之外增加(见 `peris/protocol.js`):

- 页面→worker:`peris_config {config}`(全量应用配置)、`peris_command {id, cmd, params}`
- worker→页面:`peris_ready {ok, errors, devices}`、`peris_state {id, state}`、`peris_log {level, text}`

## 配置文件

```json
{
  "perisVersion": 1,
  "chip": "esp32c3",
  "firmware": { "name": "merged-binary.bin", "size": 250048 },
  "devices": [ { "id": "led-1", "type": "led", "pin": 8, "color": "#ff4d4d", "name": "Red" } ]
}
```

- 自动保存于 localStorage(`peris.config.v1`,含 `chip`,页面加载时自动选中
  对应芯片);面板头部的保存/打开图标导出/导入 `.json`。
- **导出文件名**:面板头部输入框设置(即项目名;留空 = 自动名
  `peris-{chip}-{date}.json`),记忆于 localStorage;命名逻辑见
  `peris-panel.ts exportFileName()`。
- **`firmware` 为备忘字段**:导出时记录最近加载固件的文件名/大小(/磁盘路径,
  仅当宿主环境暴露非标准 `File.path` 时存在——浏览器安全模型不提供全路径)。
  导入时忽略,不会自动加载固件;`chip` 在 localStorage 自动保存/恢复时会
  选中对应芯片,Import 导入的 JSON 中则为备忘(不改当前选择)。
- v1 规则:每个 GPIO 同时只能被一个设备占用(任意方向);冲突会在面板顶部黄条提示。

## 设备开发注意事项(源自 M0 实测,见 FEASIBILITY.zh-cn.md)

1. **引脚输出**:固件主动 GPIO 输出在 `onPinState` 可见(out+oe);**LEDC/RMT 走 GPIO matrix 的信号不出现在引脚寄存器**,必须改在 `onBatch()` 里读 MMIO(LEDC duty 寄存器、RMT 通道 RAM);地址表经 `ctx.mmio` 提供(源码在 `src/core/mmio/`)。
2. **引脚输入**:`ctx.setPinInput` 会真实进入固件(读值+中断),按键类设备在 `onEmuReady` 里要重新驱动电平(模拟器重载后电平复位)。
3. **时间**:`vTaskDelay` 期间模拟器时间快进,不要试图在 CPU 睡眠窗口做引脚级波形捕获;CPU 活跃的位绑定波形可在 run_batch 批间采样,但请节制(细批约 99 MIPS,粗批 5000+ MIPS)。
4. 状态推送节流 ~30fps;`getState()` 返回的对象会 postMessage,保持小而可序列化。
5. View 中触发**设备动作**统一走 `sendCmd(cmd, params)`;**修改配置**(如行内换色)
   走 `host.updateConfig(patch)`——配置的唯一事实源在页面 PerisPanel,worker 侧
   不得缓存/改配置。不要在页面侧直接操作模拟器。

## 位绑定协议设备(M4)

CPU 驱动(位绑定)的波形**可以**出现在 `onPinState` 里——但
`gpio_state()` 每个 run_batch 只采样一次,只有当批量远小于信号半周期时
边沿才能全部存活。设备通过调度器(`src/core/scheduler.ts`)租用批量:

- `ctx.armSampling(~1000)` 申请一次——总线空闲期间的常设警戒批(开销低,
  足以分辨 ~20 kHz 总线上的 START);
- 每个边沿到来时 `ctx.fineSampling(~300, forCycles)`——为传输的剩余部分
  续约细批窗口;按周期预算到期,或模拟器快进穿越 CPU 睡眠时自动失效
  (那时无可采样)。

客户机内部的时序**不**按墙钟走(`esp_rom_delay_us` 只有名义值的 ~50%
——FEASIBILITY.md §"M4 实测"),因此解码器必须基于电平或比值,绝不能
用绝对微秒窗口。M4 插件同时遵循这两条:

- `peris/devices/bitbang-i2c-slave.js` —— 两个位绑定 GPIO(SCL/SDA)上的
  24C02 EEPROM / BME280 模型(`sharedBus` 允许多个从机共用这对线,
  runtime 对共享焊盘的输入驱动做线与)。引擎、寄存器模型与逐位精确的
  Bosch 补偿在 `peris/devices/i2c-lib.js`。从机经 SDA 输入路径应答——
  主机把焊盘释放为输入期间才可见(开漏惯用法);从不释放的推挽主机无法
  应答,不仿真时钟拉伸。
- `peris/devices/ir-nec.js` —— 双路 NEC 捕获:位绑定 GPIO(细批窗口内
  边沿→突发包络,静默 ~25 ms 后解码)或 RMT TX 通道(34 字的帧完整留在
  发送后的通道 RAM 里;模拟器不实现 `APB_MEM_WADDR`(恒 0),发送中途
  拼接不可行)。按比值解码;`source: auto` 优先 RMT 路由。包络组装与
  解码在 `peris/devices/nec-lib.js`。
- `peris/devices/max7219.js` —— 位绑定 DIN/CLK/LOAD 总线上的 MAX7219
  显示驱动(只写器件,无需输入路径)。移位引擎在 CLK 上升沿采样 DIN、
  LOAD 上升沿锁存 16 位字;失准帧被丢弃并计入 `dropped`,绝不出花屏。
  寄存器模型、Code B 字体与画图在 `peris/devices/max7219-lib.js`;菊花链
  共享焊盘(`sharedBus`,`chain`/`pos` 取各片的字)。租约取调度器下限
  (细批 20/警戒 60):按无延时背靠背 `gpio_set_level` 脉冲实测标定(边沿
  相距约 20 条指令)——这是已知最紧的真实固件,带延时的位绑定余量更大。

## 示例

- `peris/devices/led.js` — 输出型设备(sigbus 订阅)
- `peris/devices/button.js` — 输入型设备(setPinInput + onEmuReady)
- `peris/devices/touch-button.js` — 继承 button 的 Device,换 View
- `peris/devices/toggle-switch.js` — 保持型输入设备
- `peris/devices/pwm-led.js` / `rgb-led.js` — 寄存器级设备
  (onBatch + ctx.mmio + ledc-lib 接线扫描/占空比解码,canvas 插值 View)
- `peris/devices/ws2812.js` — 基于 RMT 通道 RAM 的寄存器级设备
  (onBatch + ctx.mmio + ws2812-lib 帧解码,灯带/环形/矩阵 View)
- `peris/devices/bitbang-i2c-slave.js` — 位绑定 I2C 从机(i2c-lib.js 引擎)
- `peris/devices/ir-nec.js` — NEC 接收器,gpio + RMT 双路捕获(nec-lib.js)
- `peris/devices/max7219.js` — 位绑定三线总线上的 MAX7219 显示
  (max7219-lib.js 引擎、Code B 字体、矩阵/七段画图)
- `peris/devices/logic-analyzer.js` — 带浮动分析窗口的多 GPIO 波形捕获
  (la-lib.js 读数数学 + 绘制器 + 浮窗)
- `peris/devices/ledc-lib.js` — 共享辅助模块(不是设备)
- `peris/devices/ws2812-lib.js` — 共享辅助模块(不是设备)
- `peris/devices/i2c-lib.js` / `peris/devices/nec-lib.js` /
  `peris/devices/max7219-lib.js` / `peris/devices/la-lib.js` — 共享辅助
  模块(不是设备)
