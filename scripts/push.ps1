# push.ps1 — 把本地仓库推送到 GitHub
#
# 为什么需要认证：GitHub 的**写操作永远需要凭据**（读公开仓库不需要，所以
# `git ls-remote` 能匿名成功，会让人误以为推送也行 —— 不是的）。
#
# 认证方式的选择（实测结论，别再换回去）：
#   · `-c http.extraHeader=...` —— **不行**。这个配置属于父进程，而实际上网请求是
#     `git-remote-https` 子进程发的，它拿不到；现象是 git 转而去要 username，
#     报 "could not read Username for 'https://github.com'"。
#   · remote URL 里内嵌凭据 —— **可以**。凭据在 URL 里，子进程一定看得到。
#     本脚本用这个方式，但**只在这一次命令里用临时 URL**，
#     绝不写进 .git/config（那样令牌会留在磁盘上，还会被 `git remote -v` 显示出来）。
#
# 用法（任选一种；推荐 A 或 C —— 令牌不会进命令历史）：
#   A. $env:GH_TOKEN = "ghp_xxx"; powershell -File scripts/push.ps1 -Force
#   B. powershell -File scripts/push.ps1 -Token "ghp_xxx" -Force
#   C. 把令牌写进仓库根目录的 .gh-token（已被 .gitignore 忽略），然后：
#      powershell -File scripts/push.ps1 -Force
#
# 推完**务必**到 https://github.com/settings/tokens 撤销该令牌。

[CmdletBinding()]
param(
  [string]$Token = "",
  [string]$RepoDir = "",
  [string]$Remote = "origin",
  [string]$Branch = "main",
  # 本地与远端无共同祖先时必须 force（会覆盖远端历史）。
  [switch]$Force,
  # 只试算，不真的推。
  [switch]$DryRun,
  # 跳过推送前的测试。
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"

function Write-Step($t) { Write-Host "==> $t" -ForegroundColor Cyan }
function Write-Ok($t)   { Write-Host "    OK   $t" -ForegroundColor Green }
function Write-Warn($t) { Write-Host "    WARN $t" -ForegroundColor Yellow }
function Write-Err($t)  { Write-Host "    FAIL $t" -ForegroundColor Red }

# --- 定位仓库 ---------------------------------------------------------------
if (-not $RepoDir) { $RepoDir = Split-Path -Parent $PSScriptRoot }
if (-not (Test-Path (Join-Path $RepoDir ".git"))) {
  Write-Err "不是 git 仓库：$RepoDir"
  exit 1
}

Write-Host ""
Write-Host "wbwe push" -ForegroundColor White
Write-Host "repo   : $RepoDir"
Write-Host "remote : $Remote"
Write-Host "branch : $Branch"
Write-Host ""

# --- 取令牌 -----------------------------------------------------------------
if (-not $Token) { $Token = $env:GH_TOKEN }
if (-not $Token) { $Token = $env:GITHUB_TOKEN }
if (-not $Token) {
  $tokenFile = Join-Path $RepoDir ".gh-token"
  if (Test-Path $tokenFile) {
    $Token = (Get-Content $tokenFile -Raw).Trim()
    if ($Token) { Write-Ok "从 .gh-token 读到令牌" }
  }
}
if (-not $Token) {
  Write-Err "没有令牌。三种给法："
  Write-Host "      A. 先设 `$env:GH_TOKEN = 'ghp_xxx' 再重跑"
  Write-Host "      B. 加参数 -Token 'ghp_xxx'"
  Write-Host "      C. 把令牌写进 $RepoDir\.gh-token"
  Write-Host ""
  Write-Host "   生成： https://github.com/settings/tokens   （勾选 repo）"
  exit 1
}
if ($Token.Length -lt 20 -or $Token -match "\s") {
  Write-Err "令牌看起来不合法（长度 $($Token.Length)）"
  exit 1
}
Write-Ok "已取得令牌（长度 $($Token.Length)，内容不显示）"

# --- 解析远端 ---------------------------------------------------------------
$remoteUrl = (git -C $RepoDir remote get-url $Remote 2>$null)
if (-not $remoteUrl) { Write-Err "远端 $Remote 不存在"; exit 1 }

# 先剥掉可能存在的旧凭据，得到"干净 URL"
$cleanUrl = $remoteUrl -replace "^(https?://)[^@/]+@", '$1'
if ($cleanUrl -notmatch "^https?://") {
  Write-Err "只支持 https 远端（当前不是 https）"
  exit 1
}
Write-Ok "远端（已隐去凭据）：$cleanUrl"

$user = "liujihui47-droid"
if ($remoteUrl -match "https?://([^@/]+)@") { $user = $Matches[1] }
Write-Ok "认证用户：$user"

# 构造"带凭据"的临时 URL，只在本次命令里用
$uri = [uri]$cleanUrl
$scheme = $uri.Scheme
$hostPart = $uri.Host
$pathPart = $uri.AbsolutePath.TrimStart("/")
$authUrl = "{0}://{1}:{2}@{3}/{4}" -f $scheme, $user, $Token, $hostPart, $pathPart

# 统一出口：任何输出先抹掉令牌再打印
function Redact([string]$text) {
  if (-not $text) { return $text }
  return ($text -replace [regex]::Escape($Token), "***")
}

# --- 推送前自检 -------------------------------------------------------------
Write-Step "推送前自检"
$dirty = git -C $RepoDir status --porcelain
if ($dirty) {
  Write-Warn "工作区有未提交改动（不会被推送）："
  Write-Host (Redact $dirty)
} else {
  Write-Ok "工作区干净"
}

$commitCount = git -C $RepoDir rev-list --count $Branch 2>$null
$fileCount   = (git -C $RepoDir ls-files | Measure-Object).Count
Write-Ok "将推送 $commitCount 个 commit、$fileCount 个文件"

# --- 远端状态（预判是否需要 force）------------------------------------------
Write-Step "检查远端状态"
$remoteRev = git -C $RepoDir rev-parse "$Remote/$Branch" 2>$null
if ($remoteRev) {
  $mergeBase = git -C $RepoDir merge-base $Branch "$Remote/$Branch" 2>$null
  if (-not $mergeBase) {
    Write-Warn "本地与远端**没有共同祖先**（远端历史是独立的）"
    Write-Warn "普通 push 会被拒绝，必须用 -Force 覆盖远端历史"
    if (-not $Force) {
      Write-Host ""
      Write-Err "确认远端内容可以被覆盖后，加 -Force 重跑"
      exit 1
    }
    Write-Ok "已指定 -Force，将覆盖远端历史"
  } else {
    Write-Ok "有共同祖先，普通 push 即可"
  }
} else {
  Write-Warn "远端分支 $Branch 不存在（将新建）"
}

# --- 测试 -------------------------------------------------------------------
if (-not $SkipTests) {
  Write-Step "运行测试"
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    foreach ($b in @(".workbuddy", ".workbuddy-ai")) {
      $v = Join-Path $env:USERPROFILE "$b\binaries\node\versions"
      if (Test-Path $v) {
        $cand = Get-ChildItem $v -Directory | Sort-Object Name -Descending | Select-Object -First 1
        if ($cand) { $node = Join-Path $cand.FullName "node.exe"; break }
      }
    }
  }
  if ($node) {
    & $node (Join-Path $RepoDir "test\run-all.mjs") 2>&1 | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "测试没有全绿"
      if (-not $Force) { Write-Err "已中止（要强推加 -Force）"; exit 1 }
    } else {
      Write-Ok "测试全绿"
    }
  } else {
    Write-Warn "找不到 node，跳过测试"
  }
}

# --- 推送 -------------------------------------------------------------------
$pushArgs = @("-C", $RepoDir, "push")
if ($DryRun) { $pushArgs += "--dry-run" }
$pushArgs += @($authUrl, "$Branch`:$Branch")
if ($Force) { $pushArgs += "--force" }

if ($DryRun) { Write-Step "DryRun：只试算，不真的推送" } else { Write-Step "推送中" }

# GIT_TERMINAL_PROMPT=0：认证失败立刻报错，不要卡在交互提示上
$env:GIT_TERMINAL_PROMPT = "0"

$raw = & git -c http.sslBackend=openssl -c credential.helper= @pushArgs 2>&1 | Out-String
$code = $LASTEXITCODE

# 抹掉令牌后再显示（git 有可能把 URL 回显出来）
Write-Host (Redact $raw)

# 清掉内存里的令牌与含凭据的 URL
$authUrl = $null
$Token = $null
Remove-Item Env:\GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue

$repoUrl = "https://{0}/{1}" -f $hostPart, ($pathPart -replace "\.git$", "")

Write-Host ""
if ($code -eq 0) {
  if ($DryRun) { Write-Ok "DryRun 成功：认证可用，实际推送也应该没问题" }
  else { Write-Ok "推送成功" }
  Write-Host ""
  Write-Host "仓库： $repoUrl"
  Write-Host ""
  if (-not $DryRun) {
    Write-Host "接下来安装到 WorkBuddy：" -ForegroundColor White
    Write-Host "  git clone $repoUrl.git"
    Write-Host "  cd $($pathPart -replace '\.git$','')"
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts/install.ps1"
    Write-Host "  # 先从托盘退出 WorkBuddy，然后："
    Write-Host "  node src/cli.mjs launch"
    Write-Host ""
  }
  Write-Warn "别忘了撤销刚才用的令牌： https://github.com/settings/tokens"
} else {
  Write-Err "推送失败（exit $code）"
  Write-Host ""
  Write-Host "常见原因："
  Write-Host "  · 令牌权限不足或已过期 → 重新生成，勾选 repo"
  Write-Host "  · 细粒度令牌没勾选该仓库的写权限"
  Write-Host "  · 两边历史无关且没加 -Force"
}

exit $code
