# workbuddy-wallpaper-engine

把本机 **Wallpaper Engine** 的壁纸变成 **WorkBuddy** 桌面的动态背景。

> WorkBuddy（腾讯 CodeBuddy 桌面端）里，你的壁纸会在整个界面**后面**播放：
> 视频直接播、网页壁纸以沙箱 iframe 加载、Scene 壁纸交给 **WebWallGL** 实时渲染，
> 配一套 iOS 液态玻璃观感的设置面板（模糊 / 暗度 / 边框 / 透明度 / 圆角 / 帧率）。
>
> **不修改 WorkBuddy 的任何官方文件**（不碰 `app.asar`，不写注册表自启，不改快捷方式）。

---

## 它长什么样

- 右下角一个 🎨 悬浮按钮 → 打开设置面板
- 面板里：暂停 / 隐藏 / 静音、外观滑块、液态玻璃预设、轮播间隔、内容分级、类型过滤、缩略图网格
- 所有设置实时生效并记忆；选中的壁纸跨重启保留

---

## 工作原理（一句话版）

```
Node CLI  --(Chrome DevTools Protocol)-->  WorkBuddy 渲染进程
   │                                            │
   │ 只读盘点 WE 库、只传 file:// 路径            │ 注入脚本建出壁纸层
   │ 不传任何字节（素材可达 621MB）               │ <video> / WebWallGL canvas / iframe
   ▼                                            ▼
Steam\steamapps\workshop\content\431960     body 下的 position:fixed; z-index:-1 图层
```

三个关键设计（都是被真实问题逼出来的）：

1. **只传路径，不传字节。** WorkBuddy 的渲染进程本身就是 `file://` 页面，
   可以直接 `<video src="file:///…">`、`fetch(file://…)`。所以零拷贝、零存储占用，
   几十上百 MB 的素材也能秒切。这条是硬约束：`localStorage` 配额只有几 MB。
2. **壁纸层用负 `z-index`。** WorkBuddy 的 `#root` 自带层叠上下文，
   负 z-index 的图层天然落在它之下，且换壁纸时怎么 `appendChild` 都不会打乱层级。
3. **常驻守护用事件而不是轮询。** `Target.setAutoAttach` + `waitForDebuggerOnStart`
   让新窗口"出生即暂停"，我们在文档创建前就把壁纸脚本塞进去 ——
   所以独立设置窗口一打开就带着壁纸，不会先闪一下白底。

---

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 | 路径发现与进程检测是 Windows 优先；其它平台会优雅降级 |
| Node.js | **≥ 22** | 需要内置的全局 `WebSocket`（CDP 客户端零依赖靠它） |
| WorkBuddy | 5.7.x 实测 | 更早版本可能可用，但 DOM 选择器是按 5.7.6 校准的 |
| Wallpaper Engine | 可选 | 没装也能跑，只是面板里没有壁纸可选 |

Node 不需要单独安装：WorkBuddy 自带一个（实测 22.22.2），安装脚本会自动找到它。

---

## 安装

```powershell
git clone https://github.com/liujihui47-droid/workbuddy-wallpaper-engine.git
cd workbuddy-wallpaper-engine

# 自检 + 生成便捷启动入口
powershell -ExecutionPolicy Bypass -File scripts/install.ps1

# 可选：开机自启（用我们自己的 Run 值名，不会和 WorkBuddy 打架）
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Autostart
```

**零 npm 依赖** —— 不需要 `npm install`。

### 卸载

```powershell
# 从界面上移除壁纸（回到原生外观）
node src/cli.mjs remove

# 移除快捷入口 + 自启项
powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Uninstall
```

---

## 用法

### 第一次用

```powershell
# 1. 如果 WorkBuddy 正在运行，先从托盘图标右键退出
#    （WorkBuddy 有进程保护，本工具无法结束它 —— 这是它的设计，不是 bug）

# 2. 带调试端口启动并自动注入
node src/cli.mjs launch
```

`launch` 会自己挑一条可渲染的壁纸装上，然后起守护进程。
之后在 WorkBuddy 右下角点 🎨 换壁纸、拖滑块即可。

### 常用命令

| 命令 | 作用 |
|---|---|
| `node src/cli.mjs launch` | 启动 WorkBuddy（带调试端口）+ 注入 + 起守护 |
| `node src/cli.mjs apply` | 只管注入（WorkBuddy 必须已经带端口在跑） |
| `node src/cli.mjs remove` | 卸载注入，回到原生外观 |
| `node src/cli.mjs status` | 看进程 / 端口 / target / 当前壁纸 |
| `node src/cli.mjs guard` | 单独起常驻守护（让新窗口也带壁纸） |
| `node src/cli.mjs doctor` | 环境自检（找 exe / 端口 / WE 库 / RePKG / WebWallGL） |
| `node src/cli.mjs we list` | 命令行盘点本机 WE 壁纸库 |
| `node src/cli.mjs we extract` | 用内置 RePKG 解出 scene 的高清贴图（可选，慢） |

通用选项：`--port N`、`--exe <路径>`、`--prefer cn|intl`、`--json`、`--help`。

### 环境变量

| 变量 | 作用 |
|---|---|
| `WORKBUDDY_EXE` | 直接指定 WorkBuddy 主程序（换盘 / 绿色版 / 多版本并存） |
| `WBWE_STATE_DIR` | 状态目录（默认 `%LOCALAPPDATA%\WorkBuddyWallpaperEngine`） |
| `WBWE_REPKG` | 指定别的 RePKG |

---

## 可调项

面板上的滑块会实时写进渲染进程。分三组：

**外观** — 压暗 `scrim`、背景模糊 `blurPx`、背景透明度 `opacity`、
暗角 `vignette`、饱和度 `saturation`、亮度 `brightness`

**液态玻璃** — 玻璃模糊 `glassBlurPx`、玻璃透明度 `glassAlpha`、
玻璃描边 `glassBorder`、高光 `glassSpecular`、圆角 `cornerPx`
（另有 6 套一键预设：霜面 / 通透 / 浓郁 / 夜色 / 易读 / 默认）

**播放** — 渲染帧率 `fps`、音量 `volume`
（另有：暂停 / 隐藏 / 静音、轮播间隔 0–60 分钟、内容分级、类型过滤）

默认值都在 [`src/constants.mjs`](src/constants.mjs) 里，是唯一的真源。

---

## 支持哪些壁纸

| 类型 | 怎么渲染 | 覆盖率（开发机 71 条的实测） |
|---|---|---|
| `video` | `<video loop muted playsinline>` 直接播放 | 9 条，**100% 带动效** |
| `scene` | **WebWallGL 实时渲染**（首选）→ 解出的 4K 静态贴图 → 工坊预览图 → 取色渐变 | 55 条 |
| `web` | 沙箱 iframe 加载 `files/index.html` | 4 条 |
| `application` | **不渲染**（会启动外部程序，有意排除） | 列出但标灰 |
| `preset` | 跳过（那是参数覆盖层，不是独立壁纸） | 不在列表里 |

Scene 壁纸是重点也是难点：素材锁在 `scene.pkg` 里（WE 自己的容器格式）。
本项目用随仓库分发的 **WebWallGL** 在渲染进程里直接解析并跑 WebGL 渲染，
拿不到实时渲染时自动降级到静态图，**任何一步失败都不会留下黑屏**。

---

## 项目结构

```
src/
  cli.mjs              命令行入口与子命令分发
  launch.mjs           启动 WorkBuddy（带调试端口）+ 注入 + 起守护
  guard.mjs            常驻守护：Target.setAutoAttach，让新窗口也带壁纸
  cdp-client.mjs       极简 CDP 客户端（零依赖，用 Node 内置 WebSocket）
  injector.mjs         注入载荷装配（数据 / 文本 / 连接 三层分离）
  inject/
    wallpaper-engine.js   ★ 注入到渲染进程的壁纸引擎（单文件、非模块）
  we-library.mjs       Wallpaper Engine 库盘点（Steam 发现 / project.json / 分类）
  we-extract.mjs       scene.pkg 解包与主贴图挑选（用内置 RePKG）
  platform/workbuddy.mjs  WorkBuddy 安装位置与运行时解析
  state.mjs            状态读写、迁移、状态目录可写性探测
  constants.mjs        常量与可调项的唯一真源
  util.mjs             共享小工具（含百分号编码与 GBK 文件名修复）
vendor/webwallgl/      WebWallGL 1.4.2（vendored，MIT，见 .upstream.json）
tools/repkg/           RePKG 0.4.0（NativeAOT 单文件，无需 .NET）
scripts/               install.ps1 / lint-inject.mjs / make-preview.mjs / 真机探针
test/                  8 个测试套件（~160 条断言），见下
docs/                  PITFALLS.md（踩坑记录）/ WORKBUDDY-DOM.md / ARCHITECTURE.md
```

---

## 测试

```powershell
node test/run-all.mjs
```

| 套件 | 验什么 |
|---|---|
| `verify-units` | 工具的纯逻辑：百分号编码、大小写去重、GBK 解码、状态迁移、端口推断 |
| `verify-we-library` | WE 库盘点（**临时 fixture**，不依赖本机装没装 WE） |
| `verify-extract` | 图片头解析与 scene 主贴图挑选 |
| `lint-inject` | 注入脚本静态体检（禁 import/export/反引号、语法、关键能力存在性） |
| `verify-inject-data` | 注入载荷装配（含"二次规整把 URL 清空"的回归） |
| `verify-inject-runtime` | **在 Node 里用最小 DOM 替身真的跑一遍注入脚本** |
| `verify-cdp-client` | CDP 客户端（起**真实** HTTP + 迷你 WebSocket 服务器） |
| `verify-guard` | 守护逻辑：**证明 `runIfWaitingForDebugger` 一定会被调用**（漏了会白屏） |

### 看一眼效果（不用启动 WorkBuddy）

```powershell
node scripts/make-preview.mjs          # 内置示例数据
node scripts/make-preview.mjs --local  # 用你本机的真实壁纸库
# 然后浏览器打开 preview/wallpaper-preview.html
```

---

## 已知限制

1. **WorkBuddy 已在运行时无法接管。** 它带图灵盾保护，`taskkill /F`、
   `Stop-Process`、CIM Terminate 全被拒，`ExecutablePath` 也读不出来。
   必须先从托盘退出，再用 `launch` 启动。这是它的设计，不是本项目的缺陷。
2. **自动更新会吃掉调试端口。** WorkBuddy 更新时用更新器重启进程，
   原始命令行参数不被继承 → `--remote-debugging-port` 消失。重新跑 `launch` 即可。
3. **Scene 壁纸的实时渲染依赖 WebWallGL 1.4.2。** 有意锁这个版本：
   2.0.2 连续创建/销毁渲染实例会泄漏（实测第 7 个实例起全部挂死）。
4. **材质版权归创意工坊作者。** 本项目**只在本机引用路径，不复制、不打包、不入库**，
   面板上也标注了"仅本机、不可分享"。请勿把壁纸素材提交进仓库。
5. **只处理"能当背景"的类型。** `application` 壁纸会启动外部程序，有意不渲染。

---

## 授权与致谢

本项目 **MIT**。

它站在别人的肩膀上，具体来源与改动都记在 [LICENSE](LICENSE) 与
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 里：

- **[dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine)**（elysia395，MIT）
  —— 功能设计与大量实现细节的来源（WE 库发现、scene 处理、液态玻璃配方、
  以及一份非常有价值的实测坑表）。本项目的可调项体系与降级链直接沿用它。
- **[anonbuddy-skin](https://github.com/2939332182/anonbuddy-skin)**（MIT）
  —— WorkBuddy 的 **CDP 注入机制**（端口约定、`file://` 直读、守护用
  `Target.setAutoAttach`、以及"注入脚本禁反引号"等硬约束）来自这里。
- **[WebWallGL](https://github.com/oneincase/webwallgl)**（oneincase，MIT）
  —— scene 壁纸的实时 WebGL 渲染引擎，vendored 在 `vendor/webwallgl/`。
- **[RePKG](https://github.com/notscuffed/repkg)**（NotScuffed，MIT）
  —— Wallpaper Engine PKG/TEX 解包，随仓库分发（NativeAOT，无需 .NET）。

Wallpaper Engine 本身与创意工坊素材的版权归各自作者，本项目不包含任何素材。
WorkBuddy / CodeBuddy 是腾讯的产品，本项目与腾讯无隶属关系。
