# bt-anim 蓝牙动画悬浮层

**电脑连接上蓝牙设备（或扫描到新设备）时，在系统最顶层播放一段 Lottie 动画。**

动画文件是你提供的 `animation/data.json`（三角洲行动风格的 HUD 扫描特效），
程序把它做成一个「透明 + 置顶 + 鼠标穿透」的悬浮层：平时完全看不见，一旦有蓝牙事件就在所有窗口之上播放一次，播完自动消失。

---

## 快速开始

在项目目录里直接运行（推荐先看 [首次运行](#首次运行会下载-electron)）：

```bash
# 立刻验证效果：启动并播放一次
npx . --test

# 播放一次后自动退出（适合快速检查）
npx . --once --test

# 后台常驻监听（关掉终端也继续跑）
npx . --detach

# 查看状态 / 手动触发 / 退出
npx . status
npx . trigger
npx . stop
```

> 发布到 npm 之后，把 `npx .` 换成 `npx bt-anim-overlay` 即可。
> 也可以 `npm start -- --test` 或 `npm link` 后使用 `bt-anim` 命令。

### 首次运行会下载 Electron

悬浮层需要 Electron 运行时（约 100MB）。首次启动时会自动下载，
如果直连 GitHub 很慢或失败，程序会自动改用国内镜像重试：

```bash
# 也可以手动指定镜像后再启动
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npx . --test
```

查看环境是否就绪：`npx . doctor`

---

## 什么情况会播放动画

| 事件 | 说明 | 默认 |
| --- | --- | --- |
| `connected` | 有蓝牙设备连上了电脑（耳机、手柄、键鼠、手机…） | ✅ 开 |
| `paired` | 系统里出现了新配对的设备 | ✅ 开 |
| `discovered` | 附近扫描到从没见过的新设备（智能家居、别人的耳机…） | ✅ 开 |
| `disconnected` | 设备断开 | ❌ 关 |

用 `--only connected,paired` 只保留想要的事件。
几秒内同时发生多个事件（比如手机同时连了经典蓝牙 + BLE）会自动合并成**一次**播放，并按设备名去重。

**开机后的第一次扫描不会触发动画**（只把当时看到的设备记成基线），
之后出现的新设备才会触发；记忆保存在状态目录里，重启程序依然有效。

---

## 常用参数

| 参数 | 说明 |
| --- | --- |
| `--test` | 启动后立刻播放一次（验证用） |
| `--once` | 播放一次后自动退出 |
| `--detach` | 后台运行 |
| `--restart` | 先结束已有实例再启动 |
| `--only <类型>` | 只响应指定事件：`connected,disconnected,paired,discovered,all` |
| `--no-scan` | 关闭「扫描到新设备」检测 |
| `--scan-interval <秒>` | 扫描间隔，默认 90 秒（0 表示关闭） |
| `--scan-mode <模式>` | 扫描类型：`le`(默认) / `classic` / `both` |
| `--poll <毫秒>` | 连接状态轮询间隔，默认 1200 |
| `--cooldown <毫秒>` | 两次播放的最小间隔，默认 4000 |
| `--from <帧>` `--to <帧>` | 只播放动画的某一段（默认从头到尾） |
| `--speed <倍速>` | 播放速度，默认 1 |
| `--counter` | 把画面上的数字改成本次事件的设备数量 |
| `--text-mode bt` | 把画面文案换成蓝牙版（附近蓝牙设备 / 新设备信号数） |
| `--caption` | 在动画下方显示设备名 |
| `--font <字体>` | 指定画面文字使用的中文字体（默认跟随系统） |
| `--backdrop <0-0.9>` | 动画背后压一层暗色遮罩，半透明 HUD 在明亮桌面上更清楚 |
| `--boost <倍数>` | 画面亮度增强（例如 `--boost 1.6`） |
| `--display <目标>` | 显示在哪个屏幕：`primary`(默认) / `all` / 序号 `1,2` |
| `--fit <方式>` | 画面适配：`cover`(默认，铺满) / `contain` / `stretch` |
| `--opacity <0-1>` | 悬浮层整体不透明度 |
| `--no-tray` | 不创建托盘图标 |
| `--port <端口>` | 本地控制接口端口，默认 17892 |
| `--animation <目录>` | 使用自己的 Lottie 动画目录 |
| `--config <文件>` | 指定配置文件 |
| `--verbose` / `--quiet` | 日志详细程度 |

完整列表：`npx . help`

### 命令

```
start(默认)  启动悬浮层并监听蓝牙
trigger      立刻播放一次（测试）
scan         立刻扫描一次附近设备
status       查看状态（设备、扫描、播放记录）
pause/resume 暂停 / 恢复触发
stop         退出正在运行的实例
capture      把悬浮层当前画面截成 PNG（排查显示问题用）
doctor       环境自检
```

---

## 配置文件

在项目目录放一个 `bt-anim.config.json`（或用 `--config` 指定），
或者在状态目录放 `config.json`（Windows：`%LOCALAPPDATA%\bt-anim-overlay`）。
命令行参数优先级最高。

```json
{
  "triggers": { "connected": true, "disconnected": false, "paired": true, "discovered": true },
  "cooldownMs": 4000,
  "batchWindowMs": 900,
  "scan": { "enabled": true, "intervalMs": 90000, "mode": "le" },
  "animation": { "speed": 1, "counter": true, "textMode": "bt", "caption": true },
  "window": { "fit": "cover", "backdrop": 0.35, "boost": 1.3, "display": "primary" }
}
```

---

## 它怎么检测蓝牙

全部使用系统自带能力，不需要安装驱动或原生模块：

| 场景 | 手段 |
| --- | --- |
| 设备连上 / 断开 | 轮询 `pnputil /enum-devices /class Bluetooth`，对比 `BTHENUM\Dev_*` / `BTHLE\Dev_*` 设备列表（约 100ms 一次，很轻） |
| 设备名称 | 读注册表 `BTHPORT\Parameters\Devices`（UTF-8 字节，中文名不会乱码） |
| 新配对 | 监听同一注册表里新增的设备项 |
| 扫描到新设备 | 用 WinRT `BluetoothLEDevice.FindAllAsync(未配对选择器)` 真正发起一次系统扫描（约 30 秒），和 Windows 设置里「添加设备」看到的是同一批设备 |

macOS / Linux 也有基础实现（`system_profiler` / `bluetoothctl` 轮询），扫描功能仅 Windows 完整支持。

---

## 常见问题

**动画看不太清？**
这个动画本身是半透明的 HUD 特效（很多元素透明度只有 10%~30%），在明亮的桌面上会比较淡。
加上 `--backdrop 0.35 --boost 1.4` 会明显很多。想确认程序是否正常，用 `--test` 播放一次。

**游戏里看不到？**
独占全屏（Exclusive Fullscreen）会挡住所有置顶窗口，这是 Windows 的限制。
把游戏显示模式改成「**无边框窗口 / 窗口化全屏**」即可看到悬浮层。

**悬浮层会挡住我点鼠标吗？**
不会。窗口设置了鼠标穿透（click-through）并且不抢焦点，也不出现在任务栏。

**会影响蓝牙音质 / 耗电吗？**
连接监听几乎不耗资源；只有「扫描附近新设备」会周期性占用蓝牙射频（默认每 90 秒扫 30 秒）。
介意的话用 `--no-scan` 关掉，或把间隔调大：`--scan-interval 300`。

**怎么换动画？**
`--animation D:\my-lottie` 指向任意 Lottie 目录（含 `data.json` 与图片）。
先用 `npm run preview` 离线把动画渲染成 PNG 看看效果：

```bash
npm run preview -- --frames 0,200,600,1000,1400 --out .probe/frames
```

**状态目录里有什么？**
`%LOCALAPPDATA%\bt-anim-overlay`：`run.json`（运行中实例的端口与令牌）、
`known-devices.json`（扫描记忆）、`logs\bt-anim.log`（日志）、`capture.png`（`capture` 命令的输出）。

---

## 目录结构

```
animation/            你提供的 Lottie 动画（data.json + images/）
renderer/             悬浮层页面（lottie-web 播放）
src/main.js           Electron 主进程：悬浮窗、托盘、控制接口
src/sensors/          蓝牙传感器（win32 / darwin / linux + PowerShell 脚本）
src/trigger-engine.js 事件聚合、去重、冷却
src/control-server.js 本地 HTTP 控制接口（仅 127.0.0.1）
bin/bt-anim.js        命令行入口（npx 运行的就是它）
tools/                辅助工具：生成图标、离线渲染预览
test/                 单元测试 + 传感器集成测试
```

## 开发

```bash
npm test               # 单元测试 + 传感器集成测试
npm run doctor         # 环境自检
npm run preview -- --frames 600 --out .probe/frames   # 离线渲染动画帧
npm run icons          # 重新生成托盘 / 应用图标
```

## 许可

MIT。动画素材版权归原作者所有。
#   D e l t a F o r c e B l u e t o o t h D e t e c t e d  
 