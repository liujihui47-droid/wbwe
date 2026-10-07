/**
 * 启动 WorkBuddy（带 CDP 调试端口）并注入壁纸。
 *
 * 流程：
 *   1. 找到 WorkBuddy.exe、推断 CDP 端口
 *   2. 端口已经就绪 → 直接注入（**不重启应用**）
 *   3. 否则：
 *        · 进程没在跑 → 带 `--remote-debugging-port=<port>` 启动
 *        · 进程在跑但没开端口 → **无法接管**（见下），提示用户从托盘退出
 *   4. 等 CDP 就绪 → 注入
 *   5. 起常驻守护，让之后新建的窗口也自动带上壁纸
 *
 * ⚠️ 为什么"进程在跑但没端口"时只能等：
 *    WorkBuddy 带图灵盾（TuringShield）保护，实测 `Stop-Process` / `taskkill /F` /
 *    CIM Terminate **全部被拒**（Access is denied），也读不出 `ExecutablePath`。
 *    `CloseMainWindow` 可用，但应用把 `WM_CLOSE` 当"收进托盘"，进程不退出。
 *    所以唯一出路是请用户自己右键托盘图标 → 退出。
 */

import { spawn } from "node:child_process";
import process from "node:process";

import { filterRendererTargets, fetchTargets, waitForRendererTargets } from "./cdp-client.mjs";
import { applyWallpaper, buildInjectScript } from "./injector.mjs";
import {
  DEFAULT_CDP_PORT,
  findWorkBuddyExe,
  isWorkBuddyRunning,
  portForExe,
  processNameFor,
  resolveStatePaths,
} from "./platform/workbuddy.mjs";
import { appendLog, readState, writeState } from "./state.mjs";
import { scanWeLibrary } from "./we-library.mjs";
import { retryUntil, sleep } from "./util.mjs";

/** 某个端口上是否已经有可用的 WorkBuddy 渲染进程。 */
export async function isCdpReady(port, { timeoutMs = 3000 } = {}) {
  try {
    const targets = await fetchTargets(port, { timeoutMs });
    // 要求确实出现 page 型 target —— 只有端口开着但没页面不算就绪。
    return targets.some((t) => t.type === "page");
  } catch {
    return false;
  }
}

/** 端口上有几个**渲染进程**（用于判断注入会命中几个窗口）。 */
export async function countRendererTargets(port) {
  try {
    const targets = await fetchTargets(port, { timeoutMs: 3000 });
    return filterRendererTargets(targets).length;
  } catch {
    return 0;
  }
}

/**
 * 启动 WorkBuddy（detached，父进程退出不带走它）。
 *
 * 唯一需要的参数就是调试端口 —— 不要加 `--user-data-dir` 之类，
 * 那会让它读不到用户原有配置（表现为"登录态丢了"）。
 */
function spawnWorkBuddy(exe, port) {
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    detached: true,
    // stdio 用 ignore 而不是 pipe：pipe 在受限环境里会 EPERM，而且我们也不需要它的输出。
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

/** 等 CDP 端口就绪。 */
async function waitForCdp(port, { timeoutMs = 60_000, pollMs = 500 } = {}) {
  return retryUntil(() => isCdpReady(port) || null, {
    timeoutMs,
    pollMs,
    onGiveUp: () =>
      Promise.reject(
        new Error(
          `等待 WorkBuddy 的 CDP 端口就绪超时（端口 ${port}，${Math.round(timeoutMs / 1000)}s）。\n` +
            `排查：1) WorkBuddy 是否真的启动了；2) 端口 ${port} 是否被别的程序占用；\n` +
            `      3) 是否有安全软件拦了 --remote-debugging-port。`,
        ),
      ),
  });
}

/**
 * 主入口。
 *
 * `restart` 为 true 时，如果端口的 target 数量为 0（例如 WorkBuddy 在但我们
 * 没接管成功），仍然尝试继续 —— 因为等 CDP 就绪本身会重试。
 */
export async function launchAndInject({
  flags = {},
  json = false,
  withGuard = true,
  deps = {},
} = {}) {
  const paths = resolveStatePaths();
  const findExe = deps.findWorkBuddyExe ?? findWorkBuddyExe;
  const isRunning = deps.isWorkBuddyRunning ?? isWorkBuddyRunning;
  const cdpReady = deps.isCdpReady ?? isCdpReady;
  const waitCdp = deps.waitForCdp ?? waitForCdp;
  const doSpawn = deps.spawnWorkBuddy ?? spawnWorkBuddy;
  const apply = deps.applyWallpaper ?? applyWallpaper;
  const spawnGuardFn = deps.spawnGuard ?? spawnGuard;

  const say = (line) => {
    if (!json) process.stdout.write(`${line}\n`);
  };

  // --- 1. 定位 ---
  const exe = flags.exe ? String(flags.exe) : await findExe({ prefer: flags.prefer ? String(flags.prefer) : "" });
  if (!exe) {
    throw new Error(
      "找不到 WorkBuddy 主程序。\n" +
        "请用 --exe <路径> 指定，或设置环境变量 WORKBUDDY_EXE。\n" +
        "常见位置：%LOCALAPPDATA%\\Programs\\WorkBuddy\\WorkBuddy.exe",
    );
  }
  const port = flags.port ? Number.parseInt(String(flags.port), 10) : portForExe(exe);
  const name = processNameFor(exe);
  say(`WorkBuddy : ${exe}`);
  say(`CDP 端口  : ${port}`);

  // --- 2. 端口已就绪就直接注入 ---
  if (await cdpReady(port)) {
    say("端口已就绪，直接注入（不会重启 WorkBuddy）。");
  } else {
    const running = await isRunning(exe);
    if (running) {
      // 在跑但没开端口 —— 这是最难受的一种情况，必须如实告诉用户
      say("");
      say("⚠️  WorkBuddy 正在运行，但它**不是**以调试模式启动的。");
      say("    本工具无法接管它，也无法结束它（WorkBuddy 有进程保护）。");
      say("");
      say("    请这样做：");
      say("      1. 右键系统托盘的 WorkBuddy 图标 → 退出");
      say("      2. 等窗口完全消失后，重新运行本命令");
      say("");
      const timeoutMs = flags.timeout ? Number.parseInt(String(flags.timeout), 10) * 1000 : 300_000;
      if (flags["no-wait"]) {
        throw Object.assign(new Error("WorkBuddy 在运行但未开启调试端口，且指定了 --no-wait。"), { code: "NEEDS_RESTART" });
      }
      say(`    正在等待 ${name}.exe 退出（最多 ${Math.round(timeoutMs / 1000)} 秒，Ctrl+C 取消）…`);
      await retryUntil(
        async () => ((await isRunning(exe)) ? null : true),
        { timeoutMs, pollMs: 1000 },
      );
      say("    已退出，继续启动。");
    }
    say("正在以调试模式启动 WorkBuddy…");
    doSpawn(exe, port);
    await waitCdp(port, { timeoutMs: flags.timeout ? Number.parseInt(String(flags.timeout), 10) * 1000 : 60_000 });
    say("CDP 已就绪。");
  }

  // --- 3. 确认真有渲染进程 ---
  await waitForRendererTargets(port, { timeoutMs: 30_000, pollMs: 400 }).catch(async () => {
    // 拿不到 renderer/ 命中的 target 时给出可操作的提示，而不是干巴巴的超时
    const all = await fetchTargets(port).catch(() => []);
    await appendLog(`launch: 未命中 renderer target，实际 target 数 ${all.length}`);
    throw new Error(
      `CDP 端口可连，但没有找到 WorkBuddy 的渲染进程（URL 应含 renderer/index.html）。\n` +
        `实际 target：${all.map((t) => `${t.type}:${t.url}`).join(" | ") || "(空)"}\n` +
        `WorkBuddy 可能还在启动中，稍后重试 apply 即可。`,
    );
  });

  // --- 4. 注入 ---
  // 自动挑一条可渲染的壁纸，让"第一次跑就能看到东西"
  const state = await readState({ paths });
  if (!state.activeId) {
    const scan = await scanWeLibrary({ withSize: false });
    const first = scan.items.find((i) => i.renderable);
    if (first) {
      state.activeId = first.id;
      state.activeKind = first.kind;
      await writeState(state, { paths });
      say(`未选过壁纸，自动选用：${first.title}`);
    } else {
      say("⚠️  没找到任何可渲染的 Wallpaper Engine 壁纸。");
    }
  }

  const result = await apply({ port, paths });
  say(`已注入到 ${result.applied} 个渲染进程。`);

  // --- 5. 起守护 ---
  let guardPid = null;
  if (withGuard && !flags["no-guard"]) {
    try {
      guardPid = await spawnGuardFn(port);
      say(`守护已启动（pid ${guardPid}）—— 之后新开的窗口会自动带上壁纸。`);
    } catch (error) {
      say(`守护启动失败（不影响当前注入）：${error.message}`);
      say("可以手动起：node src/cli.mjs guard");
    }
  }

  return { ok: true, exe, port, applied: result.applied, guardPid };
}

// ---------------------------------------------------------------------------
// 守护进程的启动与存活判断
// ---------------------------------------------------------------------------

/** 守护的 pid 文件路径（按端口区分，两版本并存时互不干扰）。 */
export function guardPidPath(port, { paths = resolveStatePaths() } = {}) {
  return `${paths.stateRoot}/guard-${port}.pid`;
}

/** 读守护 pid（没有或已死返回 null）。 */
export async function readGuardPid(port, { paths = resolveStatePaths() } = {}) {
  const fsp = await import("node:fs/promises");
  try {
    const raw = await fsp.readFile(guardPidPath(port, { paths }), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid)) return null;
    // 进程是否还活着（kill(pid, 0) 只探测，不真的发信号）
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/** 以脱离的子进程方式启动守护。 */
export async function spawnGuard(port, { paths = resolveStatePaths() } = {}) {
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const existing = await readGuardPid(port, { paths });
  if (existing) return existing;

  await fsp.mkdir(paths.stateRoot, { recursive: true });
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");
  const child = spawn(process.execPath, [cli, "guard", "--port", String(port)], {
    detached: true,
    // ignore 而不是 pipe：pipe 在受限环境会 EPERM，且守护的日志自己写文件
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  await appendLog(`guard 已启动 pid=${child.pid} port=${port}`, { paths });
  return child.pid;
}

export { isCdpReady as cdpReady, sleep, buildInjectScript, DEFAULT_CDP_PORT };
