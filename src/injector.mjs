/**
 * 注入载荷的装配。
 *
 * 分层设计（照搬上游 dsh-wallpaper-engine 的分层，理由很实在）：
 *   · `buildInjectData()` —— 纯数据，不碰 CDP
 *   · `buildInjectScript()` —— 纯文本，不碰 CDP
 *   · `applyWallpaper()` —— 才真的连 CDP 并求值
 *
 * 为什么非要拆开：守护进程必须在**新窗口诞生之前**就拿到脚本文本
 * （用 `Page.addScriptToEvaluateOnNewDocument` 预置首屏脚本）。那一刻它
 * 一个 target 都还没连上，能拿到的只有文本。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CSS_VAR_PREFIX,
  DOM_IDS,
  GLOBAL_KEY,
  GLASS_PRESETS,
  REPORT_BINDING,
  TUNABLE_SCHEMA,
} from "./constants.mjs";
import { CdpSession, evaluateOnTargets, waitForRendererTargets } from "./cdp-client.mjs";
import { readState } from "./state.mjs";
import { scanWeLibrary, toInjectionPayload } from "./we-library.mjs";
import { readCachedExtract, resolveRepkg } from "./we-extract.mjs";
import { resolveStatePaths } from "./platform/workbuddy.mjs";
import { appendLog } from "./state.mjs";
import { pathToFileURL, toFileUrl } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INJECT_DIR = path.join(HERE, "inject");
const REPO_ROOT = path.join(HERE, "..");

/** 注入脚本的分片。顺序就是执行顺序。 */
const SCRIPT_PARTS = ["wallpaper-engine.js"];

let cachedParts = null;

/**
 * 读并规范化注入分片。
 *
 * ⚠️ 两条硬约束（都是踩出来的）：
 *   1. 分片是**纯脚本文本**，不是 ES 模块 —— 出现 `import`/`export` 会在
 *      `Runtime.evaluate` 里直接语法错误。这里主动剥掉 `export `，并且**报错**
 *      而不是静默通过。
 *   2. 行尾必须是 LF。分片文件在 Windows 上是 CRLF，直接内联会让注入内容
 *      与预期字节不一致（上游实测 142072 vs 139222 字节的偏差）。
 *   3. 不许出现反引号 —— 历史上注入脚本里注释带反引号会静默截断整段脚本。
 *      本项目虽然只做字符串拼接，但仍然把这条当红线检查。
 */
export async function readInjectParts({ parts = SCRIPT_PARTS } = {}) {
  if (cachedParts && parts === SCRIPT_PARTS) return cachedParts;
  const out = [];
  for (const name of parts) {
    const file = path.join(INJECT_DIR, name);
    let text = await fsp.readFile(file, "utf8");
    text = text.replace(/\r\n?/g, "\n");
    if (/^\s*import[\s(]/m.test(text) || /\bimport\s*\(/.test(text)) {
      throw new Error(`注入分片 ${name} 含 import —— 它必须能在 Runtime.evaluate 里直接跑`);
    }
    if (/^\s*export\s/m.test(text)) {
      throw new Error(`注入分片 ${name} 含 export —— 注入脚本不是模块`);
    }
    if (text.includes("`")) {
      // 不是拼接会坏，而是这条红线值得每次都拦一次：历史上它是静默截断的元凶。
      throw new Error(`注入分片 ${name} 含反引号 —— 注入脚本里禁止反引号（会静默截断）`);
    }
    out.push(text.replace(/\n+$/, ""));
  }
  const joined = out.join("\n\n");
  if (parts === SCRIPT_PARTS) cachedParts = joined;
  return joined;
}

/** 只做语法体检，不执行。调 `new Function` 是最省事且最接近真实求值环境的检查。 */
export function lintScript(source) {
  try {
    // eslint-disable-next-line no-new-func
    new Function(source);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error?.message ?? String(error) };
  }
}

/**
 * 把库存条目规整成注入用的精简形状。
 *
 * ⚠️ 这个函数**幂等**，而且必须幂等 —— 踩过的坑：`scanWeLibrary()` 的原始结果里
 * 字段叫 `previewPath` / `mediaPath`，而 `toInjectionPayload()` 产出的是
 * `previewUrl` / `fileUrl`。如果再对**已经规整过**的条目跑一次
 * `toInjectionPayload()`，它会去读不存在的 `previewPath` → 全部变成 `null`
 * → 面板里所有缩略图消失、所有视频都没有 src。
 *
 * 判据：原始条目带文件系统字段（`previewPath` / `mediaPath` / `pkgPath` /
 * `webIndexPath`），规整过的只带 `file://` 字段。
 */
function looksLikeRawScanItem(item) {
  return Boolean(item) && ("previewPath" in item || "mediaPath" in item || "pkgPath" in item || "webIndexPath" in item);
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (looksLikeRawScanItem(items[0])) return toInjectionPayload(items);
  // 已经规整过：原样返回（但补上 heroUrl 字段，保证形状统一）
  return items.map((item) => ({ heroUrl: null, ...item }));
}

/**
 * 组装注入数据。
 *
 * ⚠️ 原则：**只传路径与标题，绝不传字节**。WE 素材单体可达 621MB，
 *    塞进 CDP 消息会直接爆掉；而渲染进程本身就是 `file://` 页面，
 *    可以直接 `<video src="file:///…">` / `fetch(file://…)` 读本机文件。
 */
export async function buildInjectData({
  scan,
  state = null,
  paths = resolveStatePaths(),
  repkgPath = undefined,
  cacheRoot = null,
} = {}) {
  const resolvedState = state ?? (await readState({ paths }));
  const cache = cacheRoot ?? paths.cacheRoot;

  // 给 scene 条目补上"解出来的高清贴图"（只读缓存，**不触发解包**）。
  // 解包是后台预热的活，注入路径必须快。
  const items = await Promise.all(
    normalizeItems(scan.items).map(async (item) => {
      if (item.kind !== "scene" || !item.pkgUrl) return { ...item, heroUrl: null };
      const cached = await readCachedExtract(item.id, { cacheRoot: cache });
      return { ...item, heroUrl: cached?.heroPath ? toFileUrl(cached.heroPath) : null };
    }),
  );

  const repkg = repkgPath === undefined ? resolveRepkg({ root: REPO_ROOT }) : repkgPath;
  const wwglPath = path.join(REPO_ROOT, "vendor", "webwallgl", "webwallgl-1.4.2.global.min.js");
  let wwglUrl = null;
  try {
    await fsp.access(wwglPath);
    wwglUrl = pathToFileURL(wwglPath).href;
  } catch {
    /* 没有 vendored 副本 → 保留静态图降级，scene 不出动效 */
  }

  return {
    items,
    state: resolvedState,
    ids: DOM_IDS,
    globalKey: GLOBAL_KEY,
    reportBinding: REPORT_BINDING,
    cssVarPrefix: CSS_VAR_PREFIX,
    tunableSchema: TUNABLE_SCHEMA,
    glassPresets: GLASS_PRESETS,
    wwglUrl,
    repkgAvailable: Boolean(repkg),
    ext: {
      // 仅供面板显示"能不能升级到 4K"
      sceneTotal: items.filter((i) => i.kind === "scene").length,
      sceneWithHero: items.filter((i) => i.kind === "scene" && i.heroUrl).length,
    },
  };
}

/**
 * 产出一整段可被 `Runtime.evaluate` 执行的表达式。
 *
 * 外层包裹负责等 `document.body`：`Page.addScriptToEvaluateOnNewDocument` 注册的
 * 脚本跑在"文档创建点"，那时 `<head>`/`<body>` 都还不存在 —— 直接跑必抛
 * `TypeError`，而且**症状极阴**：注册返回成功、日志无错误、重载后页面干干净净。
 */
export async function buildInjectScript(options = {}) {
  const data = await buildInjectData(options);
  const body = await readInjectParts();
  const payload = JSON.stringify(data);

  // 注意：这里用**字符串拼接**而不是模板字面量，所以分片里的任何反斜杠、
  // 美元符号都不会被二次解释（上游踩过"模板字面量吃掉一层转义"）。
  const source = [
    "(function(){",
    "  var data = " + payload + ";",
    "  var boot = function(){",
    body
      .split("\n")
      .map((line) => (line ? "    " + line : line))
      .join("\n"),
    "  };",
    "  if (document.body) { boot(); return 'applied'; }",
    "  var done = false;",
    "  var run = function(){ if (done) return; if (!document.body) return; done = true; try { boot(); } catch (e) { console.error('[wbwe] 引导失败：', e); } };",
    "  var mo = new MutationObserver(run);",
    "  mo.observe(document.documentElement || document, { childList: true, subtree: true });",
    "  document.addEventListener('DOMContentLoaded', run, { once: true });",
    "  setTimeout(function(){ try { mo.disconnect(); } catch (e) {} run(); }, 15000);",
    "  return 'waiting-for-body';",
    "})()",
  ].join("\n");

  const lint = lintScript(source);
  if (!lint.ok) throw new Error(`装配出的注入脚本语法不合法：${lint.message}`);

  return { source, data };
}

/** 卸载表达式：把注入物按 id 精确清掉，并释放渲染层资源。 */
export const REMOVE_EXPRESSION = [
  "(function(){",
  "  try { var ns = window[" + JSON.stringify(GLOBAL_KEY) + "]; if (ns && typeof ns.dispose === 'function') ns.dispose(); } catch (e) {}",
  "  try { delete window[" + JSON.stringify(GLOBAL_KEY) + "]; } catch (e) { window[" + JSON.stringify(GLOBAL_KEY) + "] = undefined; }",
  "  var ids = " + JSON.stringify([DOM_IDS.layer, DOM_IDS.panel, DOM_IDS.launcher, DOM_IDS.style]) + ";",
  "  for (var i = 0; i < ids.length; i += 1) { var el = document.getElementById(ids[i]); if (el && el.parentNode) el.parentNode.removeChild(el); }",
  "  return 'removed';",
  "})()",
].join("\n");

/** 状态探测表达式。 */
export const STATUS_EXPRESSION = [
  "(function(){",
  "  var ns = window[" + JSON.stringify(GLOBAL_KEY) + "];",
  "  var layer = document.getElementById(" + JSON.stringify(DOM_IDS.layer) + ");",
  "  return {",
  "    injected: Boolean(layer),",
  "    style: Boolean(document.getElementById(" + JSON.stringify(DOM_IDS.style) + ")),",
  "    panel: Boolean(document.getElementById(" + JSON.stringify(DOM_IDS.panel) + ")),",
  "    video: layer ? Boolean(layer.querySelector('video')) : false,",
  "    scene: layer ? Boolean(layer.querySelector('[data-wbwe-scene]')) : false,",
  "    state: ns && typeof ns.getState === 'function' ? ns.getState() : null,",
  "  };",
  "})()",
].join("\n");

/**
 * 对当前所有渲染 target 应用壁纸。
 *
 * `expression` 可复用以避免重复装配（守护进程会缓存它）。
 * 不给 `expression` 时，这里会自己盘点 WE 库并装配 —— 但**库里没有条目时
 * 只是把壁纸层清空**，不会去猜用户想要哪一条（选哪条是 CLI / 状态文件的职责）。
 */
export async function applyWallpaper({
  port,
  expression = null,
  scan = null,
  timeoutMs = 30_000,
  pollMs = 400,
  paths = resolveStatePaths(),
  deps = {},
} = {}) {
  const build = deps.buildInjectScript ?? buildInjectScript;
  const wait = deps.waitForRendererTargets ?? waitForRendererTargets;
  const evaluate = deps.evaluateOnTargets ?? evaluateOnTargets;
  const SessionClass = deps.CdpSession ?? CdpSession;
  const doScan = deps.scanWeLibrary ?? scanWeLibrary;

  let script = expression;
  if (!script) {
    // ⚠️ 装配脚本需要库存条目（面板的网格、scene 的 pkg 地址都来自它）。
    //    这里必须自己扫一遍 —— 早期版本忘了传，症状是注入成功但面板里
    //    一条壁纸都没有，而 apply 却报"成功"。
    const resolvedScan = scan ?? (await doScan({ withSize: false }));
    script = (await build({ scan: resolvedScan, paths })).source;
  }

  const targets = await wait(port, { timeoutMs, pollMs });
  const results = await evaluate(targets, script, { SessionClass, timeoutMs: 120_000 });

  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  await appendLog(
    `apply port=${port} targets=${targets.length} ok=${ok} failed=${failed.length}` +
      (failed.length ? ` first=${failed[0].error}` : ""),
    { paths },
  );

  if (ok === 0) {
    const detail = failed.length ? failed[0].error : "没有命中任何渲染进程";
    throw new Error(`注入失败：${detail}`);
  }
  return { applied: ok, failed: failed.length, targets: targets.length, results };
}

/** 卸载壁纸。 */
export async function removeWallpaper({ port, timeoutMs = 5_000, paths = resolveStatePaths(), deps = {} } = {}) {
  const fetchTargets = deps.fetchTargets ?? (await import("./cdp-client.mjs")).fetchTargets;
  const filter = deps.filterRendererTargets ?? (await import("./cdp-client.mjs")).filterRendererTargets;
  const evaluate = deps.evaluateOnTargets ?? evaluateOnTargets;
  const SessionClass = deps.CdpSession ?? CdpSession;

  const targets = filter(await fetchTargets(port, { timeoutMs }));
  const results = await evaluate(targets, REMOVE_EXPRESSION, { SessionClass, timeoutMs });
  await appendLog(`remove  port=${port} targets=${targets.length} ok=${results.filter((r) => r.ok).length}`, { paths });
  return { removed: results.filter((r) => r.ok).length, results };
}

/** 查询当前注入状态。 */
export async function wallpaperStatus({ port, timeoutMs = 5_000, deps = {} } = {}) {
  const fetchTargets = deps.fetchTargets ?? (await import("./cdp-client.mjs")).fetchTargets;
  const filter = deps.filterRendererTargets ?? (await import("./cdp-client.mjs")).filterRendererTargets;
  const evaluate = deps.evaluateOnTargets ?? evaluateOnTargets;
  const SessionClass = deps.CdpSession ?? CdpSession;

  const targets = filter(await fetchTargets(port, { timeoutMs }));
  return evaluate(targets, STATUS_EXPRESSION, { SessionClass, timeoutMs });
}

export { REPO_ROOT, INJECT_DIR };
