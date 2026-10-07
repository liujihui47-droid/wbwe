<#
  workbuddy-wallpaper-engine 安装脚本（Windows / PowerShell）

  它做三件事：
    1. 环境自检（找 WorkBuddy / Node / Wallpaper Engine / 内置组件）
    2. 生成两个"零窗口闪现"的便捷入口（.cmd + .vbs）
    3. 可选：把入口挂到开机自启（HKCU\...\Run），用**我们自己的值名**

  ⚠️ 本文件必须保持**纯 ASCII**。
     PowerShell 5.1 读取"无 BOM 的 UTF-8"时会按 GBK 解析，中文注释会破坏语法，
     表现为一堆莫名其妙的 "Unexpected token"。提示文案一律用英文。
     这是上游项目踩过的坑，照抄它的结论。

  用法：
    powershell -ExecutionPolicy Bypass -File scripts/install.ps1
    powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Autostart
    powershell -ExecutionPolicy Bypass -File scripts/install.ps1 -Uninstall
#>

[CmdletBinding()]
param(
  # Attach the launcher to the per-user Run key so the wallpaper comes back on login.
  [switch]$Autostart,
  # Remove our shortcuts and our Run entry (does NOT touch WorkBuddy's own files).
  [switch]$Uninstall,
  # Explicit WorkBuddy.exe path (overrides auto-discovery).
  [string]$WorkBuddyExe = "",
  # Explicit CDP port.
  [int]$Port = 0,
  # Prefer the CN build (WorkBuddy.exe) or the international build (WorkBuddyAI.exe).
  [ValidateSet("", "cn", "intl")]
  [string]$Prefer = ""
)

$ErrorActionPreference = "Stop"

# --- paths -----------------------------------------------------------------

$RepoRoot = Split-Path -Parent $PSScriptRoot
$CliPath  = Join-Path $RepoRoot "src\cli.mjs"

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    OK   $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "    WARN $text" -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host "    FAIL $text" -ForegroundColor Red }

Write-Host ""
Write-Host "workbuddy-wallpaper-engine installer" -ForegroundColor White
Write-Host "repo: $RepoRoot"
Write-Host ""

if (-not (Test-Path $CliPath)) {
  Write-Err "src\cli.mjs not found - is this a full checkout? ($CliPath)"
  exit 1
}

# --- locate node -----------------------------------------------------------
# WorkBuddy ships its own Node; prefer a system Node (usually newer) but fall
# back to the bundled one so this works on machines without Node installed.

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($base in @(".workbuddy", ".workbuddy-ai")) {
    $versions = Join-Path $env:USERPROFILE "$base\binaries\node\versions"
    if (-not (Test-Path $versions)) { continue }
    $candidates = Get-ChildItem $versions -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending
    foreach ($v in $candidates) {
      $exe = Join-Path $v.FullName "node.exe"
      if (Test-Path $exe) { return $exe }
    }
  }
  return $null
}

Write-Step "Checking prerequisites"
$NodeExe = Find-Node
if ($NodeExe) { Write-Ok "node: $NodeExe" } else {
  Write-Err "No Node.js found. Install Node 22+, or let WorkBuddy install its bundled one."
  exit 1
}

# Node 22 is required for the built-in global WebSocket used by the CDP client.
$NodeVersion = (& $NodeExe --version) -replace "^v", ""
$NodeMajor = [int]($NodeVersion -split "\.")[0]
if ($NodeMajor -lt 22) {
  Write-Warn "Node $NodeVersion detected; Node 22+ is required (global WebSocket)."
  Write-Warn "WorkBuddy's bundled Node is normally 22.x."
} else {
  Write-Ok "node version: $NodeVersion"
}

# --- environment self-check (delegated to the CLI) -------------------------

Write-Step "Running environment self-check"
$doctorArgs = @($CliPath, "doctor", "--json")
if ($WorkBuddyExe) { $doctorArgs += @("--exe", $WorkBuddyExe) }
if ($Prefer)       { $doctorArgs += @("--prefer", $Prefer) }

$doctorRaw = & $NodeExe @doctorArgs 2>&1
$doctor = $null
try { $doctor = $doctorRaw | ConvertFrom-Json } catch { }

if (-not $doctor) {
  Write-Warn "Self-check produced unparsable output:"
  Write-Host ($doctorRaw -join "`n")
} else {
  if ($doctor.workbuddy.exe) {
    Write-Ok "WorkBuddy: $($doctor.workbuddy.exe)"
    if (-not $Port) { $Port = [int]$doctor.workbuddy.port }
  } else {
    # Be precise about WHY this can happen. It is not always "not installed":
    # auto-discovery reads the registry, which can be blocked under restricted
    # policies / sandboxes. The tool still works if you point it at the exe.
    Write-Warn "WorkBuddy.exe was not auto-discovered."
    Write-Warn "Usually one of: (a) WorkBuddy is not installed, (b) the registry query"
    Write-Warn "was blocked, or (c) it lives somewhere unusual."
    Write-Warn "Fix it with -WorkBuddyExe <path> or by setting WORKBUDDY_EXE."
    Write-Warn "The launcher is generated either way; it retries discovery at run time."
  }
  if ($doctor.webwallgl.ok) { Write-Ok "WebWallGL 1.4.2 bundled ($($doctor.webwallgl.bytes) bytes)" }
  else { Write-Warn "WebWallGL missing - scene wallpapers will fall back to static images." }
  if ($doctor.repkg) { Write-Ok "RePKG available" }
  else { Write-Warn "RePKG missing - no 4K static extraction for scene wallpapers." }
  if ($doctor.wallpaperEngine.total) {
    Write-Ok "Wallpaper Engine: $($doctor.wallpaperEngine.total) wallpapers ($($doctor.wallpaperEngine.renderable) renderable)"
  } else {
    Write-Warn "No Wallpaper Engine library found. Install WE and subscribe to some wallpapers."
  }
}

if (-not $Port) { $Port = 9333 }

# --- shortcuts -------------------------------------------------------------
# Two files per launcher:
#   *.cmd  - what you double-click; shows a console so errors are visible
#   *.vbs  - the same thing with NO console window (used by autostart)
#
# The .vbs rule (from upstream, learned the hard way): never use
# WScript.Shell.Exec / cmd / powershell inside it, because Exec has no
# SW_HIDE and flashes a black console window on every login.

$LauncherDir = Join-Path $env:LOCALAPPDATA "WorkBuddyWallpaperEngine"
$CmdPath = Join-Path $LauncherDir "start-wallpaper.cmd"
$VbsPath = Join-Path $LauncherDir "start-wallpaper-hidden.vbs"

if ($Uninstall) {
  Write-Step "Uninstalling"
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  foreach ($name in @("WorkBuddyWallpaperEngine")) {
    try {
      Remove-ItemProperty -Path $runKey -Name $name -ErrorAction Stop
      Write-Ok "removed Run entry: $name"
    } catch { }
  }
  foreach ($f in @($CmdPath, $VbsPath)) {
    if (Test-Path $f) { Remove-Item $f -Force; Write-Ok "removed $f" }
  }
  Write-Host ""
  Write-Host "Uninstalled. Your state file is kept at:"
  Write-Host "  $(if ($doctor) { $doctor.statePaths.stateRoot } else { '%LOCALAPPDATA%\WorkBuddyWallpaperEngine' })"
  Write-Host "Delete that folder too if you want a fully clean removal."
  exit 0
}

Write-Step "Creating launcher entries"

New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null

$portArg = if ($Port) { "--port $Port" } else { "" }
$exeArg  = if ($WorkBuddyExe) { "--exe `"$WorkBuddyExe`"" } else { "" }

$cmdContent = @"
@echo off
rem Generated by workbuddy-wallpaper-engine. Safe to delete.
rem Starts WorkBuddy with a CDP debug port and injects the wallpaper.
"$NodeExe" "$CliPath" launch $portArg $exeArg
if errorlevel 1 (
  echo.
  echo Something went wrong. Read the message above.
  echo If WorkBuddy is already running, quit it from the tray icon first.
  pause
)
"@
Set-Content -Path $CmdPath -Value $cmdContent -Encoding ASCII
Write-Ok $CmdPath

$vbsContent = @"
' Generated by workbuddy-wallpaper-engine. Safe to delete.
' Runs the launcher with NO console window (safe for autostart).
Option Explicit
Dim shell, cmd
Set shell = CreateObject("WScript.Shell")
cmd = """" & "$NodeExe" & """ """ & "$CliPath" & """ launch $portArg $exeArg"
' 0 = hidden window, False = do not wait
shell.Run cmd, 0, False
"@
Set-Content -Path $VbsPath -Value $vbsContent -Encoding ASCII
Write-Ok $VbsPath

# --- autostart -------------------------------------------------------------

if ($Autostart) {
  Write-Step "Registering autostart"
  $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
  # Use OUR OWN value name. If we reused WorkBuddy's, the two would fight:
  # WorkBuddy rewrites its own Run value back to the bare exe on every launch.
  $value = "`"$env:SystemRoot\System32\wscript.exe`" `"$VbsPath`""
  New-ItemProperty -Path $runKey -Name "WorkBuddyWallpaperEngine" -Value $value -PropertyType String -Force | Out-Null
  Write-Ok "Run entry WorkBuddyWallpaperEngine -> $VbsPath"
  Write-Warn "WorkBuddy may still start first at login. That is fine: the launcher"
  Write-Warn "detects an already-running instance and tells you to quit it from the tray."
}

# --- done ------------------------------------------------------------------

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. If WorkBuddy is running, quit it from the tray icon (it is protected -"
Write-Host "     neither this script nor the tool can terminate it)."
Write-Host "  2. Start the wallpaper with:"
Write-Host "       & '$CmdPath'"
Write-Host "     or run the CLI directly:"
Write-Host "       & '$NodeExe' '$CliPath' launch"
Write-Host "  3. Click the paint-palette button at the bottom-right of WorkBuddy to"
Write-Host "     pick a wallpaper and tune the blur / scrim / liquid-glass sliders."
Write-Host ""
Write-Host "To remove the wallpaper from the UI without quitting:"
Write-Host "  & '$NodeExe' '$CliPath' remove"
Write-Host ""
