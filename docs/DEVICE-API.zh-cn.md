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
    static pins(cfg) { return [cfg.pin]; }   // 声明占用的 GPIO(用于冲突检测)

    constructor(ctx, cfg) {}          // cfg = { id, type, ...设备配置 }
    onPinState(pin, s) {}             // 引脚输出变化回调 s={out, oe, cycles}
    onCommand(cmd, params) {}         // 页面 View 发来的用户操作
    onEmuReady() {}                   // 模拟器(重)加载后:重新驱动输入电平
    getState() { return {...}; }      // 可序列化状态,推给页面 View(~30fps)
    destroy() {}                      // 释放/恢复引脚
}

export class View {             // 运行在页面,渲染设备视图
    constructor(el, sendCmd, host) {}  // el=详情区主体容器; sendCmd(cmd, params);
                                       // host.updateConfig(patch) 请求改本设备配置
    rowIcon(el) {}               // 可选:行内交互图标(el≈24px 容器),见下文
    render(state) {}             // state 来自 Device.getState();行图标与详情主体一起驱动
    setConfig(cfg) {}            // 可选:配置编辑后回调(如换 LED 颜色)
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
| `ctx.setPinInput(pin, high)` | 驱动引脚输入电平(固件可读到、可触发 GPIO 中断) |
| `ctx.subscribe(pins)` / `ctx.unsubscribe()` | 订阅引脚输出变化(onPinState) |
| `ctx.readMem(addr, len)` / `ctx.readU32(addr)` | 总线/MMIO 读取(LEDC duty、RMT RAM 等) |
| `ctx.cycles()` | 模拟器周期计数 |
| `ctx.markDirty()` | 请求尽快把 getState() 推给页面 |
| `ctx.log(text, level?)` | 在 UART 控制台打一条 `[Peris]` 日志 |

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

1. **引脚输出**:固件主动 GPIO 输出在 `onPinState` 可见(out+oe);**LEDC/RMT 走 GPIO matrix 的信号不出现在引脚寄存器**,必须读 MMIO(LEDC duty 寄存器、RMT 通道 RAM),地址表在 `peris/mmio/`。
2. **引脚输入**:`ctx.setPinInput` 会真实进入固件(读值+中断),按键类设备在 `onEmuReady` 里要重新驱动电平(模拟器重载后电平复位)。
3. **时间**:`vTaskDelay` 期间模拟器时间快进,不要试图在 CPU 睡眠窗口做引脚级波形捕获;CPU 活跃的位绑定波形可在 run_batch 批间采样,但请节制(细批约 99 MIPS,粗批 5000+ MIPS)。
4. 状态推送节流 ~30fps;`getState()` 返回的对象会 postMessage,保持小而可序列化。
5. View 中触发**设备动作**统一走 `sendCmd(cmd, params)`;**修改配置**(如行内换色)
   走 `host.updateConfig(patch)`——配置的唯一事实源在页面 PerisPanel,worker 侧
   不得缓存/改配置。不要在页面侧直接操作模拟器。

## 示例

- `peris/devices/led.js` — 输出型设备(sigbus 订阅)
- `peris/devices/button.js` — 输入型设备(setPinInput + onEmuReady)
- `peris/devices/touch-button.js` — 继承 button 的 Device,换 View
- `peris/devices/toggle-switch.js` — 保持型输入设备
