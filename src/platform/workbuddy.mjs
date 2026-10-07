/**
 * WorkBuddy 安装位置与运行时解析（Windows 优先，其它平台优雅降级）。
 *
 * 这个模块是**路径解析的唯一真源** —— 不要在任何别处再抄一遍候选列表。
 *
 * 为什么不用「从运行中的进程反推 exe 路径」：WorkBuddy 带图灵盾（TuringShield）
 * 保护，实测 `Win32_Process.ExecutablePath` 与 `tasklist` 都读不出路径，留着那条路
 * 只会白起一个子进程。所以老老实实用「显式指定 → 常见位置 → 注册表卸载项」。
 *
 * 解析顺序：
 *   1. 调用方显式指定（`extra`）或环境变量 `WORKBUDDY_EXE` —— 换盘、绿色版、多版本并存
 *   2. 常见安装位置 —— 覆盖绝大多数机器，且**完全不需要起子进程**
 *   3. 注册表卸载项 —— 换盘重装后只有这里跟得住（DisplayIcon 指向真实路径）
 *
 * ⚠️ 第 3 步依赖 `reg.exe` 子进程。在禁用子进程的环境里它会失败 —— 因此
 *    整个函数保证**只返回候选里真实存在的那个**，把失败降级成"少一条线索"。
 */

import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 主程序名。国内版 `WorkBuddy.exe`，国际版 `WorkBuddyAI.exe`。 */
export const EXE_NAMES = ["WorkBuddy.exe", "WorkBuddyAI.exe"];

/**
 * CDP 调试端口。两个版本各走各的，避免同时装了两版时互相抢端口。
 *
 * ⚠️ 这不是"随便挑一个"—— 必须固定，因为我们要用 `--remote-debugging-port=<port>`
 *    启动 WorkBuddy，然后回连同一端口。用随机端口就只能靠命令行回读，而
 *    WorkBuddy 的命令行读不出来（见文件头注释）。
 */
export const PORT_BY_LEAF = { workbuddy: 9334, workbuddyai: 9333 };
export const DEFAULT_CDP_PORT = 9333;

/** renderer target 的 URL 特征。只有命中它的 target 才注入。 */
export const RENDERER_URL_HINT = "renderer/index.html";

/**
 * 本项目在用户目录下的状态根（与 WorkBuddy 自身数据分开，便于整体卸载）。
 *
 * 可用 `WBWE_STATE_DIR` 覆盖 —— 这不是可选项而是**必需品**：
 * 在受限环境（沙箱、只读配置、企业策略）里 `%LOCALAPPDATA%` 可能不可写，
 * 没有这条逃生通道时插件会直接崩在"建目录失败"上，而真正的壁纸功能
 * 其实一行都还没用到那个目录。
 */
export function resolveStatePaths({ home = os.homedir(), env = process.env } = {}) {
  const isWin = process.platform === "win32";
  const override = env.WBWE_STATE_DIR;
  const stateRoot =
    override ||
    (isWin
      ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "WorkBuddyWallpaperEngine")
      : path.join(home, "Library", "Application Support", "WorkBuddyWallpaperEngine"));
  return {
    stateRoot,
    statePath: path.join(stateRoot, "state.json"),
    logPath: path.join(stateRoot, "injector.log"),
    cacheRoot: path.join(stateRoot, "cache"),
    installRoot: path.join(home, ".workbuddy", "workbuddy-wallpaper-engine"),
    overridden: Boolean(override),
  };
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

/**
 * 常见安装位置。
 *
 * `workbuudy`（少一个 d）是**真实存在过的历史目录名**，别当错别字删掉 ——
 * 老版本装的就是那个路径，删了会让老用户找不到程序。
 */
export function wellKnownPaths(env = process.env) {
  const out = [];
  const bases = [env.LOCALAPPDATA, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData].filter(Boolean);
  const subs = ["WorkBuddy", "workbuddy", "Programs\\WorkBuddy", "Programs\\workbuddy", "WorkBuddyAI", "workbuudy\\WorkBuddyAI"];
  for (const base of bases) {
    for (const sub of subs) {
      for (const name of EXE_NAMES) pushUnique(out, path.join(base, sub, name));
    }
  }
  return out;
}

/**
 * 从注册表卸载项解析主程序路径。
 *
 * 三种值的形状完全不同，必须分别处理：
 *   DisplayIcon     = `D:\Apps\WorkBuddy\WorkBuddy.exe,0`   → exe + 图标序号
 *   InstallLocation = `D:\Apps\WorkBuddy`                    → 目录
 *   UninstallString = `"D:\...\Uninstall WorkBuddy.exe" /currentuser` → 卸载器，**不能用**
 *
 * ⚠️ 绝不能把 UninstallString 里的 exe 当候选直接启动 —— 那是卸载程序，
 *    拿它启动会弹出卸载向导，属于灾难性错误。所以这里统一"取所在目录 + 拼主程序名"。
 */
async function registryPaths(env = process.env) {
  if (process.platform !== "win32") return [];
  let execFile;
  try {
    ({ execFile } = await import("node:child_process"));
  } catch {
    return [];
  }

  const keys = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];

  const out = [];
  for (const key of keys) {
    const raw = await new Promise((resolve) => {
      try {
        execFile("reg.exe", ["query", key, "/s", "/f", "WorkBuddy", "/d"], { windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => {
          resolve(err ? null : String(stdout ?? ""));
        })?.on?.("error", () => resolve(null));
      } catch {
        // 受限环境里 execFile 会直接抛 EPERM：注册表只是第三条线索，跳过即可。
        resolve(null);
      }
    });
    if (!raw) continue;

    for (const line of raw.split(/\r?\n/)) {
      // 抓行尾的绝对路径（可带 `,0` 图标序号），忽略值名与类型。
      const m = line.match(/([A-Za-z]:\\[^"\r\n]*?)(?:,0)?\s*$/);
      if (!m) continue;
      let value = m[1].trim().replace(/^"|"$/g, "");
      if (/\.exe$/i.test(value)) value = value.slice(0, value.lastIndexOf("\\"));
      if (!value) continue;
      for (const name of EXE_NAMES) pushUnique(out, path.join(value, name));
    }
  }
  return out;
}

/** 所有候选路径，按信任度排序（可能不存在）。 */
export async function workbuddyCandidates({ extra = "", env = process.env } = {}) {
  const out = [];
  pushUnique(out, extra);
  pushUnique(out, env.WORKBUDDY_EXE);
  for (const p of wellKnownPaths(env)) pushUnique(out, p);
  for (const p of await registryPaths(env)) pushUnique(out, p);
  return out;
}

/**
 * 找到真实存在的主程序。
 *
 * `prefer` 为 "cn" / "intl" 时优先对应版本；这种偏好是**软偏好** ——
 * 用户只装了一版时，偏好不该导致找不到。
 */
export async function findWorkBuddyExe({ extra = "", prefer = "", env = process.env } = {}) {
  const candidates = await workbuddyCandidates({ extra, env });
  if (prefer) {
    const want = (prefer === "cn" ? "WorkBuddy.exe" : "WorkBuddyAI.exe").toLowerCase();
    const hit = candidates.find((p) => path.basename(p).toLowerCase() === want && exists(p));
    if (hit) return hit;
  }
  return candidates.find((p) => exists(p)) ?? null;
}

/** 由 exe 路径推出该版本对应的 CDP 端口。 */
export function portForExe(exePath) {
  if (!exePath) return DEFAULT_CDP_PORT;
  return PORT_BY_LEAF[path.basename(exePath, ".exe").toLowerCase()] ?? DEFAULT_CDP_PORT;
}

/** 由 exe 路径推出进程名（不带 .exe），用于检测"是否已在运行"。 */
export function processNameFor(exePath) {
  if (!exePath) return null;
  return path.basename(exePath, ".exe");
}

/**
 * 找 WorkBuddy 自带的 Node（国际版 `~/.workbuddy-ai`，国内版 `~/.workbuddy`）。
 *
 * 用途：安装脚本/守护进程需要一个**确定存在**的 Node 来跑，而用户机器上不一定
 * 装了系统 Node。WorkBuddy 自己带了一个，直接用它最省事。
 */
export async function findBundledNode({ env = process.env, home = os.homedir() } = {}) {
  // 先看 PATH 里有没有系统 Node（如果有，版本通常更新，优先用）。
  const which = await new Promise((resolve) => {
    import("node:child_process")
      .then(({ execFile }) => {
        try {
          execFile(process.platform === "win32" ? "where.exe" : "which", ["node"], { windowsHide: true }, (err, stdout) => {
            resolve(err ? null : String(stdout ?? ""));
          })?.on?.("error", () => resolve(null));
        } catch {
          resolve(null);
        }
      })
      .catch(() => resolve(null));
  });
  if (which) {
    const first = which.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && exists(first)) return first;
  }

  // 再找 WorkBuddy 自带的（版本号目录取字典序最大的一个）。
  for (const base of [".workbuddy-ai", ".workbuddy"]) {
    const root = path.join(env.USERPROFILE || home, base, "binaries", "node", "versions");
    if (!exists(root)) continue;
    let versions = [];
    try {
      versions = (await fsp.readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const version of versions) {
      for (const exeName of ["node.exe", "node"]) {
        const exe = path.join(root, version, exeName);
        if (exists(exe)) return exe;
      }
    }
  }
  return null;
}

/** WorkBuddy 是否正在运行（按进程名匹配，不用读 exe 路径 —— 读不出来）。 */
export async function isWorkBuddyRunning(exePath) {
  const name = processNameFor(exePath);
  if (!name) return false;
  try {
    const { execFile } = await import("node:child_process");
    const out = await new Promise((resolve) => {
      try {
        execFile("tasklist.exe", ["/FI", `IMAGENAME eq ${name}.exe`, "/NH"], { windowsHide: true }, (err, stdout) => {
          resolve(err ? null : String(stdout ?? ""));
        })?.on?.("error", () => resolve(null));
      } catch {
        resolve(null);
      }
    });
    if (out === null) return null; // 探测不了 → 未知，由调用方决定
    return /\.exe/i.test(out) && !/No tasks|没有运行/i.test(out);
  } catch {
    return null;
  }
}

/** 直接执行时当小 CLI 用：`node src/platform/workbuddy.mjs --json` */
const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (isMain) {
  const preferAt = process.argv.indexOf("--prefer");
  const prefer = preferAt >= 0 ? process.argv[preferAt + 1] : "";
  const exe = await findWorkBuddyExe({ prefer });
  const node = await findBundledNode();
  const result = {
    exe,
    node,
    port: exe ? portForExe(exe) : null,
    process: exe ? processNameFor(exe) : null,
    running: exe ? await isWorkBuddyRunning(exe) : null,
  };
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(`WorkBuddy.exe : ${exe ?? "(未找到)"}\n`);
    process.stdout.write(`node          : ${node ?? "(未找到)"}\n`);
    process.stdout.write(`CDP 端口      : ${result.port ?? "-"}\n`);
    process.stdout.write(`是否在运行    : ${result.running === null ? "未知" : result.running ? "是" : "否"}\n`);
  }
  if (!exe) process.exitCode = 1;
}
