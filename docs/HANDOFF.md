# 交付说明

## 状态：已推送 ✅

```
仓库    https://github.com/liujihui47-droid/wbwe
分支    main
提交    a7e76e4（3 个 commit，42 个文件）
```

已验证：**从 GitHub 全新克隆** → 关键二进制 sha256 与本地一致 →
在该克隆里跑 `node test/run-all.mjs` → **9 个测试套件全部通过**。

安装到 WorkBuddy 只需三步：

```powershell
git clone https://github.com/liujihui47-droid/wbwe.git
cd wbwe
powershell -ExecutionPolicy Bypass -File scripts/install.ps1

# 先从系统托盘退出 WorkBuddy（它有进程保护，本工具无法结束它），然后：
node src/cli.mjs launch
```

> 之前那个 `workbuddy-wallpaper-engine` 仓库（私有）保留为 `upstream` 远端，未被使用。
> 如果不再需要，可以在 GitHub 上删掉它。

---

## 一、当时推送为什么需要认证（留档，避免下次再踩）

GitHub 的**写操作永远需要凭据**，而读公开仓库不需要 —— 所以 `git ls-remote`
能匿名成功，很容易让人误以为推送也行。实际推送需要令牌，且**令牌必须有
`Contents: Read and write`**：

- 第一版令牌只有读权限 → `remote: Permission to liujihui47-droid/wbwe.git denied`
  （认证通过、授权不足。这个区分很重要：如果是 `could not read Username`，
  那是凭据**没送到**；如果是 `Permission ... denied`，那是权限不够。）
- 修正后：`Contents: Read and write` + Repository access 勾选 `wbwe` → 推送成功

另外远端那个自动生成的 `Initial commit`（只有一个占位 README）与本地**没有共同
祖先**，所以必须 `--force` 覆盖。远端占位内容已确认可丢弃。

### 一个 git 的坑（已在 scripts/push.ps1 里绕过）

用 `-c http.extraHeader=AUTHORIZATION: basic <b64>` 传令牌**不管用**：
那个配置属于父进程，而真正发 HTTP 请求的是 `git-remote-https` 子进程，它读不到，
于是 git 转而去要 username，报 `could not read Username for 'https://github.com'`。
可行的做法是把凭据**内嵌进临时的 remote URL**，只在那一条命令里用，
绝不写进 `.git/config`。`scripts/push.ps1` 就是这么做的，并且：
- 输出统一经过 `Redact()`，把令牌替换成 `***` 再打印
- 用完立即把 `$Token` / `$authUrl` 置空
- 支持从 `$env:GH_TOKEN`、`-Token`、或 `.gh-token` 文件读（该文件已 gitignore）

---

## 二、日后要再推的话

```powershell
# 方式 A：环境变量（令牌不进命令历史）
$env:GH_TOKEN = "github_pat_xxx"
powershell -ExecutionPolicy Bypass -File scripts/push.ps1

# 方式 B：直接参数
powershell -ExecutionPolicy Bypass -File scripts/push.ps1 -Token "github_pat_xxx"

# 方式 C：写进 .gh-token（已被 .gitignore 忽略，令牌不进对话/历史）
#   然后： powershell -ExecutionPolicy Bypass -File scripts/push.ps1

# 只试算不真推：
powershell -ExecutionPolicy Bypass -File scripts/push.ps1 -DryRun
```

脚本会自己：跑测试 → 检查工作区是否干净 → 检测两边是否有共同祖先
（无共同祖先且没加 `-Force` 会直接中止）→ 推送 → 抹掉令牌 → 提醒你撤销令牌。

> ⚠️ 本机的 git 用 `schannel` 后端时会报
> `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`。
> 解决办法：给这条命令加 `-c http.sslBackend=openssl`，例如
> `git -c http.sslBackend=openssl push -u origin main`
> （本地仓库已经把这个设置写进 `.git/config`，正常情况下不需要手动加。）

---

## 三、拿到仓库后先自己跑一遍

```powershell
git clone https://github.com/liujihui47-droid/wbwe.git
cd wbwe
node test/run-all.mjs      # 应输出「全部通过（9 个测试套件）」
```

不需要 `npm install` —— 本项目零 npm 依赖。

> 这一步我已经替你在**全新克隆**上跑过一次（2026-10-07）：
> 9 个套件全绿，`webwallgl-1.4.2.global.min.js` 与 `RePKG.exe`
> 的 sha256 与开发副本完全一致（说明 git 的文本规范化没有破坏 vendored 二进制）。

---

## 四、在真机上验证

我在沙箱里**无法**做端到端验证（原因见下节），所以第一次真机跑请按这个顺序：

```powershell
# 1. 环境自检
node src/cli.mjs doctor

# 2. 如果 WorkBuddy 正在运行 → 右键托盘图标选「退出」
#    （它有进程保护，本工具无法结束它，这是设计如此）

# 3. 带调试端口启动 + 注入 + 起守护
node src/cli.mjs launch

# 4. 另开一个终端看状态
node src/cli.mjs status
```

看到壁纸后，点 WorkBuddy 右下角的 🎨 换一张、拖几个滑块试试。

**如果界面没变化**，按这个顺序排查：

1. `node src/cli.mjs status` —— 看有没有命中 target、有没有注入成功
2. 看日志：`%LOCALAPPDATA%\WorkBuddyWallpaperEngine\injector.log`
3. 在 WorkBuddy 里按 `Ctrl+Shift+I` 打开 devtools，看 Console 有没有 `[wbwe]` 开头的输出
   （注入脚本成功时会打 `[wbwe] 壁纸引擎已注入，可用条目 N 个`）
4. 壁纸层建出来了但看不见 → 多半是**遮蔽层**没盖住（`docs/WORKBUDDY-DOM.md` 第 4 节有清单）；
   用 devtools 检查 `#wbwe-layer` 是否在 `document.body` 下、
   `html`/`body`/`.main-content` 的 `background-color` 是否被置成 `transparent`

---

## 五、我在沙箱里**验证了什么 / 没验证什么**（请务必知道）

这台机器有文件沙箱限制，我**不能**起子进程（`spawn` 直接 `EPERM`），
也**不能**写工作区以外的目录。所以：

### ✅ 已经真实验证过的

| 项 | 怎么验的 |
|---|---|
| 注入脚本语法与硬约束 | `scripts/lint-inject.mjs`，29 项检查 |
| **注入引擎真的能跑** | 在 Node 里用最小 DOM 替身**执行**了一遍注入脚本，25 项运行时断言 |
| WE 库盘点 | 对**本机真实库**跑通：71 条（50 可渲染），55 scene / 9 video / 4 web |
| **scene 解包全流程** | 对**本机真实 41 个 scene.pkg** 全量跑完：40 成功 / 0 失败，产出 3840×2160 ~ 4670×2170 贴图 |
| 图片头解析 | PNG/JPEG/GIF/BMP/WebP 尺寸读取，含大 EXIF 段与坏文件 |
| CDP 客户端协议层 | 起**真实 HTTP + 迷你 WebSocket 服务器**跑通 id/await、乱序响应、超时、断线、事件分发 |
| 守护决策逻辑 | 假会话验证：**任何路径（含注入抛错）都会调用 `runIfWaitingForDebugger`** |
| WorkBuddy 路径/端口发现 | `doctor` 实测找到 exe、端口 9334、自带 Node 22.22.2 |
| vendored 资源完整性 | sha256 与大小逐一核对；并确认写进 git 的字节与磁盘一致 |
| 安装脚本 | 实际跑过（含 `-Uninstall`），生成的 `.cmd`/`.vbs` 是纯 ASCII |
| 9 个测试套件 | 全绿 |

### ❌ **没有**验证过的（沙箱限制，必须你在真机上试）

1. **真机端到端注入**。我无法启动 WorkBuddy 并连它的 CDP 端口。
   这是最大的未知项 —— CDP 客户端的**协议层**我用真实 WebSocket 验过了，
   但"对着 WorkBuddy 真的能注入进去"没有实测。
2. **守护对真实新窗口的行为**。逻辑用假会话证明了，
   但 WorkBuddy 实际会不会把设置窗口作为新 target 抛出来、`windowAppId=settings`
   那个窗口的 URL 长什么样，只来自侦察报告，不是我亲眼在 CDP 里看到的。
3. **遮蔽层清单是否完整**。11 个选择器来自对 5.7.6 的代码/日志侦察与二手 CDP 实测记录。
   如果还有第 12 个不透明元素，壁纸会在某些页面被盖住 —— 按上一节的第 4 条排查。
4. **WebWallGL 真实渲染**。我能确认库文件完整、注入脚本会按需加载它、
   mount 的调用方式照搬了上游已验证的写法，但**没有真的渲染出一个 scene**。
5. **视觉观感**（液态玻璃、滑块手感）。我生成了预览页
   （`node scripts/make-preview.mjs --local` → `preview/wallpaper-preview.html`），
   但本机浏览器在这个沙箱里起不来（mojo 通道被拒），所以**我没有亲眼看过它长什么样**。
   请你打开那个 HTML 看一眼 —— 它用模拟的 WorkBuddy 界面骨架，
   能直接验证壁纸层是否落在界面之后、面板是否正常。

---

## 六、仓库内容一览

```
40 个文件 / 10075 行
├── README.md                    使用说明（含已知限制与署名）
├── LICENSE                      MIT + 各上游版权声明
├── THIRD-PARTY-NOTICES.md       四个来源的逐项署名与复用说明
├── .gitattributes               行尾与二进制策略（有注释解释为什么这么写）
├── .gitignore                   状态/缓存/日志/预览产物不入库
├── package.json                 零依赖
├── src/                         11 个模块 + 1 个注入脚本分片
├── vendor/webwallgl/            952,624 字节，sha256 已记录
├── tools/repkg/                 RePKG 0.4.0 + 上游许可全文
├── scripts/                     install.ps1 / lint-inject.mjs / make-preview.mjs / 真机探针
├── test/                        9 个测试套件 + 1 个 walk 辅助
└── docs/
    ├── ARCHITECTURE.md          分层、幂等模型、守护、Scene 渐进增强、性能纪律
    ├── PITFALLS.md              52 条踩坑记录（症状 / 原因 / 对策）
    └── WORKBUDDY-DOM.md         对 WorkBuddy 5.7.6 的实测事实与遮蔽层清单
```
