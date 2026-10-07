# WorkBuddy 渲染层实测事实（注入目标）

本文件记录**对 WorkBuddy 5.7.6 的实际侦察结果**，它是注入选择器的依据。
每一项都写了取证方式；`[确认]` 有文件/命令直证，`[推断]` 为外推。

> 为什么值得单独成文：注入失败的表现几乎总是"什么都没发生"。
> 把"目标长什么样"固定下来，才能区分"我们的代码错了"和"WorkBuddy 改版了"。

---

## 1. 版本与构建 `[确认]`

| 项 | 值 | 取证 |
|---|---|---|
| WorkBuddy | **5.7.6** | `install-manifest.json` / `~/.workbuddy/app/renderer-version.json` / exe FileVersion / asar 内 package.json，四处一致 |
| 包名 | `@genie/workbuddy-desktop` | asar 内 package.json |
| Electron | **37.10.3** | `WorkBuddy.exe` 内嵌串 |
| Chromium | **138.0.7204.251** | 同上 |
| asar 大小 | 211,193,422 字节，13,907 条目 | 头部 pickle 解析 |
| 主程序 | `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe` | 实测存在 |
| 进程保护 | 图灵盾（TuringShield） | `taskkill /F` / `Stop-Process` / CIM Terminate 全被拒；`ExecutablePath` 读不出 |

---

## 2. 渲染入口与协议 `[确认]`

- 主进程 `main` = `main/index.js`；渲染入口 = asar 内 **`renderer/index.html`**（25,628 字节）
- `RendererLoadGuard.loadPage()` 用 `win.loadFile(<asar>/renderer/index.html, { query })`
  → 所以**页面协议是 `file://`**
- 信任判定 `isTrustedTerminalIpcEvent()` 要求 `protocol === 'file:'`
  且 realpath 等于该文件 → 进一步确认
- **主窗口与设置窗口加载同一个 HTML**，靠 query 分发：
  `windowAppId ?? windowKind ?? 'main'` → 动态 import `./window-apps/<entry>/bootstrap.tsx`
- 5.7.6 实测 query keys：`colorScheme, windowTheme, appearanceSkin, windowAppId, windowKind,
  windowId, windowPreset, windowControls, windowControlPosition, windowCreatedAt, productIsOversea`

**对我们的意义**：
- `file://` ⇒ 可以直接 `<video src="file:///…">`、`fetch(file://…)`（零拷贝，已验证 `fetch`/`<img>`/GIF/`<video>` 全部成功，跨盘可读）
- 窗口判别要靠 URL 里的 `windowAppId` / `windowKind`（不要猜 DOM）

---

## 3. CSP 与安全 `[确认]`

- **主渲染页没有 CSP**：`renderer/index.html` 860 行内无 CSP meta；
  主进程虽然构造了 CSP 串，但注册的 `onHeadersReceived` 首行就是
  `if (!e.url.startsWith('file://')) return;` → **`file://` 被显式排除**
- ⇒ 内联 `<script>` / `<style>`、`file://` 图片与视频、`data:` / `blob:` 都不受拦
- 只有两处无关页面带 CSP meta（DevTools Find 面板、TDoc 调试面板，都是 data: URL）
- `webPreferences`：`contextIsolation: true`、`sandbox: true`、
  `nodeIntegration: false`、`webSecurity` 默认 true
- preload 有 `NativeThemeSync`：监听 `documentElement[data-skin]` 与
  `body[data-vscode-theme-kind]` / `data-theme-source` → invoke 同步**原生标题栏材质**

**对我们的意义**：
- 注入内联脚本不需要绕 CSP ✅
- ⚠️ **不要动 `data-skin`**，否则会连带改掉原生标题栏底色，和壁纸打架

---

## 4. DOM 骨架与**遮蔽层**（最关键的一节）`[确认]`

`renderer/index.html` 结构：

```html
<html>                      <!-- background: #ffffff -->
  <body>                    <!-- background: var(--vscode-editor-background) -->
    <div id="skeleton-root"> <!-- position:fixed; z-index:99999；挂载后移除 -->
    <div id="root">          <!-- React 挂载点，自身无背景 -->
```

React shell 类名（有实证）：`.teams-container`（最外层）、`.teams-content-wrapper`、
`.teams-main-content`、`.main-content`、`.workbuddy-topbar`、
`.sidebar-next`（含 `--windows-chrome` / `--left-collapsed`）、
`.wb-home-route`、`.wb-home-composer`、`.cr-theme`、`.cbChat`

状态属性：`html[data-theme]`、`html[data-skin]`、
`body[data-vscode-theme-kind]`、`body[data-application-name=workbuddy]`、
`body[data-electron-desktop][data-platform]`

### 必须置透明的不透明底（实测规则）

| 选择器 | 原本的背景 |
|---|---|
| `html` | `#ffffff` |
| `body` | `var(--vscode-editor-background)` |
| `.main-content` | `var(--wb-home-bg-secondary)` = **`#fff`（浅）/ `#141414`（深）** |
| `.main-content--initializing` | 同上 |
| `.workbuddy-topbar` | 同上 |
| `.teams-top-bar` | `var(--cb-panel-bg-primary)` |
| `.sidebar-next--windows-chrome` | `var(--color-bg-primary-default, #fff)` + `border-radius:12px 12px 0 0` |

这些都在壁纸层**之上**绘制。我们的壁纸层是 `z-index: -1`，
只要有任意一个不透明底压在上面，壁纸就只能在缝隙里露出来
（上游实测：整屏 PNG 只差 34 / 160000 字节，等于全被盖住）。

`src/inject/wallpaper-engine.js` 里的 `OCCLUDERS` 数组就是这份清单。

### 层叠序 `[确认 + 推断]`

```
.settings-modal-overlay         z 1000   (背景透明, fixed inset 0)
  < .automation-main-page       z 102
  < #workbuddy-menubar-container z 10000
  < 第三方浮层                   z 2147483000（挂 body 下）
```

**壁纸层落点**：`body` 下、`#root` 之前，`position:fixed; inset:0; z-index:-1`。
`#root` 自身形成层叠上下文（React 挂载点通常 `position:relative; z-index:0`），
所以负 z-index 层天然落在它之下，且换壁纸时怎么 `appendChild` 都不会打乱层级。

---

## 5. 设置界面：**两种形态都存在** `[确认]`

### (a) 独立 BrowserWindow
- `appId=settings`，manifest：`rendererEntry:'settings'`、`preset:'utility'`、
  `customTitleBar:true`、`controls:['close','maximize']`、
  `width:900 height:680 min 800×640`、`instancePolicy:'single'`
- 加载同一个 `renderer/index.html` + `windowAppId=settings`
- `APPEARANCE_SNAPSHOT_APP_IDS = {settings, developer-profile}`
  （只有这两个窗口的 load query 带外观快照）
- DOM：`main.settings-window-root` > `div.settings-window-chrome[--windows]` >
  `button.settings-window-close`

### (b) 主窗口内的 hash 路由弹层
- `#settings/<tab>[/<subRoute>]`
- DOM：`.settings-modal-overlay[--appearance]`（z 1000、fixed、**背景透明**）
  > `.settings-modal` > `.settings-modal__nav` + `.settings-modal__header(__left/__right/__extra/__back/__title/__close)`
  + `.settings-modal__content` > `.settings-modal__panel`

⚠️ **`.settings-modal--window` 在 5.7.6 里不存在**（正则检索无匹配）。
早期第三方插件的注释里写的"5.6+ 用 `.settings-modal--window`"与本机不符 ——
**不要照抄那个选择器**。

### 共享导航结构（两形态通用）

```html
<nav class="settings-navigation">
  <div class="settings-navigation__group">
    <div class="settings-navigation__group-title">…</div>
    <button data-settings-tab="<tabId>" class="settings-navigation__item [--active]">
      <span class="settings-navigation__icon">…</span>
      <span class="settings-navigation__label">…</span>
    </button>
  </div>
</nav>
```

### tab 白名单（硬编码 19 项）`[确认]`

`account, subscriptionUsage, connectors, settings, appearance, extensions,
systemPermissions, securityCenter, keyboardShortcuts, softwareConfig, memory,
models, claw, buddyApps, personalization, dataManagement, helpFeedback,
laboratory, getHelp`

不在表内的 tab id 会被回落成默认 tab —— 所以往导航栏插自定义 tab 要走
`panelOverrides` 而不是硬塞一个 `data-settings-tab`。

### 官方扩展点 `[确认]`
`SettingsShell` 组件已接受三个 props：
`supportedTabs` / `panelOverrides` / `renderUnsupportedPanel`。

### 历史实证
第三方插件曾经成功注入过 `entryId: anonbuddy-skin-menu-settings-entry` /
`paneId: …-settings-pane` / `navGroup: "功能"`，
方式是新窗首帧前 CDP 注入 + 常驻 guard，未改 asar。

---

## 6. 用户数据形态 `[确认]`

- `~/.workbuddy/settings.json` **不含任何外观键**。顶层只有：
  `claw`、`enabledPlugins`、`sandbox.orderedRules`（~135 条）、`extraAllowWrite`、
  `autoLaunchDesired`、若干迁移标记
- **外观偏好真实落点**：
  `~/.workbuddy/storage/user-<uid>-personal/global/preferences.json`
  ```json
  {
    "theme": "light",
    "appearance.themeSelection": { "resourceKey": "theme-tkbe90", "source": "settings-select" },
    "appearanceTheme": "theme-tkbe90"
  }
  ```
  跨窗同步键 = `appearanceTheme`，事件 `config.preference.appearanceTheme.changed`
- `~/.workbuddy/appearance-resources/` 里有一个生效中的官方皮肤
  `theme-tkbe90-<ts>/`（`skin.v2.css` 51,576 B + `assets/custom/img-*.png`）

**对我们的意义**：本项目**不碰**这套官方皮肤机制，也不写 `preferences.json`。
两者互不干扰：官方皮肤走 CSS 通道改配色，我们走 DOM 图层加背景。

---

## 7. 官方换肤机制的形态（供参考，本项目不走这条路）`[确认]`

- 生效载体：`document.adoptedStyleSheets` 或 `<style data-skin-sheet="skin">`（在 head）
- 同时设 `documentElement[data-skin] = resourceKey`
- CSS 上限硬编码 512 KB
- 皮肤 URL 有白名单校验（仅 https、禁内网/回环、仅 `.codebuddy.cn` / `.myqcloud.com` / `.tencentcos.cn`）
- 官方壁纸的做法是 **`background-image` on `.teams-container`**，
  配合逐面板置透明 —— 而不是独立浮层

**为什么本项目不采用它**：那条路只能做**静态图片**背景，
无法承载 `<video>` 与 WebGL canvas，而 Video / Scene 实时渲染正是本项目的核心功能。

---

## 8. 未确认项（如实记录，未猜测）

1. `.teams-container{}` / `.cb-grid{}` / `.teams-content-wrapper{}` 的本体规则
2. 本机打开设置的实际入口（侧边栏无「设置」文本、`Ctrl+,` 无效 → 推测在托盘右键菜单）
3. `panelOverrides` / `renderUnsupportedPanel` 由谁传 props
4. `.settings-modal` 在桌面（非 `width<=480px`）下的基础布局规则
5. `settings` 窗口是否额外覆盖 `backgroundColor` / `vibrancy`
6. 皮肤缓存三者（`skin.v2.css` / `skin.css` / 日志里的 `cssLen=47877`）的生成关系
7. 官方 `appearance` tab 是否支持用户上传自定义壁纸图

---

## 9. 复现方法

侦察用的是一个自写的 asar 解析脚本（只按需抽取，从不整读 211MB）。
要点：asar 头部是三层 pickle —— `[0:4]=4`、`[4:8]=payloadSize`、`[12:16]=jsonLen`，
**JSON 从 offset 16 起**，数据区从 `8 + payloadSize` 开始。

WorkBuddy 升级到新版本后，**先复查本文件的第 3、4、5 节**
（CSP 是否收紧、遮蔽层清单是否变化、设置面板选择器是否改名），
再怀疑项目代码。
