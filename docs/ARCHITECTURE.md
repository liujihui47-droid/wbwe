# 架构

## 一句话

一个**零 npm 依赖**的 Node 程序，通过 Chrome DevTools Protocol 把一段自包含的
壁纸引擎脚本注入 WorkBuddy 的渲染进程；素材始终以 `file://` 路径引用，从不搬运字节。

---

## 为什么是这样

四个约束决定了整个形状：

| 约束 | 后果 |
|---|---|
| WorkBuddy 的插件系统（`.codebuddy-plugin/plugin.json`）**只能贡献 agent 能力**（skill / MCP / connector），**不能画 UI** | 必须走注入，不能做成 WorkBuddy 插件 |
| WorkBuddy 的渲染进程跑在 `file://` 下 | 可以直接 `<video src="file:///…">`，于是**零拷贝**、不需要 HTTP 服务、不占 localStorage 配额 |
| `localStorage` 配额只有几 MB，WE 素材单体可达 621MB | **只传路径，绝不传字节**成为硬约束 |
| WorkBuddy 有进程保护（图灵盾），无法被结束、也读不出 exe 路径 | 已运行的实例**无法接管**；只能引导用户从托盘退出后由我们启动 |

顺带一个反例说明：WorkBuddy 自带官方换肤（`.teams-container` 上的 `background-image`），
那条路更"正规"，但只能做**静态图片**，承载不了 `<video>` 和 WebGL canvas ——
而 Video 与 Scene 实时渲染正是本项目的核心，所以没有采用。

---

## 分层

```
┌──────────────────────────────────────────────────────────────────┐
│ 宿主（Node，本仓库）                                              │
│                                                                  │
│  cli.mjs ──┬─ launch.mjs ──┬─ platform/workbuddy.mjs  找 exe/端口 │
│            │               ├─ cdp-client.mjs          CDP 客户端 │
│            │               └─ guard.mjs               常驻守护    │
│            ├─ injector.mjs ──┬─ we-library.mjs        WE 库盘点   │
│            │                 ├─ we-extract.mjs        scene 解包  │
│            │                 ├─ state.mjs             状态读写    │
│            │                 └─ inject/*.js ★         脚本文本    │
│            └─ doctor / we list / we extract                       │
└───────────────────────────────┬──────────────────────────────────┘
                                │ CDP: Runtime.evaluate
                                │      Page.addScriptToEvaluateOnNewDocument
                                │      Target.setAutoAttach
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ WorkBuddy 渲染进程（Chromium 138，file:// 页面）                  │
│                                                                  │
│  src/inject/wallpaper-engine.js（注入后执行）                     │
│   ├─ #wbwe-layer       position:fixed; inset:0; z-index:-1       │
│   │   ├─ <video>                     video 壁纸                   │
│   │   ├─ div[data-wbwe-scene]        WebWallGL canvas（scene）    │
│   │   ├─ <iframe sandbox>            web 壁纸                     │
│   │   ├─ div[data-wbwe-scrim]        压暗遮罩                     │
│   │   └─ div[data-wbwe-vignette]     暗角                        │
│   ├─ #wbwe-launcher    悬浮按钮（右下角）                         │
│   ├─ #wbwe-panel       液态玻璃设置面板                           │
│   └─ #wbwe-style       注入的 CSS（含遮蔽层透明化）               │
└──────────────────────────────────────────────────────────────────┘
```

---

## 三层分离的注入载荷

`injector.mjs` 刻意拆成三个函数，理由是**守护进程需要在新窗口诞生之前就拿到脚本文本**：

| 函数 | 输入 → 输出 | 碰 CDP 吗 |
|---|---|---|
| `buildInjectData()` | 库存 + 状态 → 纯数据对象 | 否 |
| `buildInjectScript()` | 数据 → **一整个表达式字符串** | 否 |
| `applyWallpaper()` | 表达式 → 求值结果 | **是** |

守护在 `connect()` 之前就调 `buildInjectScript()`，那一刻它一个 target 都还没连上。

---

## 脚本文本怎么装配

```
src/inject/wallpaper-engine.js        ← 纯脚本分片：无 import/export、无反引号、LF 行尾
        │
        │  readInjectParts()   读取 + 规范化 + 三条硬约束校验
        │  字符串拼接（不做模板字面量求值！）
        ▼
(function(){ var data = {...}; var boot = function(){ <分片缩进 4 格> };
  if (document.body) { boot(); return 'applied'; }
  /* 否则等 body 出现：MutationObserver + DOMContentLoaded + 15s 兜底 */
})()
        │
        │  lintScript()   用 new Function() 做语法体检
        ▼
   交给 Runtime.evaluate / Page.addScriptToEvaluateOnNewDocument
```

**为什么用字符串拼接而不是模板字面量**：模板字面量会吃掉一层转义
（`\\uXXXX` → `\uXXXX`、`\s` → `s`）并规范化行尾。上游项目因此踩过
"切出的脚本比预期多 2850 字节"和"注释里的反引号静默截断整段脚本"两个坑。
拼接从根上消除这一类问题。

**外层为什么包一层等 body**：`Page.addScriptToEvaluateOnNewDocument` 注册的脚本
跑在"文档创建点"，那时 `<head>`/`<body>` 都还不存在 ——
直接跑必抛 `TypeError`，而且**症状极阴**：注册返回成功、日志无错误、
重载后页面干干净净。只等 `<head>` 也不够，会在 `appendChild(body)` 那行再炸一次。

---

## 幂等模型

注入会被**反复执行**（启动、切壁纸、守护为每个新窗口、用户手动 apply）。
所以每次执行的**第一件事**就是把上一个实例彻底停掉：

```js
try { window.__wbWallpaperEngine?.dispose?.(); } catch {}
```

`dispose()` 必须撤销的长期资源（漏一个就会累积）：

| 资源 | 漏掉的后果 |
|---|---|
| `<video>` | 解码器还在跑（必须 `pause()` + `removeAttribute("src")` + `load()`） |
| WebWallGL 实例 | 漏 WebGL 上下文 + 叠渲染循环（必须 `destroy()`） |
| `<iframe>` | 网页壁纸的渲染进程残留 |
| `setInterval`（轮播） | 定时器继续切壁纸 |
| DOM 节点 | 视觉叠加 |

节点按 **id** 重建（`getElementById(...)?.remove()`），不靠变量记引用 ——
因为旧版本脚本留下的孤儿不在我们的变量里。

`<style>` 节点**刻意不删**：删了会在"下次注入之前"闪回原生外观。
下次 `build()` 复用同一个节点并覆写内容。

---

## 守护进程：为什么必须用事件而不是轮询

注入发生在启动那一刻，通常只有主窗口。但 WorkBuddy 5.7.6 的**设置界面是独立的
BrowserWindow**（`appId=settings`，900×680，加载同一个 `renderer/index.html`）。
那是一个全新的渲染进程 —— 不管它，用户一打开设置就看到"没有壁纸"的窗口。

```
浏览器级 CDP 会话（/json/version）
   │  Target.setAutoAttach({ autoAttach, waitForDebuggerOnStart: true, flatten: true })
   ▼
新 target 诞生 → 出生即暂停 ──┬─ 是 renderer/index.html 且 type=page ?
                             │      ├─ 是 → Runtime.addBinding（上报通道）
                             │      │      Page.addScriptToEvaluateOnNewDocument（首屏脚本）
                             │      │      Runtime.evaluate（即时注入，只做一次）
                             │      └─ 否 → 不注入
                             └─ 无论成败 ──► Runtime.runIfWaitingForDebugger  ★
```

**★ 那一行是最关键的**：漏掉它，那个渲染进程会**永久停在出生状态 = 用户看到白屏**。
所以它放在 `finally` 里，无条件调用，并带超时上限。
`test/verify-guard.mjs` 里专门有测试证明"注入抛错时依然放行"。

另外两条纪律：

- **每个会话都要注册一份首屏脚本。** 同一窗口可能拿到两个会话
  （`setAutoAttach` 自动附加 + `attachToTarget` 显式附加），而它们的寿命不同 ——
  自动附加的能活过重载，显式附加的活不过。挑一个用就会偶尔失效。
- **即时注入只做一次。** 用 `injectedTargets` 按 targetId 去重（targetId 是 UUID，不复用）。

---

## Scene 壁纸：渐进增强

Scene 是本项目最复杂的一条路径，设计原则是**任何一步失败都静默降级，绝不黑屏**：

```
选中 scene 条目
   │
   ├─ ① 立刻：铺静态兜底图（解出的 4K 贴图 → 工坊预览图）
   │         用户此刻已经看到东西了
   │
   └─ ② 异步：WebWallGL 实时渲染（不 await，调用方立即返回）
         fetch(pkgUrl) → arrayBuffer        file:// 直读，只传路径
         lib.mount(holder, { source: lib.bytesSource(bytes, root, key),
                             fps, volume, autoplay })
         首帧出来 → requestAnimationFrame(holder.opacity = 1)   淡入顶替
         
         任一步失败 → 移除 holder，静默留在静态图上（console.warn）
```

**世代号（`sceneGeneration`）** 是保证正确性的关键：每次 release 自增，
所有异步回调在**每个 await 之后**都重新比对世代号与当前 id。
少了这道闸，快速连点几个 scene 会让多个 `mount` 并发挂上同一图层。

**60 秒 mount 超时**是必需的：`mount` 只在首帧真正画出来之后才 resolve，
而窗口隐藏时 rAF 不跑 → 首帧永远不来 → 没有超时会一直挂着。

---

## 状态

```
宿主 side（权威）                          渲染进程 side（缓存 + 兜底）
%LOCALAPPDATA%\WorkBuddyWallpaperEngine\   localStorage["wbwe.state.v1"]
  state.json      ← 原子写（tmp + rename）
  injector.log    ← 环形截断
  cache/<id>/     ← scene 解出的 hero.* + meta.json
  guard-<port>.pid
        ▲                                            │
        │  Runtime.bindingCalled（__wbweReport）      │
        └────────────────────────────────────────────┘
```

两处都写是刻意的：CDP binding 只在守护在场时可用。用户手跑一次 `apply` 就退出的话，
binding 不存在 —— 此时设置至少要能在本次会话内生效并留到下次注入。

写状态失败**不抛错**（只提示）。状态只是"记住选择"，核心功能是注入；
在只读环境里因为写不了状态而让整个 `apply` 失败是本末倒置。
另外提供 `WBWE_STATE_DIR` 作为逃生通道。

---

## 可调项 → 样式的性能纪律

在 `<html>` 上写 CSS 自定义属性会触发**全文档**样式重算
（上游实测：2269 元素 ≈ **23ms/次**，拖动只剩 ~40fps）。所以：

| 变化的量 | 写到哪 | 理由 |
|---|---|---|
| 模糊 / 透明度 / 暗度 / 暗角 | 真实元素的**内联 style** | 0ms |
| 玻璃模糊 / 描边 / 圆角 | CSS 自定义属性 | 低频（只在拖动玻璃滑块时变） |
| 滑块数字读数 | **松手才更新** | 面板打开时改任意文本 ≈ 29ms |

另外：`blur(0px)` 也会创建一个全屏合成层（白耗 GPU），所以低于 0.5px 就整个摘掉 filter。
模糊开启时 `inset` 要**反向外扩** `-2×blur`，否则视口四边会露出未模糊的白边。

---

## 目录职责一览

| 路径 | 职责 | 可否独立测试 |
|---|---|---|
| `src/util.mjs` | 百分号编码、大小写去重、GBK 文件名修复 | ✅ 纯函数 |
| `src/constants.mjs` | 常量与可调项的唯一真源 | ✅ |
| `src/state.mjs` | 状态读写 / 迁移 / 可写性探测 | ✅ |
| `src/we-library.mjs` | Steam 发现、`project.json` 解析、类型分类 | ✅ fixture |
| `src/we-extract.mjs` | RePKG 解包、主贴图挑选、图片头解析 | ✅ fixture |
| `src/platform/workbuddy.mjs` | exe / 端口 / Node / 状态目录解析 | ✅ |
| `src/cdp-client.mjs` | CDP 会话、target 过滤、回环安全闸 | ✅ 迷你 WS 服务器 |
| `src/injector.mjs` | 载荷装配、apply / remove / status | ✅ 注入数据 |
| `src/inject/wallpaper-engine.js` | ★ 渲染进程内的壁纸引擎 | ✅ DOM 替身 |
| `src/guard.mjs` | 守护逻辑（attach / 注入 / 放行 / 重连） | ✅ 假会话 |
| `src/launch.mjs` | 启动、等 CDP、起守护、pid 文件 | 部分 |
| `src/cli.mjs` | 子命令分发与输出 | 端到端 |
