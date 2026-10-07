# 交付说明 / 推送指引

本仓库已经在本地**完整提交**（1 个 commit，40 个文件），只差最后一步 push。

---

## 一、为什么没有自动推送

远端 `https://github.com/liujihui47-droid/workbuddy-wallpaper-engine.git` 是**私有仓库**，
而这台机器上**没有任何 GitHub 凭据**：

- 没有 `~/.git-credentials`
- 没有 `~/.ssh`
- 没有配置 credential helper
- 环境里没有 `GITHUB_TOKEN` / `GH_TOKEN`

`git ls-remote` 的返回是 `could not read Username for 'https://github.com'`
（私有仓库对未认证请求的表现），所以本地无法完成推送。

本地仓库已经配好：

```
分支    main
远端    origin -> https://github.com/liujihui47-droid/workbuddy-wallpaper-engine.git
提交    65e8ba6  feat: 初始实现 workbuddy-wallpaper-engine
```

---

## 二、推送（三选一）

### 方式 A：用 GitHub 令牌（最快）

在 https://github.com/settings/tokens 生成一个有 `repo` 权限的令牌，然后：

```powershell
cd workbuddy-wallpaper-engine

# 把 <TOKEN> 换成你的令牌。注意 URL 里带上用户名。
git remote set-url origin https://liujihui47-droid:<TOKEN>@github.com/liujihui47-droid/workbuddy-wallpaper-engine.git

git push -u origin main

# 推完把令牌从远端地址里摘掉，别留在 .git/config 里
git remote set-url origin https://github.com/liujihui47-droid/workbuddy-wallpaper-engine.git
```

### 方式 B：用 Git Credential Manager（会弹窗登录）

```powershell
cd workbuddy-wallpaper-engine
git push -u origin main
# 弹窗里登录一次，之后 git 会记住
```

如果之前为了排查把 helper 清掉了，先恢复：

```powershell
git config --global credential.helper manager
```

### 方式 C：改用 SSH

```powershell
cd workbuddy-wallpaper-engine
git remote set-url origin git@github.com:liujihui47-droid/workbuddy-wallpaper-engine.git
git push -u origin main
```

> ⚠️ 本机的 git 用了 `schannel` 后端时会报
> `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`。
> 解决办法：给这条命令加 `-c http.sslBackend=openssl`，例如
> `git -c http.sslBackend=openssl push -u origin main`
> （本地仓库已经把这个设置写进 `.git/config`，正常情况下不需要手动加。）

---

## 三、推送前建议先自己跑一遍

```powershell
cd workbuddy-wallpaper-engine
node test/run-all.mjs      # 应输出「全部通过（9 个测试套件）」
```

不需要 `npm install` —— 本项目零 npm 依赖。

---

## 四、推送之后：在真机上验证

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
