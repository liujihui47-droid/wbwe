/**
 * 状态的读写与迁移。
 *
 * 状态文件（`state.json`）是宿主与渲染进程之间的**唯一真源**：
 *   · 宿主读它来决定注入哪些壁纸、用哪套可调项（`apply` 时作为初始提示）
 *   · 渲染进程在用户改设置时写它（通过 CDP binding 回传，或退化成本地 localStorage）
 *
 * 为什么还要 localStorage 兜底：CDP binding 只在守护进程在场时可用。用户
 * 手动跑一次 `apply` 就退出的话，binding 不存在，此时设置至少要能在本次会话内
 * 生效并保留到下次注入 —— 所以两处都写。
 */

import fsp from "node:fs/promises";
import path from "node:path";

import { DEFAULT_TUNABLES, STATE_SCHEMA_VERSION } from "./constants.mjs";
import { resolveStatePaths } from "./platform/workbuddy.mjs";

/** 全新状态。 */
export function defaultState() {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    /** 当前选中的壁纸条目 id（null = 不显示壁纸，回到原生外观）。 */
    activeId: null,
    /** 当前选中条目的类型（省得每次注入都去库里反查）。 */
    activeKind: null,
    /** 可调项。 */
    tunables: { ...DEFAULT_TUNABLES },
    /** 自动轮播间隔（分钟，0 = 关闭）。 */
    rotateMinutes: 0,
    /** 是否自动播放（视频 / scene）。 */
    autoplay: true,
    /** 是否隐藏背景（临时让壁纸不可见但保留选择）。 */
    hidden: false,
    /** 内容分级过滤。 */
    rating: "everyone",
    /** 类型过滤：允许出现在面板里的类型。 */
    enabledKinds: ["video", "scene", "web"],
    /** 上次更新时间（ISO 字符串，排查用）。 */
    updatedAt: null,
  };
}

/** 把任意读到的对象规整成合法状态（缺字段补默认、错类型丢弃）。 */
export function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") return base;

  const tunables = { ...base.tunables };
  if (raw.tunables && typeof raw.tunables === "object") {
    for (const [key, value] of Object.entries(raw.tunables)) {
      // 只接受默认值里已有的键，且类型要匹配 —— 防止旧版本/手改坏的值污染 UI。
      if (!(key in base.tunables)) continue;
      if (typeof value === typeof base.tunables[key] && Number.isFinite(value)) tunables[key] = value;
    }
  }

  const enabledKinds = Array.isArray(raw.enabledKinds)
    ? raw.enabledKinds.filter((k) => base.enabledKinds.includes(k))
    : base.enabledKinds;

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    activeId: typeof raw.activeId === "string" && raw.activeId ? raw.activeId : null,
    activeKind: typeof raw.activeKind === "string" ? raw.activeKind : null,
    tunables,
    rotateMinutes: Number.isFinite(raw.rotateMinutes) ? Math.max(0, Math.floor(raw.rotateMinutes)) : base.rotateMinutes,
    autoplay: raw.autoplay !== false,
    hidden: raw.hidden === true,
    rating: ["everyone", "questionable", "mature"].includes(raw.rating) ? raw.rating : base.rating,
    // 三种类型至少留一种，否则面板会空掉 —— 那一定是用户手改坏了。
    enabledKinds: enabledKinds.length ? enabledKinds : base.enabledKinds,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

/**
 * 迁移历史状态。
 *
 * 当前只有 v1，但入口先建好：等到改结构那天，没有这个函数的老用户
 * 会直接崩在"读到的字段不存在"上，而不是被平滑迁移。
 */
export function migrateState(raw) {
  if (!raw || typeof raw !== "object") return normalizeState(raw);
  const version = Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : 0;
  let working = raw;
  if (version < 1) {
    // v0（无版本号）→ v1：那时状态是扁平的，可调项直接挂在顶层。
    working = { ...raw, tunables: raw.tunables ?? {} };
  }
  return normalizeState(working);
}

/** 读状态；不存在或损坏都返回默认状态（绝不抛错 —— 壁纸不该因为状态文件坏了就不显示）。 */
export async function readState({ paths = resolveStatePaths() } = {}) {
  try {
    const text = await fsp.readFile(paths.statePath, "utf8");
    return migrateState(JSON.parse(text));
  } catch (error) {
    if (error?.code === "ENOENT") return defaultState();
    // 文件损坏：备份一份再重建，免得用户的设置被静默抹掉还没线索。
    try {
      await fsp.rename(paths.statePath, `${paths.statePath}.corrupt-${Date.now()}`);
    } catch {
      /* 备份失败也无所谓 */
    }
    return defaultState();
  }
}

/**
 * 原子写状态（先写临时文件再 rename，避免半个文件）。
 *
 * ⚠️ 写失败**不抛错**，而是返回 `{state, writeError}` 形状的结果说明。
 * 理由：状态的持久化只是"记住选择"，核心功能是渲染进程里的注入 ——
 * 在只读 / 受限环境里因为写不了状态文件而让整个 apply 失败，是本末倒置。
 * 调用方（CLI）会把 `writeError` 显示成一行提示，用户可以据此设 WBWE_STATE_DIR。
 */
export async function writeState(state, { paths = resolveStatePaths() } = {}) {
  const normalized = normalizeState({ ...state, updatedAt: new Date().toISOString() });
  try {
    await fsp.mkdir(path.dirname(paths.statePath), { recursive: true });
    const tmp = `${paths.statePath}.tmp-${process.pid}`;
    await fsp.writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await fsp.rename(tmp, paths.statePath);
    return normalized;
  } catch (error) {
    // 把失败原因挂到返回值上（不抛），让上层能提示而不用 try/catch 包一层
    Object.defineProperty(normalized, "__writeError", {
      value: error,
      enumerable: false,
      configurable: true,
    });
    return normalized;
  }
}

/**
 * 合并式更新：按 patch 改几个字段并落盘，返回新状态。
 *
 * `patch.tunables` 是**浅合并**（只覆盖给出的键），这样渲染进程可以只回报
 * 用户刚拖的那一个滑块，不必回传整套。
 */
export async function updateState(patch, { paths = resolveStatePaths(), current = null } = {}) {
  const base = current ?? (await readState({ paths }));
  const next = {
    ...base,
    ...patch,
    tunables: patch?.tunables ? { ...base.tunables, ...patch.tunables } : base.tunables,
  };
  return writeState(next, { paths });
}

/** 追加一行日志（排查注入失败时最关键的一手材料）。 */
export async function appendLog(line, { paths = resolveStatePaths(), maxBytes = 512 * 1024 } = {}) {
  try {
    await fsp.mkdir(path.dirname(paths.logPath), { recursive: true });
    // 简单轮转：超过上限就截断成空文件（保留最近一行很好用，但整体截断更简单可靠）。
    try {
      const stat = await fsp.stat(paths.logPath);
      if (stat.size > maxBytes) await fsp.truncate(paths.logPath, 0);
    } catch {
      /* 文件不存在就是第一次写 */
    }
    const stamp = new Date().toISOString();
    await fsp.appendFile(paths.logPath, `[${stamp}] ${line}\n`, "utf8");
  } catch {
    /* 日志写不了绝不能影响主流程 */
  }
}

/**
 * 探测状态目录能否创建 / 写入。
 *
 * 单独做成一个动作是为了**在动手之前**就把问题讲清楚：
 * 受限环境（沙箱、只读配置、企业策略）里 `%LOCALAPPDATA%` 可能不可写。
 * 之前的表现是命令直接崩在 `EPERM: mkdir ...`，而那个报错完全没提
 * "你可以设 WBWE_STATE_DIR 换个地方" —— 用户会以为插件坏了。
 */
export async function probeStateDir({ paths = resolveStatePaths() } = {}) {
  try {
    await fsp.mkdir(paths.stateRoot, { recursive: true });
    const probe = `${paths.stateRoot}/.wbwe-write-probe`;
    await fsp.writeFile(probe, "ok", "utf8");
    await fsp.unlink(probe);
    return { ok: true, stateRoot: paths.stateRoot };
  } catch (error) {
    return {
      ok: false,
      stateRoot: paths.stateRoot,
      message:
        `状态目录不可写：${paths.stateRoot}\n` +
        `原因：${error?.code ?? ""} ${error?.message ?? error}\n\n` +
        `这不影响壁纸本身的渲染，但"记住选中的壁纸 / 可调项"会失效。\n` +
        `解决办法：把状态目录指到一个可写位置，例如：\n` +
        `  $env:WBWE_STATE_DIR = "$env:TEMP\\wbwe"; node src/cli.mjs apply\n` +
        `（Linux / macOS 用 WBWE_STATE_DIR=/tmp/wbwe）`,
    };
  }
}
