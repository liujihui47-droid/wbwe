/**
 * 共享小工具。
 *
 * 这些函数是纯逻辑（不碰文件系���之外的状态），所以能被测试直接 import。
 * 项目里其它模块一律从这里取，避免各处重复实现一遍百分号编码 —— 那是本项目
 * 最容易出错的一环（见 docs/PITFALLS.md 第 3 条）。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** 把 Windows 路径转成渲染进程能直接吃的 file:// URL。
 *
 * ⚠️ 必须用 Node 自带的 pathToFileURL：手写 `"file:///" + p` 在中文、空格、
 * `#`、`?`、`%` 上全都会翻车（本机素材实测有 `水墨山水梅花.mp4`、
 * `孤独摇滚ps最终成品.mp4`）。pathToFileURL 会做正确的百分号编码。
 */
export function toFileUrl(p) {
  if (!p) return null;
  return pathToFileURL(p).href;
}

/**
 * 修复被按错误编码解出来的**文件名**。
 *
 * 背景：创意工坊里大量中文/日文壁纸的文件名本身是 GBK 字节。Node 在 Windows 上
 * 拿到的路径字符串如果被按 UTF-8 解过，就会变成“锟斤拷”式的乱码 ——
 * 结果就是 `project.json` 里声明的 `file` 与实际文件名对不上，视频壁纸直接失效。
 *
 * 修法：把当前字符串按 latin1 拆回原始字节，再用 GB18030 解一次；只有在
 * “重解之后不再含替换字符、且确实变了”时才采用，避免误伤正常的 UTF-8 文件名。
 */
export function repairMojibakeFilename(name) {
  if (typeof name !== "string" || !name) return name;
  // 没有典型乱码特征就原样返回（绝大多数文件走这条，零开销）。
  const suspicious = /[\uFFFD]|[\u00C0-\u00FF]{2,}/.test(name);
  if (!suspicious) return name;
  try {
    const bytes = Buffer.from(name, "latin1");
    const decoded = new TextDecoder("gb18030").decode(bytes);
    if (!decoded || decoded === name) return name;
    if (/\uFFFD/.test(decoded)) return name;
    return decoded;
  } catch {
    return name;
  }
}

/**
 * 给定目录与一个可能被乱码化的文件名，找出磁盘上真实存在的路径。
 *
 * 依次尝试：原名 → 乱码修复后的名字 → 目录内大小写不敏感匹配。
 * 找不到返回 null。视频壁纸的 `project.json` 里 `file` 字段全靠它落地。
 */
export function resolveExistingFile(dir, name) {
  if (!dir || !name) return null;
  const candidates = [name];
  const repaired = repairMojibakeFilename(name);
  if (repaired !== name) candidates.push(repaired);

  for (const candidate of candidates) {
    const full = path.join(dir, candidate);
    if (fs.existsSync(full)) return full;
  }

  // 最后兜底：目录内做一次大小写不敏感匹配（磁盘上往往是 `.MP4`、`.Mp4`）。
  try {
    const target = candidates.map((c) => c.toLowerCase());
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (target.includes(entry.name.toLowerCase())) return path.join(dir, entry.name);
    }
  } catch {
    /* 目录读不了就当找不到 */
  }
  return null;
}


/** 判断给定路径是否在某个根目录下（大小写不敏感，Windows 语义）。 */export function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** 大小写不敏感 + 正斜杠归一，用作去重键。
 *
 * ⚠️ 踩过的坑：Steam 注册表里可能是 `D:/Steam`，而 libraryfolders.vdf 里是
 * `D:\Steam`，两者是同一个目录。不去重会让壁纸条目整体翻倍。
 */
export function dedupeKey(p) {
  if (!p) return "";
  // path.resolve 会处理 `..`、重复分隔符与盘符大小写归一；再统一成小写。
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

/** 对数组按 `keyFn` 去重，保留首次出现的顺序。 */
export function dedupeBy(items, keyFn = (x) => x) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 把字节数格式化成人类可读的 MB/GB。 */
export function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** 生成稳定的短 id（用于注入脚本里的 CSS 类名与状态键）。 */
export function slugify(text, fallback = "item") {
  const s = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || fallback;
}

/** 读环境变量里的整数，非法/未设置时返回 fallback。 */
export function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 把毫秒延迟包成 Promise。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 带截止时间的轮询重试。
 *
 * `fn` 返回真值即结束；超时抛错（附上最后一次的错误原因，便于定位）。
 * 本项目用它等 WorkBuddy 的 CDP 端口起来 —— 冷启动实测要几秒，不能只探一次。
 */
export async function retryUntil(fn, { timeoutMs = 20_000, pollMs = 400, onGiveUp } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const reason = lastError ? `（最后一次错误：${lastError.message}）` : "";
      const error = new Error(`等待超时 ${timeoutMs}ms${reason}`);
      if (onGiveUp) {
        try {
          const alt = await onGiveUp(error);
          if (alt !== undefined) return alt;
        } catch {
          /* 兜底路径自身失败时，仍然抛出原始超时错误 */
        }
      }
      throw error;
    }
    await sleep(pollMs);
  }
}

/** 安全地 JSON.parse：失败返回 fallback 而不是抛错。
 *
 * 用于读 `project.json` / `libraryfolders.vdf` 这类"用户机器上什么怪东西都有"的输入。
 */
export function tryJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 去掉 UTF-8 BOM。 */
export function stripBom(text) {
  return text && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export { pathToFileURL };
