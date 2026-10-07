# 踩坑记录（Pitfalls）

本文件记录**已经踩过并修掉的坑**，以及移植上游实现时必须保留的隐含约束。
每条都写清"症状 → 原因 → 对策"，因为这里绝大多数坑的症状都极具误导性
（看起来像别的问题）。

来源标注：
- `[anon]` = 来自 anonbuddy-skin（MIT）在 WorkBuddy 上的实测经验
- `[dsh]` = 来自 dsh-wallpaper-engine（MIT）在 DSH 上的实测经验
- `[local]` = 本项目在本机实测发现的

---

## 一、CDP / 注入时机

### 1. `Page.addScriptToEvaluateOnNewDocument` 的脚本跑在"文档创建点" `[anon]`
此时 `<head>` / `<body>` **都还不存在**。脚本里第一件事就是
`document.head.appendChild(style)` → 直接抛 `TypeError`。

- **症状最阴**：注册调用返回成功、日志一条错误都没有、重载后页面干干净净。
  换成 30 字节探针（`window.__x=1`）却能稳稳活过重载 → 极易误判成"注册机制不 work"。
- **对策**：脚本外层包一层"等 `document.body` 出现再启动"的引导。
  **只等 head 不够** —— 会在 `appendChild(body)` 那行再炸一次。

### 2. `addScriptToEvaluateOnNewDocument` 只对**之后**创建的文档生效 `[anon]`
窗口从 `about:blank` 走到真实页面的那几毫秒，可能正好在"注册"期间发生 →
那一次导航被错过，窗口永久裸着（手动 reload 立刻全好）。

- **对策**：注册完**重问一次** `location.href`。若被暂停则 `Runtime.evaluate`
  没有执行上下文 → 说明确实还没导航；否则补一次即时注入。

### 3. CDP 会话有两种，寿命不一样 `[anon]`
`setAutoAttach` 自动附加的会话**能活过重载**；`attachToTarget` 显式附加的**活不过**，
注册在它上面的首屏脚本随之失效。而 `setAutoAttach` 会把已在跑的 target 一并附加 →
同一个窗口会拿到**两个**会话。

- **对策**：不要挑一个用，**每个会话都注册一份**。注入本身幂等，重复注册只多跑一次。

### 4. `Target.attachedToTarget` 的 `sessionId` 在 `params` 里 `[anon]`
顶层 `sessionId` 只有"子会话发出的事件"（例如 `Runtime.bindingCalled`）才有。

- **症状**：事件收到了但什么都没发生。

### 5. `waitForDebuggerOnStart` 是货真价实的暂停 `[anon]`
注入无论成功、失败还是超时，都**必须**走到 `Runtime.runIfWaitingForDebugger`。

- **症状**：那个渲染进程永久停在出生状态 = **用户看到白屏**。
- **对策**：把 resume 放 `finally`，并给它自己的超时上限。CDP 断开时 Chromium 会自行
  resume，但**不要依赖**这个行为。

### 6. 非 page target 也被暂停 `[anon]`
worker / service worker 同样被 `waitForDebuggerOnStart` 暂停着。即使不注入，
也**必须放行**它们。

### 7. browser 级会话不能 enable Runtime/Page `[anon]`
协议会直接拒绝。浏览器级会话的域列表必须是空的。

### 8. `globalThis.WebSocket` 需要 Node ≥ 22 `[anon]`
Node 20 没有全局 `WebSocket`（21/22 才有）。WorkBuddy 自带的 Node 实测为
**22.22.2**，本项目 `engines.node` 因此写 `>=22`。

### 9. 僵尸 socket `[anon]`
端口处于 LISTENING 但永不响应 → 所有 `/json/list` 请求**都必须带超时**，
否则 fetch 永久挂起（历史上 9223 就是这个状态，表现为"脚本卡死"）。
本项目的 `fetchTargets` 一律带 `AbortController`。

### 10. `Page.captureScreenshot` 在有 `<video>` 时会卡住 `[anon]`
实测超时。用截图做断言的测试必须在"无视频"状态下跑。

### 11. `requestAnimationFrame` 在页面不可见时完全不执行 `[anon]`
最小化 / 收进托盘时 300ms 内零回调，`Page.bringToFront` 也唤不回最小化的窗口。
任何"等首帧"的流程都必须先确认页面可见。

### 12. `Promise.race` 的超时兜底挂在共享路径上会销毁刚成功的实例 `[anon]`
先注册的微任务排在 `await` 续体**之前**，那一刻实例变量还没赋值 →
"late !== instance" 恒真 → 刚 mount 好的实例被立刻 `destroy()`。

- **症状极具迷惑性**：mount 正常 resolve、日志打"渲染就绪"、canvas 尺寸也对，
  但 `info` 恒为 `null`、`stats.fps` 恒为 0。
- **对策**：兜底逻辑只注册在它真正负责的那条分支（`catch`）里。

---

## 二、渲染层 / DOM / CSS

### 13. `body` 不能填背景色，否则把壁纸层整个盖住 `[anon]`
`html` 上有原生不透明白底时，`body` 背景**不再"上交给画布"**，而作为普通元素背景
在绘制顺序第 3 步绘制，**晚于负 z-index 层（第 2 步）**。

- **实测证据**：整屏 PNG 只差 34 / 160000 字节（几乎全被盖住）。
- **对策**：`body { background: transparent !important }`，主题底色挪进壁纸图层自身。

### 14. 在 `html` 上写自定义属性会触发**全文档**样式重算 `[anon]`
实测 2269 元素 ≈ **23ms/次** → 拖动滑块只剩 ~40fps。

- **对策**：模糊 / 暗度这类每帧变的量，写**真实元素的内联 style**（0ms）；
  只有"颜色类"低频量才写 CSS 变量，并且用 rAF 节流。

### 15. 设置弹窗打开时改 `textContent` ≈ 29ms `[anon]`
弹窗内 2700+ 元素。滑块的数字读数**松手才刷新**，拖动中不更新。

### 16. `classList.toggle(cls, false)` 在类本来不存在时**也产生 mutation** `[anon]`
引擎要重新匹配约 2600 条"祖先类 + 后代"规则 → 切主题卡 55~65ms，
严重时渲染线程卡死（连 `Runtime.enable` 都超时）。

- **对策**：**先判断是否真的需要改**，不要无脑 toggle。

### 17. 嵌套 `backdrop-filter` 会失效 `[anon]`
父级一旦有 `backdrop-filter` 就建立新的 backdrop root，后代的只能模糊父级内部
（实测 `blur(40px)` 依然清晰穿透）。

- **对策**：玻璃只加在**顶层**玻璃面上。

### 18. CSS 自定义属性必须在**声明它的元素上**就能解析出 `var()` `[anon]`
`--x: color-mix(…, var(--surface), …)` 写在 `:root`，而 `--surface` 定义在 `body` →
解析失败变成 guaranteed-invalid，**并且停止向下继承** → 使用处整条
`background-color` 被丢弃。

- **症状**：玻璃"看起来没有"。
- **对策**：回退必须是"**写另一个值**"，不能是"不写"。

### 19. "没有人再写它"不等于它消失了 `[anon]`
早期版本给原生元素写过**内联** `backdrop-filter`，后来从选择器列表里移除 →
没有任何人覆盖它，重新注入只重建我们自己的节点 → 整片内容区一直被糊着。

- **对策**：**凡是从选择器列表里删掉的原生元素，都要顺手擦一次内联样式。**

### 20. 独立窗口各写各的 CSS 变量 `[anon]`
设置面板跑在独立 renderer，`localStorage` 跨窗口共享但 **CSS 变量不共享** →
在设置窗口拖滑块，主界面纹丝不动。

- **对策**：用 `storage` 事件自己架桥。注意 `storage` **只在"别的窗口"写入时触发**，
  天然不会形成回环，但还是加一道值比较更稳。

### 21. 子窗口有原生安全区，不能铺壁纸 `[anon]`
5.6.x 的设置窗口顶部有 62px 留给标题栏按钮，`inset:0` 的壁纸层会铺上去露出一条壁纸条。

- **判据**：URL 里的 `windowKind` / `windowAppId`（两者都是稳定原生参数）。

### 22. 面板配色必须跟"弹窗自身底色"，不能跟壁纸主题 `[anon]`
否则深色壁纸把文字设浅 → 白弹窗上**白字白底** → 整个面板"看起来是空的"。

- **对策**：读 `.settings-modal__content` 的 `computedStyle.backgroundColor`。

### 23. 同作用域 `const` 的 TDZ 会让整个函数抛错 `[anon]`
`mkWeBtn` 定义在后面的壁纸段，而"自动调优"按钮长在更早的外观组 →
`Cannot access 'mkWeBtn' before initialization` → `buildSettingsPane` 整个抛错。

- **症状**：**面板根本建不出来**（点入口没反应、pane 元素不存在）。
- **对策**：面板构造函数之间不要有"后面才定义的 const"依赖，或用函数声明（会提升）。

### 24. 导航栏是 React 渲染的、会被重建 `[anon]`
每次打开 / 切 tab 都重建，插进去的按钮会被回收。

- **对策**：`MutationObserver` + 定时兜底双保险；卸载时**按 id 全量扫孤儿**
  （`dispose()` 只能清"变量里记着的那几个节点"，旧版本脚本留下的会叠成两份）。

### 25. 往面板元素写自定义属性会让整棵子树样式失效 `[anon]`
"重复应用同一主题"从 ~0ms 涨到 53.8ms。

- **对策**："始终重算、只在值变了才写"。**不能**改成"面板没显示就跳过" ——
  那样面板关闭期间切颜色会停在旧值。

---

## 三、媒体 / 视频 / WebGL

### 26. 切走必须真正释放解码器 `[anon]`
`pause()` + `removeAttribute("src")` + `load()`。只把节点从 DOM 摘掉，
**解码器可能还在跑**。本项目把它列为幂等红线。

### 27. 面板列表绝不给每个条目塞 `<video>` `[anon]`
几十个解码器会同时跑，直接拖垮渲染进程。缩略图一律用静态 `preview` + `loading="lazy"`。

### 28. 暂停不要写死 `volume = 0` `[anon]`
会把用户设的值一起落盘，"暂停 → 继续"后声音永久消失、重启依然静音。

- **对策**：音量必须是**派生值** `effectiveVolume()`。

### 29. 音量要同时同步到 `<video>` 与 GL 实例 `[anon]`
scene 壁纸没有 `<video>`，声音只走 WebWallGL 实例的 `setVolume`。
漏掉就是"打开声音开关，scene 壁纸照样无声"。

### 30. 音量写入要用 DOM 兜底选元素 `[anon]`
切换壁纸 / 重建视频的时序里，JS 里的引用可能已与真实节点脱钩。
（实测现象：localStorage 写对了、`muted` 也变了，唯独 `volume` 停在 0。）

### 31. `activeId` 必须在创建媒体**之前**赋值 `[anon]`
否则 scene 的世代校验会把自己误判成过期请求而放弃渲染。

### 32. `destroy()` 是唯一会停渲染循环并释放 WebGL 上下文的动作 `[anon]`
漏掉 = 漏上下文 + 叠渲染循环。浏览器同页上下文数量有限。

### 33. 暂停 / 恢复 scene 走 `pause()` / `resume()`，绝不 destroy 重建 `[anon]`
重建要重新解析 pkg，复杂场景实测 **9 秒**起。

### 34. WebWallGL 必须锁 1.4.2，不要用 2.0.2 `[anon]`
2.0.2 连续创建 / 销毁渲染实例会泄漏，**第 7 个实例起全部挂死**
（34 个包只过 1 个），1.4.2 是 34/34 全过。

### 35. `mount` 只在首帧真画出来之后才 resolve `[anon]`
窗口隐藏时 rAF 不跑 → 首帧永远不来 → 没有超时会一直挂着。

- **对策**：超时 60s（最慢实测 9.1s × 数倍余量）。
- **注意**：超时后那个在飞的 mount 稍后**仍可能成功**，而那时它没人接管 →
  必须自己接住并 `destroy()`。

### 36. 浏览器不允许非静音自动播放 `[anon]`
默认静音起播，用户打开声音开关时再解除（那时已有用户手势）。

---

## 四、文件 / 路径 / WE 库

### 37. Windows 路径大小写不敏感，候选不去重会让条目翻倍 `[anon]`
`D:/Steam` 与 `D:\Steam` 是同一个目录。实测条目数 **38 → 76**。

### 38. `file://` 直读成立的前提是渲染进程本身跑在 `file://` 下 `[anon]`
这是 WorkBuddy **当前行为，不是契约**。若将来改成 `app://` 或 http，整条路失效。

- 实测：`fetch` / `<img>` / GIF / `<video>` 全部成功；**跨盘可读**。
- 本项目的降级链因此必须保留：WebWallGL → 解出的静态 4K 贴图 → 工坊预览图 → 取色渐变。

### 39. 路径含中文 / 空格必须**逐段**百分号编码 `[anon]`
`20s慢_1.mp4` → `20s%E6%85%A2_1.mp4`。**不能编码盘符段**。
本项目直接用 Node 的 `pathToFileURL()`（比手写可靠）。

### 40. `project.json` 编码不固定 `[anon]`
实测见过 utf-8-sig / utf-8 / gbk。本项目回退顺序：
**utf-8（strict）→ gb18030 → gbk → big5 → utf-8（宽松）**。

### 41. RePKG 的 `-e` 只能写 `tex` `[anon]`
pkg 里贴图的原扩展名是 `.tex`，RePKG 提取时顺手转成图片。写 `-e png` **一张都匹配不到**。

### 42. RePKG 的中间产物可能上 GB `[anon]`
实测 11 个残留目录吃掉 **2GB**。

- **对策**：本项目**只保留一张主贴图**，解包完立刻删掉 `raw/` 整个目录。

### 43. 只按体积挑主贴图会挑错 `[anon]`
32 个样本里只有 13 个选对 16:9，其余会挑中竖版立绘或 256×256 缩略图。

- **对策**：优先顺着 `scene.json` 的 `objects[].image` 找（WE 自己声明的画面主体），
  其次按**像素面积**（不是字节数）取最大。

### 44. WE 素材只在本机有效、不可分享、不可入库 `[anon]`
引用本机绝对路径，换机器即死链；创意工坊内容版权归作者。

- **对策**：面板上必须标注"仅本机"，内容**绝不入库**（本项目只存路径不存字节，
  天然不会入库）。`.gitignore` 已排除缓存目录。

### 45. `localStorage` 配额有限 `[anon]`
实测只剩约 7.4M 字符 → **绝不能**把媒体搬进 data URL / blob。
这是"只传路径不传字节"的根本原因。

---

## 五、Windows 集成 / 启动链

### 46. WorkBuddy 自动更新会把调试端口吃掉 `[anon]`
更新时先以 `reason=update` 关旧进程，再由更新器拉起新进程，
**原始命令行参数不被继承** → `--remote-debugging-port` 消失。

- 这不是故障，是"不碰官方文件"的代价。**对策**：守护进程重连 + 面板上提示"壁纸已暂停"。

### 47. 进程带图灵盾保护 `[anon]`
`Stop-Process` / `taskkill /F` / CIM Terminate **全被拒**（Access is denied）；
也**读不出 `ExecutablePath`**（所以本项目不做"从进程反推 exe"）。

- **对策**：若 WorkBuddy 已经**不带端口**在跑，本项目无法接管它 →
  必须让用户先完全退出（右键托盘图标选退出），再重新启动。

### 48. WorkBuddy 每次启动把自己那条 Run 值写回裸 exe `[anon]`
Electron 的 `setLoginItemSettings` 行为 → "绑一次永久有效"不成立。

- **对策**：用**我们自己的值名**（否则两版本互相覆盖）+ 每次启动末尾复查自愈。

### 49. `.ps1` 必须纯 ASCII `[anon]`
PowerShell 5.1 读**无 BOM** 的 UTF-8 会按 GBK 解析，中文注释破坏语法。
本项目的安装脚本因此全英文。

---

## 六、脚本装配 / 工程约定

### 50. 注入脚本里注释出现反引号会**静默截断**整段脚本 `[anon]` / `[local]`
历史踩过 3 次。

- **对策**：本项目把注入脚本体抽到独立的 `src/inject/*.js` 分片文件，
  装配时只做**字符串拼接**（不做模板字面量求值），从根上消除这一类问题。
  分片里的模板字面量也因此不会被"吃掉一层转义"。
- **配套体检**：`scripts/lint-inject.mjs` 用 `new Function()` 做语法检查，
  再检查分片里没有反引号、没有 `export`。

### 51. 从**源码**切分片会丢掉行尾规范化与转义层 `[anon]`
第一版切出 142072 字节（应为 139222），`\uff08` 变成 `\\uff08`。

- **对策**：本项目分片是**纯脚本文本**（不含 `export`），装配时把
  `\r\n` 规范成 `\n`，不做任何转义处理。

### 52. Node 侧模块常量在 renderer 里读不到 `[anon]`
`DEFAULT_ACCENT` 曾直接写进注入模板 → `ReferenceError`。
**必须走 payload**（本项目由 `buildInjectData()` 统一序列化）。

---

## 附：本机实测的环境事实（2026-10 于本项目开发机）

| 项 | 值 |
|---|---|
| WorkBuddy 版本 | 5.7.6 |
| Electron / Chromium | 37.10.3-24 |
| WorkBuddy exe | `C:\Users\liujihui\AppData\Local\Programs\WorkBuddy\WorkBuddy.exe` |
| CDP 端口 | 9334（国内版 `WorkBuddy.exe`） |
| WorkBuddy 自带 Node | `~/.workbuddy/binaries/node/versions/22.22.2-6/node.exe` |
| Steam | `D:\Program Files (x86)\Steam` |
| WE 库规模 | 72 条目（workshop 53 + defaultprojects 19），可渲染 50 |
| 类型分布 | 55 scene / 9 video / 4 web / 1 preset / 3 unknown |
| 最大单包 | 621 MB（web 壁纸） |
| RePKG | 0.4.0，解 2.9MB 的 scene.pkg 耗时 **0.21s**，产出 3840×2160 JPEG |
