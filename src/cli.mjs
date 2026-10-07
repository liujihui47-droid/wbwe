#!/usr/bin/env node
/**
 * workbuddy-wallpaper-engine 命令行入口。
 *
 * 子命令：
 *   we list              盘点本机 Wallpaper Engine 壁纸库
 *   we extract [--force] 用内置 RePKG 把 scene 壁纸解出高清贴图（可选能力）
 *   apply                把壁纸注入正在运行的 WorkBuddy
 *   remove               卸载注入（回到原生外观）
 *   status               查询当前注入状态
 *   launch               启动 WorkBuddy（带调试端口）并注入
 *   guard                常驻守护：让之后新建的窗口也自动带上壁纸
 *   doctor               环境自检（找 exe / 端口 / WE 库 / RePKG / WebWallGL）
 *
 * 设计原则：**零 npm 依赖**，git clone 下来就能跑。
 */

import process from "node:process";

import { DEFAULT_CDP_PORT } from "./platform/workbuddy.mjs";
import { findWorkBuddyExe, findBundledNode, isWorkBuddyRunning, portForExe, processNameFor, resolveStatePaths } from "./platform/workbuddy.mjs";
import { scanWeLibrary } from "./we-library.mjs";
import { extractAllSceneItems, readCachedExtract, resolveRepkg } from "./we-extract.mjs";
import { appendLog, probeStateDir, readState, writeState } from "./state.mjs";
import { applyWallpaper, buildInjectScript, removeWallpaper, wallpaperStatus } from "./injector.mjs";
import { humanSize } from "./util.mjs";

const USAGE = `workbuddy-wallpaper-engine

用法：node src/cli.mjs <命令> [选项]

命令
  we list                 盘点本机 Wallpaper Engine 壁纸库
  we extract [--force]    解出 scene 壁纸的高清贴图（可选，需内置 RePKG）
  apply                   注入壁纸到正在运行的 WorkBuddy
  remove                  卸载注入
  status                  查询注入状态
  launch [--port N]       启动 WorkBuddy（带调试端口）并注入
  guard  [--port N]       常驻守护：让之后新建的窗口也自动带上壁纸
  doctor                  环境自检

通用选项
  --port <N>         CDP 调试端口（默认按版本推断：国内版 9334 / 国际版 9333）
  --exe <路径>       WorkBuddy 主程序路径（默认自动发现）
  --prefer cn|intl   两版本都装时优先哪个
  --json             以 JSON 输出（便于脚本消费）
  --help             显示本帮助
`;

// ---------------------------------------------------------------------------
// 参数解析（手写，不引依赖）
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const eq = name.indexOf("=");
      if (eq >= 0) {
        out.flags[name.slice(0, eq)] = name.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out.flags[name] = next;
        i += 1;
      } else {
        out.flags[name] = true;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

function parseIntFlag(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function out(json, payload, textFn) {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else textFn();
}

/**
 * 把写状态失败的原因讲清楚（不打断命令）。
 *
 * 状态持久化只是"记住选择"，核心功能是注入 —— 所以这里只提示，不报错。
 */
function warnWriteError(state, json) {
  const error = state?.__writeError;
  if (!error || json) return;
  process.stderr.write(
    `\n提示：状态没能写入磁盘（${error.code ?? ""} ${error.message}）。\n` +
      `      壁纸会照常注入，但"记住选中项 / 可调项"本次会话后可能丢失。\n` +
      `      如需换位置：设环境变量 WBWE_STATE_DIR 指向可写目录。\n`,
  );
}

/**
 * 决定这次操作用哪个端口 / exe。
 *
 * 优先级：显式 `--port` > 由 exe 推断 > 默认值。
 * 显式给了 exe 就不再去发现（用户可以指向绿色版 / 多版本并存的其中之一）。
 */
async function resolveTarget(flags, { needRunning = false } = {}) {
  const paths = resolveStatePaths();
  const exe = flags.exe ? String(flags.exe) : await findWorkBuddyExe({ prefer: flags.prefer ? String(flags.prefer) : "" });
  const port = parseIntFlag(flags.port, exe ? portForExe(exe) : DEFAULT_CDP_PORT);
  const running = exe ? await isWorkBuddyRunning(exe) : null;
  if (needRunning && running === false) {
    const name = exe ? processNameFor(exe) : "WorkBuddy";
    const error = new Error(
      `WorkBuddy 没有在运行（进程 ${name}）。\n` +
        `若要以调试模式接管，需要先完全退出再启动：\n` +
        `  node src/cli.mjs launch\n` +
        `注意：WorkBuddy 带进程保护，本工具**无法**结束它；请从托盘图标右键退出。`,
    );
    error.code = "NOT_RUNNING";
    throw error;
  }
  return { exe, port, running, paths };
}

// ---------------------------------------------------------------------------
// we list / we extract
// ---------------------------------------------------------------------------

async function cmdWeList(flags, json) {
  const scan = await scanWeLibrary({ withSize: !flags["no-size"] });
  const payload = {
    libraries: scan.libraries,
    contentDirs: scan.contentDirs.map((d) => ({ kind: d.kind, dir: d.dir })),
    stats: scan.stats,
    items: scan.items.map((i) => ({
      id: i.id,
      title: i.title,
      kind: i.kind,
      renderable: i.renderable,
      rating: i.rating,
      sizeMB: Math.round(((i.sizeBytes ?? 0) / 1048576) * 10) / 10,
      hasPreview: Boolean(i.previewUrl),
    })),
    errors: scan.errors,
  };

  out(json, payload, () => {
    process.stdout.write(`Steam 库（${scan.libraries.length}）：\n`);
    for (const lib of scan.libraries) process.stdout.write(`  ${lib}\n`);
    process.stdout.write(`\nWE 内容目录（${scan.contentDirs.length}）：\n`);
    for (const d of scan.contentDirs) process.stdout.write(`  [${d.kind}] ${d.dir}\n`);

    process.stdout.write(`\n共 ${scan.stats.total} 条，其中可渲染 ${scan.stats.renderable} 条`);
    process.stdout.write(`，总体积 ${humanSize(scan.stats.totalBytes)}\n`);
    process.stdout.write(`按类型：${JSON.stringify(scan.stats.byKind)}\n\n`);

    const pad = (s, n) => String(s).padEnd(n, " ");
    for (const item of scan.items) {
      process.stdout.write(
        `  ${pad(item.kind, 11)} ${pad(item.renderable ? "OK" : "--", 3)} ${pad(item.id, 12)} ${pad(
          humanSize(item.sizeBytes),
          9,
        )} ${item.title}\n`,
      );
    }
    if (scan.errors.length) {
      process.stdout.write(`\n有 ${scan.errors.length} 条读取失败：\n`);
      for (const e of scan.errors.slice(0, 10)) process.stdout.write(`  ${e.dir}: ${e.message}\n`);
    }
  });
  return payload;
}

async function cmdWeExtract(flags, json) {
  const repkg = resolveRepkg();
  const paths = resolveStatePaths();
  if (!repkg) {
    const message =
      "找不到内置的 RePKG（tools/repkg/RePKG.exe）。\n" +
      "scene 壁纸的高清贴图提取是**可选能力**：没有它仍可用工坊预览图当静态兜底，\n" +
      "也可以用 WebWallGL 做实时渲染。若想要 4K 静态贴图，请确认 tools/repkg/RePKG.exe 存在。";
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, reason: "no-repkg" }, null, 2)}\n`);
    else process.stdout.write(`${message}\n`);
    process.exitCode = 1;
    return null;
  }

  const scan = await scanWeLibrary({ withSize: false });
  const scenes = scan.items.filter((i) => i.kind === "scene" && i.pkgPath);
  if (!json) {
    process.stdout.write(`RePKG：${repkg}\n`);
    process.stdout.write(`待处理的 scene 壁纸：${scenes.length} 条\n`);
    process.stdout.write(`缓存目录：${paths.cacheRoot}\n\n`);
  }

  const results = await extractAllSceneItems(scan.items, {
    repkgPath: repkg,
    cacheRoot: paths.cacheRoot,
    overwrite: Boolean(flags.force),
    onProgress: ({ index, total, item }) => {
      if (!json) process.stdout.write(`  [${index + 1}/${total}] ${item.title}\n`);
    },
  });

  const ok = results.filter((r) => r.ok);
  const cached = ok.filter((r) => r.cached).length;
  const failed = results.filter((r) => !r.ok);

  out(json, { ok: true, total: results.length, extracted: ok.length - cached, cached, failed: failed.length, results }, () => {
    process.stdout.write(`\n成功 ${ok.length} 条（其中 ${cached} 条命中缓存），失败 ${failed.length} 条\n`);
    if (failed.length) {
      const reasons = {};
      for (const f of failed) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;
      process.stdout.write(`失败原因分布：${JSON.stringify(reasons)}\n`);
    }
  });
  return results;
}

// ---------------------------------------------------------------------------
// apply / remove / status
// ---------------------------------------------------------------------------

async function cmdApply(flags, json) {
  const { port, exe, paths } = await resolveTarget(flags);

  // 先探一下 CDP 端口，不通就**立刻**给可操作指引。
  // 不这么做的话用户要等 30 秒才拿到一句 "fetch failed" —— 那体验非常差，
  // 而且 30 秒里没有任何有用信息。
  const { isCdpReady } = await import("./launch.mjs");
  if (!(await isCdpReady(port))) {
    throw Object.assign(new Error(explainCdpError(new Error("fetch failed"), port, exe)), {
      code: "NO_CDP",
    });
  }

  // 再探状态目录，把"不可写"在动手之前讲清楚
  const probe = await probeStateDir({ paths });
  if (!probe.ok && !json) process.stderr.write(`${probe.message}\n`);

  const scan = await scanWeLibrary({ withSize: false });
  const state = await readState({ paths });

  // 用户没选过壁纸时，自动挑第一条可渲染的 —— 让"装上就能看到东西"。
  let wrote = state;
  if (!state.activeId) {
    const first = scan.items.find((i) => i.renderable);
    if (first) {
      state.activeId = first.id;
      state.activeKind = first.kind;
      wrote = await writeState(state, { paths });
      if (!json) process.stdout.write(`未选过壁纸，自动选用：${first.title}\n`);
    }
  }

  const result = await applyWallpaper({ port, paths, scan });
  out(json, { ok: true, port, stateDirWritable: probe.ok, ...result, total: scan.stats.total }, () => {
    process.stdout.write(`已注入到 ${result.applied} 个渲染进程（共发现 ${result.targets} 个 target）\n`);
    if (result.failed) process.stdout.write(`有 ${result.failed} 个 target 注入失败\n`);
    if (probe.ok) process.stdout.write(`状态文件：${paths.statePath}\n`);
    process.stdout.write(`\n提示：之后新开的窗口（例如独立设置窗口）不会自动带上壁纸，\n`);
    process.stdout.write(`      需要常驻守护：node src/cli.mjs guard --port ${port}\n`);
  });
  warnWriteError(wrote, json);
  return result;
}

async function cmdRemove(flags, json) {
  const { port, paths } = await resolveTarget(flags);
  const result = await removeWallpaper({ port, paths });
  // 顺手把状态里的选择清掉，否则下次 apply 会把旧的又装回来
  const state = await readState({ paths });
  state.activeId = null;
  state.activeKind = null;
  await writeState(state, { paths });

  out(json, { ok: true, port, ...result }, () => {
    process.stdout.write(`已从 ${result.removed} 个渲染进程卸载注入。\n`);
    process.stdout.write(`已清除保存的壁纸选择（下次 apply 会重新挑一条）。\n`);
  });
  return result;
}

async function cmdStatus(flags, json) {
  const { port, exe, running, paths } = await resolveTarget(flags);
  const state = await readState({ paths });
  let targets = [];
  let error = null;
  try {
    targets = await wallpaperStatus({ port });
  } catch (e) {
    error = explainCdpError(e, port, exe);
  }

  const payload = {
    exe,
    port,
    running,
    targets,
    error,
    state: { activeId: state.activeId, activeKind: state.activeKind, hidden: state.hidden, tunables: state.tunables },
  };

  out(json, payload, () => {
    process.stdout.write(`WorkBuddy : ${exe ?? "(未找到)"}\n`);
    process.stdout.write(`进程状态  : ${running === null ? "未知" : running ? "运行中" : "未运行"}\n`);
    process.stdout.write(`CDP 端口  : ${port}\n`);
    if (error) process.stdout.write(`CDP 连接  : 未连上\n${error}\n`);
    else {
      process.stdout.write(`命中 target: ${targets.length} 个\n`);
      for (const t of targets) {
        process.stdout.write(`  target ${t.targetId?.slice(0, 8) ?? "?"}: ${t.ok ? "已注入" : `失败(${t.error})`}\n`);
      }
    }
    process.stdout.write(`\n保存的壁纸: ${state.activeId ?? "(无)"}${state.activeKind ? ` [${state.activeKind}]` : ""}\n`);
    process.stdout.write(`隐藏状态  : ${state.hidden ? "已隐藏" : "显示中"}\n`);
  });
  return payload;
}

/**
 * 把裸的 `fetch failed` 翻译成"下一步该做什么"。
 *
 * 裸报错出现在最需要指引的时刻（WorkBuddy 没以调试模式跑 / 没启动），
 * 而它一个字都没提"你该先 launch"。这是纯粹的可用性问题，值得单独处理。
 */
function explainCdpError(error, port, exe) {
  const raw = error?.message ?? String(error);
  const isConnRefused = /fetch failed|ECONNREFUSED|连接|timeout|超时/i.test(raw);
  if (!isConnRefused) return raw;
  return (
    `  端口 ${port} 上没有可用的 CDP 端点。这通常意味着：\n` +
    `    · WorkBuddy 没有启动；或者\n` +
    `    · 它是**正常启动**的，没有带 --remote-debugging-port=${port}\n` +
    `      （WorkBuddy 已在运行时无法被接管，也无法被本工具结束 —— 它有进程保护）\n\n` +
    `  解决：\n` +
    `    1. 右键系统托盘的 WorkBuddy 图标 → 退出\n` +
    `    2. node src/cli.mjs launch\n` +
    `  （launch 会带上调试端口重新启动并自动注入）`
  );
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

async function cmdDoctor(flags, json) {
  const paths = resolveStatePaths();
  const exe = flags.exe ? String(flags.exe) : await findWorkBuddyExe({ prefer: flags.prefer ? String(flags.prefer) : "" });
  const node = await findBundledNode();
  const repkg = resolveRepkg();
  const state = await readState({ paths });

  // WebWallGL
  const wwgl = new URL("../vendor/webwallgl/webwallgl-1.4.2.global.min.js", import.meta.url);
  let wwglOk = false;
  let wwglBytes = 0;
  try {
    const st = await (await import("node:fs/promises")).stat(wwgl);
    wwglOk = true;
    wwglBytes = st.size;
  } catch {
    /* 缺失 */
  }

  // 注入脚本能否装配
  let injectOk = false;
  let injectBytes = 0;
  let injectError = null;
  try {
    const built = await buildInjectScript({ scan: { items: [] }, state, paths });
    injectOk = true;
    injectBytes = built.source.length;
  } catch (e) {
    injectError = e.message;
  }

  let scan = null;
  let scanError = null;
  try {
    scan = await scanWeLibrary({ withSize: false });
  } catch (e) {
    scanError = e.message;
  }

  const payload = {
    workbuddy: { exe, port: exe ? portForExe(exe) : null, running: exe ? await isWorkBuddyRunning(exe) : null },
    node,
    repkg,
    webwallgl: { ok: wwglOk, bytes: wwglBytes },
    injectScript: { ok: injectOk, bytes: injectBytes, error: injectError },
    wallpaperEngine: scan
      ? { total: scan.items.length, renderable: scan.stats.renderable, libraries: scan.libraries, byKind: scan.stats.byKind }
      : { error: scanError },
    statePaths: paths,
    state: { activeId: state.activeId, activeKind: state.activeKind },
  };

  out(json, payload, () => {
    const mark = (ok) => (ok ? "✓" : "✗");
    process.stdout.write("环境自检\n" + "─".repeat(60) + "\n");
    process.stdout.write(`${mark(Boolean(exe))} WorkBuddy 主程序 : ${exe ?? "未找到（设 WORKBUDDY_EXE 或 --exe）"}\n`);
    if (exe) process.stdout.write(`  CDP 端口         : ${portForExe(exe)}\n`);
    process.stdout.write(`  Node 运行时      : ${node ?? "未找到"}\n`);
    process.stdout.write(`${mark(wwglOk)} WebWallGL 1.4.2  : ${wwglOk ? `${wwglBytes} 字节` : "缺失（scene 实时渲染不可用）"}\n`);
    process.stdout.write(`${mark(Boolean(repkg))} RePKG            : ${repkg ?? "缺失（scene 高清贴图提取不可用）"}\n`);
    process.stdout.write(`${mark(injectOk)} 注入脚本装配     : ${injectOk ? `${injectBytes} 字节` : `失败 —— ${injectError}`}\n`);
    if (scan) {
      process.stdout.write(`${mark(scan.stats.total > 0)} Wallpaper Engine : ${scan.stats.total} 条（可渲染 ${scan.stats.renderable}）\n`);
      process.stdout.write(`  按类型           : ${JSON.stringify(scan.stats.byKind)}\n`);
      for (const lib of scan.libraries) process.stdout.write(`  库               : ${lib}\n`);
    } else {
      process.stdout.write(`✗ Wallpaper Engine : 盘点失败 —— ${scanError}\n`);
    }
    process.stdout.write(`\n状态目录          : ${paths.stateRoot}\n`);
    process.stdout.write(`当前壁纸          : ${state.activeId ?? "(未选择)"}\n`);
  });
  return payload;
}

// ---------------------------------------------------------------------------
// 主分发
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const json = Boolean(args.flags.json);
  const [group, sub] = args._;

  if (args.flags.help || (!group && !json)) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    if (group === "we") {
      if (sub === "extract") await cmdWeExtract(args.flags, json);
      else await cmdWeList(args.flags, json);
      return;
    }
    if (group === "apply") return void (await cmdApply(args.flags, json));
    if (group === "remove") return void (await cmdRemove(args.flags, json));
    if (group === "status") return void (await cmdStatus(args.flags, json));
    if (group === "doctor") return void (await cmdDoctor(args.flags, json));

    if (group === "launch") {
      const { launchAndInject } = await import("./launch.mjs");
      return void (await launchAndInject({ flags: args.flags, json }));
    }
    if (group === "guard") {
      const { runGuard } = await import("./guard.mjs");
      return void (await runGuard({ flags: args.flags, json }));
    }

    process.stderr.write(`未知命令：${args._.join(" ")}\n\n${USAGE}`);
    process.exitCode = 2;
  } catch (error) {
    await appendLog(`命令失败 ${args._.join(" ")}: ${error?.message}`);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error?.message, code: error?.code }, null, 2)}\n`);
    } else {
      process.stderr.write(`\n出错了：${error?.message ?? error}\n`);
    }
    process.exitCode = 1;
  }
}

await main();
