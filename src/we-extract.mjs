/**
 * scene 壁纸的高清贴图提取。
 *
 * 背景：创意工坊的 scene 壁纸把素材打包在 `scene.pkg` 里，网页端没法直接当图片用。
 * 要拿到**高清静态帧**（本机实测 3840×2160，比工坊缩略图 1024×1024 的像素量高 16 倍），
 * 就得解包 —— 这里用随仓库分发的 RePKG（NativeAOT 单文件，**不需要装 .NET**）。
 *
 * 两条路线，本项目都实现：
 *   · **静态贴图**（本文件）：RePKG 解出主贴图 → 当背景图用。便宜、稳定、覆盖 100% 的 scene。
 *   · **实时渲染**（注入端的 WebWallGL）：渲染进程直接读 `scene.pkg` 字节做真渲染。
 *
 * 提取是**锦上添花**，不是必需路径：
 *   · 提取失败 → 注入端自动退到工坊缩略图，用户只是少了点清晰度
 *   · RePKG 不在（被删了/不是 Windows）→ 直接跳过，不报错阻塞
 *   · 无法起子进程的环境（例如受限沙箱）→ 同样跳过
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveStatePaths } from "./platform/workbuddy.mjs";
import { appendLog } from "./state.mjs";
import { retryUntil, sleep } from "./util.mjs";

/** 支持的图片扩展名（RePKG 解出来的主贴图一般就是 jpg/png）。 */
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tga", ".gif"]);

/** 找仓库自带的 RePKG。允许用环境变量覆盖（方便用户换更高版本）。 */
export function resolveRepkg({ root = null, env = process.env } = {}) {
  const candidates = [];
  if (env.WBWE_REPKG) candidates.push(env.WBWE_REPKG);
  if (root) candidates.push(path.join(root, "tools", "repkg", "RePKG.exe"));
  // import.meta.url 定位到仓库根：src/we-extract.mjs → ../tools/repkg/RePKG.exe
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  candidates.push(path.join(here, "..", "tools", "repkg", "RePKG.exe"));
  candidates.push(path.join(here, "..", "tools", "repkg", "repkg"));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/** 某个壁纸条目的提取缓存目录。 */
export function cacheDirFor(id, { cacheRoot = resolveStatePaths().cacheRoot } = {}) {
  return path.join(cacheRoot, String(id));
}

/** 读该条目已缓存的提取结果（含元数据）。没提取过返回 null。 */
export async function readCachedExtract(id, { cacheRoot } = {}) {
  const dir = cacheDirFor(id, { cacheRoot });
  const metaPath = path.join(dir, "meta.json");
  try {
    const meta = JSON.parse(await fsp.readFile(metaPath, "utf8"));
    if (!meta?.heroPath) return null;
    // 元数据在但图被删了 → 视为没缓存（否则注入端会拿到死链）。
    await fsp.access(meta.heroPath, fs.constants.R_OK);
    return meta;
  } catch {
    return null;
  }
}

/** 列出提取目录里的所有图片。 */
async function listImages(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    }
  }
  return out;
}

/**
 * 从解包结果里挑出"主贴图"。
 *
 * 判据（按可靠性排序）：
 *   1. `scene.json` 的 `objects[].image` 指向的贴图 —— 这是 WE 自己声明的画面主体，
 *      最可靠；本机实测它对应的就是 3840×2160 那张
 *   2. 面积最大的图片 —— 兜底，因为主贴图几乎总是分辨率最高的那张
 *
 * 为什么不用"文件最大"：线稿类壁纸的主图可能是 PNG 压缩后很小，
而噪声贴图反而更大。
 * 面积（像素数）比字节数更接近"谁是画面主体"。
 */
export async function pickHeroTexture(extractDir, { sceneJsonPath = null } = {}) {
  const images = await listImages(extractDir);
  if (!images.length) return null;

  // 路径 1：顺着 scene.json 的 objects[].image 找。
  if (sceneJsonPath) {
    try {
      const scene = JSON.parse(await fsp.readFile(sceneJsonPath, "utf8"));
      const wanted = [];
      for (const obj of scene?.objects ?? []) {
        if (typeof obj?.image === "string") wanted.push(path.basename(obj.image).toLowerCase());
      }
      if (wanted.length) {
        for (const img of images) {
          const base = path.basename(img).toLowerCase();
          const stem = base.replace(/\.[^.]+$/, "");
          if (wanted.some((w) => w === base || w.replace(/\.[^.]+$/, "") === stem)) return img;
        }
      }
    } catch {
      /* scene.json 读不了就退到路径 2 */
    }
  }

  // 路径 2：面积最大的图片。用"零依赖读图片头"拿尺寸，不引图像库。
  let best = null;
  let bestArea = -1;
  for (const img of images) {
    const size = await readImageSize(img);
    const area = size ? size.width * size.height : 0;
    // 面积拿不到（未知格式）时给一个很小的权重，保证至少能选出一个
    const score = area || 1;
    if (score > bestArea) {
      bestArea = score;
      best = img;
    }
  }
  return best;
}

/**
 * 零依赖读图片像素尺寸（只读文件头）。
 *
 * 支持 PNG / JPEG / GIF / BMP / WebP。读不出来返回 null —— 调用方用它做
 * "面积最大"排序，拿不到就退化成"第一个文件"，不算致命。
 *
 * ⚠️ 两个踩过的实现坑（都会让**小图片**静默返回 null，而大图片正常，
 *    所以很容易在真实素材上"看起来没问题"）：
 *   1. `handle.read()` 返回的 `bytesRead` 可能**小于**请求长度（文件本身很短）。
 *      不能假定读满了——短文件会被当成"文件头不足"而放弃。
 *   2. 读 JPEG 要顺序扫段，可能与初次读取重叠；**不能关掉再重开**句柄，
 *      否则后续读全失败。这里的做法是：一次性读一个足够大的窗口（含文件尾），
 *      之后所有解析都在内存里做。
 */
export async function readImageSize(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    const stat = await handle.stat();
    if (stat.size < 8) return null;

    // 读一个窗口就够：尺寸信息通常在头部几百字节内。
    // 窗口取 64 KiB 是有意的 —— JPEG 的 EXIF/APP1 段可以很大（相机原图常见几十 KB），
    // 而 SOF0 排在它后面。窗口太小会让这类文件读不到尺寸（返回 null）。
    // 代价只是一次 64 KiB 的有界读，对本项目的使用场景（几十张图排序）可忽略。
    const windowSize = Math.min(stat.size, 65536);
    const buf = Buffer.alloc(windowSize);
    const { bytesRead } = await handle.read(buf, 0, windowSize, 0);
    if (bytesRead < 8) return null;
    const head = buf.subarray(0, bytesRead);

    // PNG: 89 50 4E 47 0D 0A 1A 0A，IHDR 宽高在偏移 16/20（大端）
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
      if (head.length < 24) return null;
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    // GIF: "GIF8"，宽高在偏移 6/8（小端）
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
      if (head.length < 10) return null;
      return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
    }
    // BMP: "BM"，宽高在偏移 18/22（小端，有符号）
    if (head[0] === 0x42 && head[1] === 0x4d) {
      if (head.length < 26) return null;
      return { width: Math.abs(head.readInt32LE(18)), height: Math.abs(head.readInt32LE(22)) };
    }
    // WebP: "RIFF"..."WEBP"
    if (head.toString("ascii", 0, 4) === "RIFF" && head.length >= 30 && head.toString("ascii", 8, 12) === "WEBP") {
      if (head.toString("ascii", 12, 16) === "VP8X") {
        // 画布尺寸在偏移 24/27，24 位小端，值 = 实际尺寸 - 1
        const w = 1 + (head[24] | (head[25] << 8) | (head[26] << 16));
        const h = 1 + (head[27] | (head[28] << 8) | (head[29] << 16));
        return { width: w, height: h };
      }
      // VP8 / VP8L 变体的尺寸解析过于琐碎，不值得为它引依赖
      return null;
    }
    // JPEG: FF D8 开头，尺寸在某个 SOFn 段里
    if (head[0] === 0xff && head[1] === 0xd8) {
      return readJpegSizeFromBuffer(head);
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      await handle?.close();
    } catch {
      /* 已关 */
    }
  }
}

/**
 * 在内存里顺序扫 JPEG 段，找出 SOFn（C0–CF，排除 C4/C8/CC）里的宽高。
 *
 * 返回 `{width, height}` 或 null。找不到就返回 null（例如一张只截了前几 KB 的图）。
 */
export function readJpegSizeFromBuffer(buf) {
  if (buf.length < 4) return null;
  let offset = 2; // 跳过 SOI
  // 上限是为了防御坏文件：段长度字段若反复给出极小值可能造成死循环
  for (let guard = 0; guard < 2048; guard += 1) {
    if (offset + 4 > buf.length) return null;
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    // 填充字节 FF FF … 跳过
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 无载荷的标记（RSTn / SOI / EOI / TEM）
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) return null;
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2) return null;
    // SOFn 段里就是宽高：precision(1) height(2) width(2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    // SOS（扫描数据开始）之后就没有元数据段了，没必要继续找
    if (marker === 0xda) return null;
    offset += 2 + segLen;
  }
  return null;
}

/**
 * 用 RePKG 解包一个 scene.pkg，并把主贴图落到缓存目录。
 *
 * 返回 `{ heroPath, width, height, images, elapsedMs }`；任何不可用的情况返回
 * `{ ok: false, reason }` 而不是抛错 —— 调用方据此决定是否降级。
 *
 * ⚠️ 这里需要起子进程（RePKG.exe）。在禁用子进程的环境里 `spawn` 会 EPERM，
 *    被捕获后返回 `{ok:false, reason:"spawn-failed"}`，不影响其它功能。
 */
export async function extractScene({
  id,
  pkgPath,
  sceneJsonPath = null,
  repkgPath = null,
  cacheRoot = resolveStatePaths().cacheRoot,
  overwrite = false,
  timeoutMs = 120_000,
  deps = {},
} = {}) {
  if (!id || !pkgPath) return { ok: false, reason: "missing-input" };
  if (!repkgPath) return { ok: false, reason: "no-repkg" };

  let stat;
  try {
    stat = await fsp.stat(pkgPath);
  } catch {
    return { ok: false, reason: "pkg-missing" };
  }

  const dir = cacheDirFor(id, { cacheRoot });
  const metaPath = path.join(dir, "meta.json");

  if (!overwrite) {
    const cached = await readCachedExtract(id, { cacheRoot });
    // 缓存命中判据：pkg 没变过（大小 + 修改时间都对得上）。
    if (cached && cached.pkgBytes === stat.size && cached.pkgMtimeMs === stat.mtimeMs) {
      return { ok: true, cached: true, ...cached };
    }
  }

  const rawDir = path.join(dir, "raw");
  await fsp.mkdir(rawDir, { recursive: true });

  const started = Date.now();
  const spawnImpl = deps.spawn ?? (await import("node:child_process")).spawn;

  let child;
  try {
    child = spawnImpl(repkgPath, ["extract", "-o", rawDir, "-s", "--overwrite", pkgPath], {
      windowsHide: true,
      // stdio 用 ignore：我们不需要 RePKG 的逐文件日志，而且**管道 stdio 在受限
      // 沙箱里会直接 EPERM**，用 ignore 能让这条路在更多环境里活着。
      stdio: "ignore",
    });
  } catch (error) {
    return { ok: false, reason: "spawn-failed", detail: error?.message };
  }

  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 可能已退出 */
      }
      resolve({ code: null, timedOut: true });
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, error });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
  });

  if (exit.timedOut) return { ok: false, reason: "timeout" };
  if (exit.error || exit.code !== 0) {
    return { ok: false, reason: "repkg-failed", detail: exit.error?.message ?? `exit ${exit.code}` };
  }

  const heroSrc = await pickHeroTexture(rawDir, { sceneJsonPath });
  if (!heroSrc) return { ok: false, reason: "no-texture" };

  // 只保留一张主贴图：解包目录里可能有几十个中间贴图（本机实测单包可达数百 MB），
  // 全部留着会让缓存无限膨胀，而我们只需要一张当背景。
  const ext = path.extname(heroSrc).toLowerCase() || ".jpg";
  const heroPath = path.join(dir, `hero${ext}`);
  await fsp.copyFile(heroSrc, heroPath);

  const size = await readImageSize(heroPath);
  const meta = {
    id: String(id),
    heroPath,
    width: size?.width ?? null,
    height: size?.height ?? null,
    pkgBytes: stat.size,
    pkgMtimeMs: stat.mtimeMs,
    extractedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    images: (await listImages(rawDir)).length,
  };
  await fsp.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

  // 清掉 raw 目录：主贴图已经拷出来了，中间产物没有保留价值。
  // 不删的话本机 41 个 scene 会堆到 GB 级。
  await fsp.rm(rawDir, { recursive: true, force: true });

  return { ok: true, cached: false, ...meta };
}

/**
 * 批量提取（供 CLI 的 `we extract` 用）。
 *
 * 串行执行：RePKG 是 CPU/IO 密集型，并发只会互相抢盘，而且用户是在后台预热，
 * 不追求总时长。
 */
export async function extractAllSceneItems(
  items,
  { repkgPath = null, cacheRoot, overwrite = false, onProgress = null, delayMs = 0 } = {},
) {
  const targets = items.filter((i) => i.kind === "scene" && i.pkgPath);
  const results = [];
  const repkg = repkgPath ?? resolveRepkg();

  for (const [index, item] of targets.entries()) {
    if (onProgress) onProgress({ index, total: targets.length, item });
    const result = await extractScene({
      id: item.id,
      pkgPath: item.pkgPath,
      sceneJsonPath: item.sceneJsonPath,
      repkgPath: repkg,
      cacheRoot,
      overwrite,
    });
    results.push({ id: item.id, title: item.title, ...result });
    if (delayMs) await sleep(delayMs);
  }
  return results;
}

export { retryUntil };
