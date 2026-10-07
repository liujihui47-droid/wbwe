/**
 * Wallpaper Engine 壁纸库的**只读盘点**。
 *
 * 这是纯粹的本地发现逻辑：定位 Steam → 枚举库目录 → 找创意工坊的 WE 内容
 * （appid 431960）→ 逐个解析 `project.json` → 分类成 video / scene / web /
 * application / preset，并产出渲染层能直接用的 `file://` 地址。
 *
 * 设计约束（都是踩过之后定下来的）：
 *   1. **只读**。不写任何东西到 Steam 或 WE 目录，不碰 DRM，不复制大文件。
 *   2. **不硬编码路径**。靠注册表 + `libraryfolders.vdf` 动态发现；装到 D 盘、
 *      E 盘、多个库目录都要能找到。
 *   3. **去重必须大小写不敏感**。`D:/Steam` 与 `D:\Steam` 是同一个目录，
 *      否则递归一层就会让条目数翻倍。
 *   4. **编码必须有多级回退**。创意工坊里大量 `project.json` 是 GBK 写的，
 *      直接按 UTF-8 读会得到乱码标题。回退顺序：utf-8-sig → utf-8 → gbk。
 *   5. **任何单个条目的失败都不能拖垮整体**。坏 zip、缺字段、权限拒绝都跳过。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dedupeBy, dedupeKey, repairMojibakeFilename, resolveExistingFile, stripBom, toFileUrl, tryJsonParse } from "./util.mjs";

/** Wallpaper Engine 在 Steam 上的 appid。 */
export const WE_APP_ID = "431960";

/** WE 的壁纸类型 → 本项目的内部类型。 */
export const WALLPAPER_KINDS = Object.freeze({
  VIDEO: "video",
  SCENE: "scene",
  WEB: "web",
  APPLICATION: "application",
  PRESET: "preset",
  UNKNOWN: "unknown",
});

/** 哪些类型我们**能真的渲染**成背景。application 会启动外部程序，永远不渲染。 */
export const RENDERABLE_KINDS = Object.freeze([
  WALLPAPER_KINDS.VIDEO,
  WALLPAPER_KINDS.SCENE,
  WALLPAPER_KINDS.WEB,
]);

/** 可以当静态图用的预览图文件名（按优先级）。 */
const PREVIEW_NAMES = ["preview.jpg", "preview.jpeg", "preview.png", "preview.gif"];

/** 视频壁纸的候选扩展名（`project.json` 里已经给了确切文件名，这是兜底）。 */
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v"]);

function existsSync(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解码一段可能是 UTF-8 也可能是 GBK 的 buffer。
 *
 * 策略（顺序很重要，这里踩过一个很隐蔽的坑）：
 *   1. 严格按 UTF-8 解。**但通过不代表解对了** —— 实测中文 GBK 里大量两字节序列
 *      恰好构成合法 UTF-8。例如 `水` 的 GBK 是 `CB AE`，而 `CB AE` 也是合法 UTF-8
 *      （U+02EE ˮ）；`墨` 的 GBK 是 `C4 AB`（合法 UTF-8 → U+012B ī）。
 *      所以「{"title":"水墨"}」的 GBK 字节会被"成功地"解成「{"title":"ˮī"}」——
 *      不抛错、不产生替换字符，只是标题变成了乱码。
 *   2. 因此严格 UTF-8 解出来的结果要过一道**乱码体检**：如果里面出现拉丁扩展 /
 *      国际音标 / 修饰字母这类"中文文档里几乎不可能出现"的字符，就判定这不是
 *      UTF-8，转去试 GB18030。
 *   3. GB18030 是 GBK 的超集，Node 内置支持。
 */
export function decodeTextSmart(buffer) {
  if (typeof buffer === "string") return buffer;
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  let utf8 = null;
  try {
    // fatal: true —— 遇到非法 UTF-8 序列直接抛，这样才能区分"真的不是 UTF-8"
    utf8 = stripBom(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    utf8 = null;
  }

  // 严格 UTF-8 解得出来，但要确认它不是"合法但明显错误"的解码结果
  if (utf8 !== null && !looksLikeMisdecodedUtf8(utf8)) return utf8;

  for (const enc of ["gb18030", "gbk", "big5"]) {
    try {
      const text = stripBom(new TextDecoder(enc).decode(bytes));
      if (!/\uFFFD/.test(text)) return text;
    } catch {
      /* 这个编码在当前 Node 里不可用，试下一个 */
    }
  }
  // 所有非 UTF-8 编码都不合适时，退回宽松 UTF-8（至少不会丢字节）
  return utf8 !== null ? utf8 : stripBom(bytes.toString("utf8"));
}

/**
 * 判断一段"严格 UTF-8 解出来"的文本是不是其实解错了。
 *
 * 判据：出现了**中文/日文文档里几乎不可能出现**的字符类别：
 *   · 拉丁扩展 A/B（U+0100–U+024F）
 *   · 国际音标扩展（U+0250–U+02AF）
 *   · 修饰字母（U+02B0–U+02FF）
 *   · 组合附加符号（U+0300–U+036F）
 *
 * 这些正是 GBK 两字节序列被当成 UTF-8 解之后的典型落点。
 * 反过来，正常的 ASCII / 中日韩 / emoji 都不会命中，所以不会误伤。
 *
 * 之所以敢用"字符类别"而不是"统计"：`project.json` 这种文件的价值全在
 * 标题与描述上，而这些字段在中文素材里就是中文。出现一堆 ī ˮ 之类，
 * 要么是解错了，要么作者真的在标题里写音标 —— 后者可以忽略不计。
 */
function looksLikeMisdecodedUtf8(text) {
  let suspicious = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    if ((cp >= 0x0100 && cp <= 0x02ff) || (cp >= 0x0300 && cp <= 0x036f)) suspicious += 1;
    // 出现几个就足够判定 —— 阈值放低是因为这些字符在 JSON 里本就极罕见
    if (suspicious >= 2) return true;
  }
  return false;
}

/** 同步读文件并智能解码（盘点路径上全是小文件，用同步版更简单）。 */
export function readTextSmart(filePath) {
  return decodeTextSmart(fs.readFileSync(filePath));
}

/**
 * 解析 Valve 的 KeyValues 文本格式（`libraryfolders.vdf`）。
 *
 * 不引入 VDF 库：这份文件的结构非常固定，只需要抓出所有 `"path" "..."`。
 * 但仍然要正经处理引号与注释，避免把 `path` 之外的键当成目录。
 *
 * 返回所有 `"path"` 的值（未做存在性校验）。
 */
export function parseLibraryFoldersVdf(text) {
  const paths = [];
  const re = /"path"\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    if (raw) paths.push(raw.replace(/\\\\/g, "\\"));
  }
  return paths;
}

/**
 * 从 Windows 注册表读 Steam 安装目录。
 *
 * 只查 HKCU（当前用户）——Steam 安装时必写这里，比 HKLM 更可靠（HKLM 在某些
 * 安装场景下缺失，而且读 HKLM 可能需要更高权限）。
 * 用 `reg.exe` 而不是 PowerShell：在受限语言模式 / 非 PowerShell 宿主下更稳。
 */
async function readSteamPathFromRegistry() {
  if (process.platform !== "win32") return null;
  let execFile;
  try {
    ({ execFile } = await import("node:child_process"));
  } catch {
    return null;
  }

  const query = (key) =>
    new Promise((resolve) => {
      let child;
      try {
        child = execFile("reg.exe", ["query", key, "/v", "SteamPath"], { windowsHide: true }, (err, stdout) => {
          if (err || !stdout) return resolve(null);
          // 输出形如:  `    SteamPath    REG_SZ    d:/program files (x86)/steam`
          const m = String(stdout).match(/SteamPath\s+REG_SZ\s+(.+?)\s*$/im);
          resolve(m ? m[1].trim() : null);
        });
      } catch {
        // 受限环境（例如沙箱或禁用了子进程的环境）里 execFile 会直接抛 EPERM。
        // 注册表只是"发现 Steam"的**其中一条**路径，失败就退回候选目录列表。
        return resolve(null);
      }
      child?.on?.("error", () => resolve(null));
    });

  for (const key of [
    "HKCU\\Software\\Valve\\Steam",
    "HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam",
    "HKLM\\SOFTWARE\\Valve\\Steam",
  ]) {
    const value = await query(key);
    if (value) return value.replace(/\//g, "\\");
  }
  return null;
}

/** 各平台上 Steam 的常见安装位置（注册表失败时的兜底候选）。 */
function steamPathCandidates() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const programFiles = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.SystemDrive ? `${process.env.SystemDrive}\\Program Files (x86)` : null].filter(Boolean);
    const drives = ["C", "D", "E", "F", "G"];
    const out = [];
    for (const pf of programFiles) out.push(path.join(pf, "Steam"));
    for (const d of drives) {
      out.push(`${d}:\\Steam`);
      out.push(`${d}:\\Program Files (x86)\\Steam`);
      out.push(`${d}:\\Program Files\\Steam`);
      out.push(`${d}:\\Games\\Steam`);
      out.push(`${d}:\\SteamLibrary`);
    }
    return out;
  }
  if (process.platform === "darwin") {
    return [path.join(home, "Library/Application Support/Steam")];
  }
  return [
    path.join(home, ".steam/steam"),
    path.join(home, ".local/share/Steam"),
    path.join(home, ".var/app/com.valvesoftware.Steam/data/Steam"),
  ];
}

/**
 * 注册表不可用时的**纯文件系统**兜底发现。
 *
 * 思路：Steam 的安装盘上一定存在 `steamapps/libraryfolders.vdf`。所以直接枚举
 * 盘符，在少量常见目录深度上探测这个标志文件，命中即认定该目录是 Steam 库。
 *
 * 为什么需要它：`reg.exe` 依赖子进程，在某些受限环境（沙箱、组策略禁 cmd）下
 * 会失败。多一条不依赖子进程的路径，插件的容错就高一个量级。
 *
 * 成本控制：只扫固定的一层候选名，**不做全盘递归** —— 全盘扫会慢到不可接受。
 */
function probeDriveCandidates() {
  if (process.platform !== "win32") return [];
  const found = [];
  const rootNames = [
    "Steam",
    "SteamLibrary",
    "Games\\Steam",
    "Games\\SteamLibrary",
    "Program Files (x86)\\Steam",
    "Program Files\\Steam",
    "Program Files (x86)\\SteamLibrary",
  ];
  const drives = ["C", "D", "E", "F", "G", "H"];
  for (const d of drives) {
    const root = `${d}:\\`;
    if (!existsSync(root)) continue;
    for (const name of rootNames) {
      const candidate = path.join(root, name);
      if (existsSync(path.join(candidate, "steamapps", "libraryfolders.vdf"))) {
        found.push({ path: candidate, evidence: "libraryfolders.vdf" });
      }
    }
  }
  // 同时看看 Steam 自己的配置目录里有没有记着安装路径（它是纯文本，很好解析）。
  for (const name of rootNames) {
    for (const d of drives) {
      const root = `${d}:\\`;
      if (!existsSync(root)) continue;
      for (const cfg of [path.join(root, name, "config", "config.vdf"), path.join(root, name, "steamapps", "libraryfolders.vdf")]) {
        if (!existsSync(cfg)) continue;
        try {
          const text = readTextSmart(cfg);
          for (const p of parseQuotedPaths(text)) {
            if (existsSync(path.join(p, "steamapps"))) found.push({ path: p, evidence: cfg });
          }
        } catch {
          /* 配置读不了不影响其它候选 */
        }
      }
    }
  }
  return found;
}

/** 抓出一段 Valve KeyValues 文本里所有看起来像路径的引号值。 */
function parseQuotedPaths(text) {
  const out = [];
  const re = /"([^"]*[\\/][^"]*)"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim().replace(/\\\\/g, "\\");
    // 排除明显不是路径的值（例如 URL、注册表键）。
    if (/^[a-z]+:\/\//i.test(raw)) continue;
    if (raw.length < 4) continue;
    out.push(raw.replace(/\//g, "\\"));
  }
  return out;
}

/**
 * 定位所有 Steam 库根目录。
 *
 * 返回去重后的绝对路径数组（顺序：主安装目录优先）。找不到就返回空数组，
 * 由调用方决定怎么提示 —— 盘点本身不应该因为"没装 Steam"而抛错。
 */
export async function findSteamLibraries({ extraCandidates = [] } = {}) {
  const candidates = [];
  const fromRegistry = await readSteamPathFromRegistry();
  if (fromRegistry) candidates.push(fromRegistry);
  candidates.push(...steamPathCandidates(), ...extraCandidates);

  // 纯文件系统的兜底探测（不依赖子进程）。命中率很高，因为它直接找标志文件。
  const probed = probeDriveCandidates();
  for (const { path: p } of probed) candidates.push(p);

  // 只保留真实存在且看起来像 Steam 的目录（有 steamapps 或 steam.exe）。
  const existing = dedupeBy(
    candidates.filter((c) => {
      if (!c) return false;
      if (!existsSync(c)) return false;
      return existsSync(path.join(c, "steamapps")) || existsSync(path.join(c, "steam.exe")) || existsSync(path.join(c, "Steam.exe"));
    }),
    dedupeKey,
  );

  // 展开每个 Steam 根目录的 libraryfolders.vdf 里记录的额外库。
  const libraries = [];
  for (const root of existing) {
    libraries.push(root);
    for (const vdfName of ["libraryfolders.vdf", "libraryfolders.vdf.bak"]) {
      const vdfPath = path.join(root, "steamapps", vdfName);
      if (!existsSync(vdfPath)) continue;
      try {
        const text = readTextSmart(vdfPath);
        for (const p of parseLibraryFoldersVdf(text)) {
          if (existsSync(p)) libraries.push(p);
        }
      } catch {
        /* 单个 vdf 读不了不影响其它库 */
      }
    }
  }

  // ⚠️ 去重是刚需：注册表的值与 vdf 的值往往只差盘符大小写或斜杠方向，
  //    不去重会让后面的壁纸条目整体翻倍。
  return dedupeBy(libraries, dedupeKey);
}

/**
 * 从所有 Steam 库里找出 WE 的创意工坊内容目录。
 *
 * 创意工坊内容固定放在 `<library>/steamapps/workshop/content/<appid>/`。
 * 同时兼容"手动下载的壁纸"目录：`<library>/steamapps/common/wallpaper_engine/projects/`。
 */
export function findWeContentDirs(libraries) {
  const out = [];
  for (const lib of libraries) {
    const workshop = path.join(lib, "steamapps", "workshop", "content", WE_APP_ID);
    if (existsSync(workshop)) out.push({ kind: "workshop", dir: workshop, library: lib });

    const myProjects = path.join(lib, "steamapps", "common", "wallpaper_engine", "projects", "myprojects");
    if (existsSync(myProjects)) out.push({ kind: "myprojects", dir: myProjects, library: lib });

    const defaultProjects = path.join(lib, "steamapps", "common", "wallpaper_engine", "projects", "defaultprojects");
    if (existsSync(defaultProjects)) out.push({ kind: "defaultprojects", dir: defaultProjects, library: lib });
  }
  return dedupeBy(out, (x) => dedupeKey(x.dir));
}

/** 从 WE 的 type 字段与 project.json 的其它线索推断内部类型。 */
export function classifyWallpaper(project) {
  const rawType = String(project?.type ?? "").toLowerCase();
  if (rawType === "video") return WALLPAPER_KINDS.VIDEO;
  if (rawType === "scene") return WALLPAPER_KINDS.SCENE;
  if (rawType === "web") return WALLPAPER_KINDS.WEB;
  if (rawType === "application") return WALLPAPER_KINDS.APPLICATION;
  if (rawType === "preset") return WALLPAPER_KINDS.PRESET;
  // 没有 type 但有 preset/dependency 字段的，是"预设覆盖层"，不是独立壁纸。
  if (project?.preset || project?.dependency) return WALLPAPER_KINDS.PRESET;
  return WALLPAPER_KINDS.UNKNOWN;
}

/** 列目录但永不抛错。 */
function readDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 在目录里找一个可用的预览图（缩略图一律用它，绝不用 <video> 当缩略图）。 */
export function findPreview(dir) {
  for (const name of PREVIEW_NAMES) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  // 有些包把预览图命名为 `preview.<hash>.jpg` 之类，宽松匹配一次。
  for (const entry of readDirSafe(dir)) {
    if (!entry.isFile()) continue;
    if (/^preview\b/i.test(entry.name) && /\.(jpe?g|png|gif|webp)$/i.test(entry.name)) {
      return path.join(dir, entry.name);
    }
  }
  return null;
}

/** 递归计算目录体积（用于在面板上展示"占多少盘"）。 */
function dirSizeBytes(dir, budget = 20000) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readDirSafe(cur)) {
      if (seen++ > budget) return total; // 超大目录不精确统计，避免卡住盘点
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* 单个文件读不到就算了 */
        }
      }
    }
  }
  return total;
}

/**
 * 解析单个创意工坊条目目录，产出渲染层要用的描述对象。
 *
 * 任何一步失败都返回 null（调用方过滤掉）—— 创意工坊里坏条目很常见，
 * 不能因为一个坏包让整个面板空白。
 */
export function readWorkshopItem(dir, { source = "workshop", withSize = true } = {}) {
  const projectPath = path.join(dir, "project.json");
  if (!existsSync(projectPath)) return null;

  let project;
  try {
    project = tryJsonParse(readTextSmart(projectPath), null);
  } catch {
    return null;
  }
  if (!project || typeof project !== "object") return null;

  const kind = classifyWallpaper(project);

  // preset 是"预设覆盖层"，不是独立壁纸 —— 它没有自己的媒体，只是一组参数覆盖。
  // 放进面板只会多出一张点了没反应的死卡片，所以直接跳过。
  if (kind === WALLPAPER_KINDS.PRESET) return null;

  const id = path.basename(dir);

  // 预览图解析顺序：project.json 里声明的 `preview` 最权威（本机实测有
  // `preview.gif` 这种命名），然后才是固定文件名回退。
  const declaredPreview = typeof project.preview === "string" ? project.preview.trim() : "";
  let previewPath = null;
  if (declaredPreview) {
    const candidate = path.join(dir, declaredPreview);
    if (existsSync(candidate)) previewPath = candidate;
  }
  if (!previewPath) previewPath = findPreview(dir);

  // 各类型的主媒体：
  //   video → project.json 的 `file`（mp4 就在工程根目录，**不在** files/ 里）
  //   scene → scene.pkg（创意工坊打包资源）；官方的 defaultprojects 则只有
  //           散装的 scene.json + materials/，没有 pkg —— 那类只能退化成静态图
  //   web   → files/index.html
  let mediaPath = null;
  let pkgPath = null;
  let webIndexPath = null;
  let sceneJsonPath = null;

  if (kind === WALLPAPER_KINDS.VIDEO) {
    const declared = typeof project.file === "string" ? project.file.trim() : "";
    // 声明的文件名优先；它可能含子目录，也可能因编码问题在 JS 字符串里是乱码，
    // 所以走 resolveExistingFile（内含乱码修复 + 大小写不敏感匹配）。
    if (declared) {
      const candidate = resolveExistingFile(dir, declared);
      if (candidate) mediaPath = candidate;
    }
    // 兜底：根目录里扫第一个视频文件。
    if (!mediaPath) {
      for (const entry of readDirSafe(dir)) {
        if (entry.isFile() && VIDEO_EXTS.has(path.extname(entry.name).toLowerCase())) {
          mediaPath = path.join(dir, entry.name);
          break;
        }
      }
    }
    if (!mediaPath) return null; // 视频壁纸没有视频文件 → 这条没用
  } else if (kind === WALLPAPER_KINDS.SCENE) {
    const pkg = path.join(dir, "scene.pkg");
    if (existsSync(pkg)) pkgPath = pkg;
    const sceneJson = path.join(dir, "scene.json");
    if (existsSync(sceneJson)) sceneJsonPath = sceneJson;
  } else if (kind === WALLPAPER_KINDS.WEB) {
    const index = path.join(dir, "files", "index.html");
    if (existsSync(index)) webIndexPath = index;
  }

  // scene/web 即使拿不到主资源，也还能用预览图当静态背景 —— 保留条目。
  // 但 video 没视频文件就是废条目（上面已经 return null）。
  // 体积统计对 web 壁纸可能很贵（实测有 621MB 的包），所以交给调用方决定。
  const sizeBytes = withSize ? dirSizeBytes(dir) : 0;

  // 内容分级：WE 的字段名是 `contentrating`（workshop 项），也可能写成 `rating`。
  const rating = String(project.contentrating ?? project.rating ?? "").toLowerCase() || null;

  return {
    id,
    title: typeof project.title === "string" && project.title.trim() ? project.title.trim() : `WE ${id}`,
    kind,
    rawType: String(project.type ?? ""),
    source,
    official: project.official === true,
    // 基础路径
    dir,
    dirUrl: toFileUrl(dir),
    // 主媒体（按类型只有一个非空）
    mediaPath,
    mediaUrl: toFileUrl(mediaPath),
    pkgPath,
    pkgUrl: toFileUrl(pkgPath),
    pkgBytes: pkgPath ? safeSize(pkgPath) : 0,
    sceneJsonPath,
    sceneJsonUrl: toFileUrl(sceneJsonPath),
    webIndexPath,
    webIndexUrl: toFileUrl(webIndexPath),
    // 静态兜底
    previewPath,
    previewUrl: toFileUrl(previewPath),
    sizeBytes,
    // WE 自己记的内容分级（Everyone / Questionable / Mature）
    rating,
    // 作者给的标签，面板可以拿来做过滤
    tags: Array.isArray(project.tags) ? project.tags.filter((t) => typeof t === "string") : [],
    // 可渲染性：
    //   video → 必须有视频文件
    //   scene → 有 scene.pkg（可交给 WebWallGL/RePKG）；仅有 scene.json 的
    //           官方示例工程拿不到打包贴图，只能当静态图，故不算可渲染
    //   web   → 必须有 files/index.html
    renderable:
      (kind === WALLPAPER_KINDS.VIDEO && Boolean(mediaPath)) ||
      (kind === WALLPAPER_KINDS.SCENE && Boolean(pkgPath)) ||
      (kind === WALLPAPER_KINDS.WEB && Boolean(webIndexPath)),
  };
}

function safeSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/**
 * 全量盘点本机的 WE 壁纸库。
 *
 * `deps` 允许测试注入假的发现函数，从而用固定 fixture 做回归 —— 不依赖本机
 * 到底装没装 WE。
 */
export async function scanWeLibrary({ withSize = true, libraries = null, deps = {} } = {}) {
  const findLibs = deps.findSteamLibraries ?? findSteamLibraries;
  const findDirs = deps.findWeContentDirs ?? findWeContentDirs;
  const readItem = deps.readWorkshopItem ?? readWorkshopItem;

  const libs = libraries ?? (await findLibs());
  const contentDirs = findDirs(libs);

  const items = [];
  const seenIds = new Set();
  const errors = [];

  for (const { dir, kind: source } of contentDirs) {
    for (const entry of readDirSafe(dir)) {
      if (!entry.isDirectory()) continue;
      const itemDir = path.join(dir, entry.name);
      try {
        const item = readItem(itemDir, { source, withSize });
        if (!item) continue;
        // 同一个壁纸可能同时出现在 workshop 与 myprojects 里；id 去重。
        const key = `${item.id}`;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        items.push(item);
      } catch (error) {
        errors.push({ dir: itemDir, message: error?.message ?? String(error) });
      }
    }
  }

  // 排序：可渲染的在前，然后按标题（中文/英文混排时用 localeCompare 更自然）。
  items.sort((a, b) => {
    if (a.renderable !== b.renderable) return a.renderable ? -1 : 1;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.title.localeCompare(b.title, "zh-Hans-CN");
  });

  const byKind = {};
  for (const item of items) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;

  return {
    libraries: libs,
    contentDirs,
    items,
    errors,
    stats: {
      total: items.length,
      renderable: items.filter((i) => i.renderable).length,
      withPreview: items.filter((i) => i.previewUrl).length,
      totalBytes: items.reduce((sum, i) => sum + (i.sizeBytes ?? 0), 0),
      byKind,
    },
  };
}

/**
 * 产出要注入到渲染进程的精简载荷。
 *
 * ⚠️ 关键设计：**只传路径与标题，绝不传字节**。WE 素材动辄几十上百 MB，
 * 塞进注入脚本会让 CDP 消息爆掉；而且渲染进程本身就是 `file://` 页面，
 * 可以直接 `<video src="file:///…">` 读本机文件（已实测）。
 *
 * ⚠️ 这个函数**必须是幂等的**。踩过的坑：`fileUrl` 曾经写成 `item.mediaUrl`
 * 而没有回退到 `item.fileUrl`，于是"对已经规整过的条目再规整一次"会把
 * `previewUrl` 清成 null（`fileUrl` 因为恰好有回退而幸存）。
 * 结果：面板里所有缩略图静默消失 —— 不抛任何错误，只是"看起来什么都没有"。
 * 这里的每个字段名都从两个来源取：扫描器字段名 与 注入字段名。
 */
export function toInjectionPayload(items) {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    kind: item.kind,
    rawType: item.rawType,
    rating: item.rating,
    tags: item.tags,
    official: item.official,
    // sizeMB 可能由扫描期算好，也可能要从 sizeBytes 换算
    sizeMB: Number.isFinite(item.sizeMB) ? item.sizeMB : Math.round(((item.sizeBytes ?? 0) / 1048576) * 10) / 10,
    fileUrl: item.mediaUrl ?? item.fileUrl ?? null,
    webIndexUrl: item.webIndexUrl ?? null,
    pkgUrl: item.pkgUrl ?? null,
    pkgBytes: item.pkgBytes ?? 0,
    sceneJsonUrl: item.sceneJsonUrl ?? null,
    previewUrl: item.previewUrl ?? null,
    renderable: Boolean(item.renderable),
    source: item.source ?? null,
  }));
}
