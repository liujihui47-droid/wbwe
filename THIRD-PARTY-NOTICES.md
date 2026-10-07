# 第三方组件与出处

本项目 MIT。以下是它包含或改编的第三方成果 —— 每一条都保留了原始授权与出处。

---

## 1. WebWallGL

| 项 | 值 |
|---|---|
| 上游 | https://github.com/oneincase/webwallgl |
| 作者 | oneincase |
| 版本 | **1.4.2** |
| 许可 | MIT |
| 分发形式 | **原样 vendored**，位于 `vendor/webwallgl/webwallgl-1.4.2.global.min.js` |
| 文件大小 | 952,624 字节 |
| SHA-256 | `2C0E652623016D36504C1DCE3309674334BB8ED899B34B4C351DC212C848D53B` |
| 元数据 | `vendor/webwallgl/.upstream.json` |

**用途**：解析 Wallpaper Engine 的 `scene.pkg` 并做实时 WebGL 渲染。

**为什么锁 1.4.2 而不是更新的 2.0.2**（来自上游 dsh-wallpaper-engine 的实测）：
2.0.2 连续创建 / 销毁渲染实例会泄漏，**第 7 个实例起全部挂死**
（34 个包只过 1 个）；1.4.2 是 34/34 全过。

**为什么 vendored 而不是运行时下载**：用户装完即可用，不引运行期外网依赖；
同时**不把 950KB 内联进注入脚本**（每次注入推 950KB 过 CDP 不可接受），
改由渲染进程按需 `<script src="file://…">` 加载本地副本。

**不许就地改** vendored 副本。

---

## 2. RePKG

| 项 | 值 |
|---|---|
| 上游 | https://github.com/notscuffed/repkg |
| 作者 | NotScuffed |
| 版本 | **0.4.0**（commit `e69a76dcdb461f5bdeba01a8a7fa5131a09bcefe`） |
| 许可 | MIT（含若干第三方库，见下） |
| 分发形式 | **原样分发**，位于 `tools/repkg/RePKG.exe`（3,901,440 字节） |
| 完整许可 | `tools/repkg/THIRD-PARTY-NOTICES.txt`（原样保留） |

**用途**：解包 `scene.pkg` 并把它内部的 `.tex` 贴图转成图片，
用来给 scene 壁纸提供**高清静态帧**（实测 3840×2160，比工坊缩略图 1024×1024
的像素量高 16 倍）。

**它是 NativeAOT 原生编译的单文件**，已实测**不需要系统安装 .NET**
（二进制里没有 `hostfxr` / `coreclr` / `clrjit` 任何标记，
把 `DOTNET_ROOT` 指向不存在的目录仍能正常运行）。

RePKG 自身包含的第三方库（许可全文见 `THIRD-PARTY-NOTICES.txt`）：

- CommandLineParser — MIT
- DXT Decompression code by Xalcon — 见原始 notice
- K4os.Compression.LZ4 by Milosz Krajewski — MIT
- Newtonsoft.Json — MIT
- ImageSharp — 见原始 notice（六家许可证条款）

---

## 3. dsh-wallpaper-engine

| 项 | 值 |
|---|---|
| 上游 | https://github.com/elysia395/dsh-wallpaper-engine |
| 作者 | elysia395 |
| 许可 | MIT（Copyright (c) 2026 elysia395） |
| 复用形式 | **功能设计与实现细节的移植/改编**（非逐字复制整文件） |

**复用了什么**：

- **Wallpaper Engine 库发现算法**：Steam 定位（注册表 `HKCU\Software\Valve\Steam`
  + 候选目录）、`libraryfolders.vdf` 解析、appid `431960`、
  `projects/{defaultprojects,myprojects}` 与 `steamapps/workshop/content/431960` 的枚举、
  按目录名作 id 去重。
- **类型判定与字段映射**：`scene` / `video` / `web` / `application` 的分类，
  `title` / `type` / `file` / `preview` / `contentrating` / `schemecolor` 的读取。
- **可调项体系**：压暗 / 模糊 / 边框 / 透明度 / 圆角 / 帧率 / 音量这批设置项及其语义。
- **液态玻璃配方**：`backdrop-filter: blur() saturate() brightness() contrast()` +
  `color-mix()` 釉色层 + 釉光/边框的三层叠加思路，
  以及 6 套出厂预设的取值方向（霜面 / 通透 / 浓郁 / 夜色 / 易读 / 默认）。
- **降级链**：WebWallGL 实时渲染 → 解出的静态贴图 → 工坊预览图 → 取色渐变。
- **注入脚本的硬约束**：注入脚本里**禁止反引号**（会静默截断整段脚本）、
  分片行尾必须规范化成 LF、Node 侧常量必须走 payload 而不能直接内联。
- **scene 的 WebWallGL 驱动方式**：`mount(container, { source: bytesSource(bytes, root, key),
  fps, volume, autoplay })`、`instance.destroy()/pause()/resume()/setVolume()` 的用法，
  以及"`mount` 只在首帧真正画出来之后才 resolve，所以必须有超时"和
  "超时兜底只能注册在 catch 分支里"这两条极隐蔽的坑。
- **实测坑表**：`docs/PITFALLS.md` 里标注 `[dsh]` 的条目大量来自该仓库的经验。

**注意**：本项目**没有**移植它的路由体系、设置 schema（1374 行）、
客户端 bundle 构建管线、字体集/头像/吉祥物/视差/光效等模块 ——
那些要么与 DSH 宿主强耦合，要么超出"壁纸引擎"的范围。

---

## 4. anonbuddy-skin

| 项 | 值 |
|---|---|
| 上游 | https://github.com/2939332182/anonbuddy-skin |
| 许可 | MIT |
| 复用形式 | **机制与实现细节的改编**（非逐字复制整文件） |

**复用了什么**（这是本项目能在 WorkBuddy 上跑起来的根本）：

- **CDP 注入的整体机制**：用 `--remote-debugging-port` 启动 WorkBuddy，
  通过 `/json/list` 找 `renderer/index.html` 那个 target，对每个 target 开一条
  短命 WebSocket 会话求值注入脚本。
- **端口约定**：国内版 `WorkBuddy.exe` → 9334，国际版 `WorkBuddyAI.exe` → 9333。
- **WorkBuddy 路径解析顺序**：显式参数 → `WORKBUDDY_EXE` → 常见安装位置 →
  注册表卸载项；以及"**不做**从运行进程反推 exe"（图灵盾保护，读不出路径）；
  还有 `workbuudy` 这个**真实存在过的历史目录拼写错误**。
- **`file://` 直读**：渲染进程本身是 `file://` 页面，所以可以零拷贝播放本机视频，
  不需要 HTTP 服务、不需要 data URL、不占 localStorage 配额。
- **守护用 `Target.setAutoAttach`**：`waitForDebuggerOnStart: true` 让新窗口出生即暂停；
  以及两条最关键的纪律 ——
  ① **每个会话都要注册一份首屏脚本**（自动附加与会话附加寿命不同），
  ② **无论注入成败都必须 `Runtime.runIfWaitingForDebugger`**（漏了就是永久白屏）。
- **`Page.addScriptToEvaluateOnNewDocument` 的时机陷阱**：脚本跑在"文档创建点"，
  `<head>`/`<body>` 都还不存在，必须等 `document.body`；而且只对**之后**创建的文档生效。
- **CSS 层的坑**：`body` 必须透明否则负 z-index 图层被整个盖住；
  在 `html` 上写自定义属性会触发全文档样式重算（实测 2269 元素 ≈ 23ms/次），
  所以每帧变化的量要写真实元素的内联 style。
- **媒体释放纪律**：切走时必须 `pause()` + `removeAttribute("src")` + `load()`，
  只把节点从 DOM 摘掉解码器可能还在跑。
- **WebWallGL 版本锁定结论**（见上文第 1 节）。

---

## 5. 其它致谢

- **PKG / TEX 容器格式**的公开知识来自 **RePKG** 与
  [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) 的交叉核对。
- **Valve KeyValues (VDF)** 的解析按公开格式自行实现（只取 `"path"` 字段）。
- **Wallpaper Engine** 与创意工坊素材的版权归 **Wallpaper Engine 作者与各素材作者**。
  本项目**不包含、不复制、不打包**任何壁纸素材：只在本机保存**路径引用**。
  面板上也明确标注了"仅本机、不可分享"。
- **WorkBuddy / CodeBuddy** 是腾讯的产品。本项目与腾讯无隶属关系，
  也未修改其任何官方文件。
