/**
 * 生成一份**独立可预览**的 HTML：把注入脚本放进一个模拟 WorkBuddy 界面的
 * 页面里跑，用来在不启动 WorkBuddy 的情况下肉眼验证：
 *   · 壁纸层是否真的落在界面之后（而不是把界面盖住）
 *   · 设置面板 / 悬浮按钮 / 滑块 / 玻璃观感是否正常
 *   · 幂等卸载是否干净
 *
 * 用法：
 *   node scripts/make-preview.mjs                 # 用内置的示例条目（无需本机装 WE）
 *   node scripts/make-preview.mjs --local         # 用本机真实 WE 库（素材走 file://，需浏览器允许）
 *
 * 产出：preview/wallpaper-preview.html（自包含，双击即可打开）
 *
 * ⚠️ 为什么不用真实 WorkBuddy 的 DOM：预览页的**目的**是验证我们自己的注入物，
 *    而不是验证 WorkBuddy 的结构。真实结构由 `apply` 在真机上验证。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildInjectScript } from "../src/injector.mjs";
import { scanWeLibrary } from "../src/we-library.mjs";
import { resolveStatePaths } from "../src/platform/workbuddy.mjs";
import { readCachedExtract } from "../src/we-extract.mjs";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT_DIR = path.join(ROOT, "preview");

/** 1x1 的 PNG，当"没有预览图"时的占位（避免预览页出现大量破图）。 */
const PLACEHOLDER =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** 内置示例条目：不依赖本机是否装了 Wallpaper Engine。 */
function sampleScan() {
  const mk = (id, title, kind, extra = {}) => ({
    id,
    title,
    kind,
    rawType: kind,
    rating: "everyone",
    tags: [],
    source: "sample",
    official: false,
    dir: null,
    dirUrl: null,
    mediaPath: null,
    mediaUrl: null,
    pkgPath: null,
    pkgUrl: null,
    pkgBytes: 0,
    sceneJsonPath: null,
    sceneJsonUrl: null,
    webIndexPath: null,
    webIndexUrl: null,
    previewPath: null,
    previewUrl: PLACEHOLDER,
    sizeBytes: 0,
    renderable: true,
    ...extra,
  });
  return {
    items: [
      // 用 data URL 当"视频源"是不行的（不是真视频），所以示例里 video 条目故意
      // 指向不存在的路径 —— 预览页会走"静态兜底"分支，正好验证降级链。
      mk("sample-video", "示例 · 视频壁纸（预览页无真实文件，走静态兜底）", "video", {
        mediaUrl: null,
        renderable: false,
      }),
      mk("sample-scene", "示例 · 场景壁纸（预览页无 scene.pkg，走静态兜底）", "scene", {
        pkgUrl: null,
        renderable: false,
      }),
      mk("sample-web", "示例 · 网页壁纸", "web", { webIndexUrl: null, renderable: false }),
      mk("sample-image", "示例 · 纯静态预览图", "scene", { renderable: false }),
    ],
    stats: { total: 4, renderable: 0 },
  };
}

/** 用本机真实库构造预览数据（素材走 file://，只有浏览器允许才行）。 */
async function localScan() {
  const scan = await scanWeLibrary({ withSize: false });
  const cacheRoot = resolveStatePaths().cacheRoot;
  const items = await Promise.all(
    scan.items.slice(0, 60).map(async (item) => {
      let heroUrl = null;
      if (item.kind === "scene" && item.pkgUrl) {
        const cached = await readCachedExtract(item.id, { cacheRoot });
        if (cached?.heroPath) heroUrl = pathToFileURL(cached.heroPath).href;
      }
      return { ...item, heroUrl };
    }),
  );
  return { ...scan, items };
}

const useLocal = process.argv.includes("--local");
const scan = useLocal ? await localScan() : sampleScan();

const built = await buildInjectScript({ scan });

const page = [
  "<!DOCTYPE html>",
  '<html lang="zh-CN">',
  "<head>",
  '<meta charset="utf-8" />',
  "<title>WorkBuddy Wallpaper Engine · 注入预览</title>",
  "<style>",
  // 模拟 WorkBuddy 的界面骨架。关键：#root 是 position:relative;z-index:0，
  // 形成自己的层叠上下文 —— 这正是我们的负 z-index 壁纸层能落在它**之下**的原因。
  "*{box-sizing:border-box;}",
  "html,body{margin:0;height:100%;font:14px/1.55 system-ui,'Microsoft YaHei',sans-serif;color:#e8eef7;}",
  "#root{position:relative;z-index:0;display:flex;height:100%;}",
  "aside{width:230px;padding:14px;background:rgba(14,18,26,.62);backdrop-filter:blur(18px);border-right:1px solid rgba(255,255,255,.09);}",
  "aside h1{font-size:13px;margin:0 0 14px;letter-spacing:.04em;opacity:.85;}",
  "aside .item{padding:7px 9px;border-radius:8px;opacity:.78;margin-bottom:3px;}",
  "aside .item.on{background:rgba(106,176,255,.22);opacity:1;}",
  "main{flex:1;display:flex;flex-direction:column;padding:18px 22px;gap:12px;}",
  "main .bar{padding:9px 12px;border-radius:10px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);}",
  "main .bubble{align-self:flex-start;max-width:62%;padding:10px 14px;border-radius:14px;background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.11);}",
  "main .bubble.me{align-self:flex-end;background:rgba(106,176,255,.2);}",
  ".hint{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483002;padding:7px 14px;border-radius:9px;background:rgba(8,11,17,.72);border:1px solid rgba(255,255,255,.16);font-size:12px;backdrop-filter:blur(12px);}",
  "</style>",
  "</head>",
  "<body>",
  '<div id="root">',
  "  <aside>",
  "    <h1>WorkBuddy（模拟界面）</h1>",
  '    <div class="item on">新会话</div>',
  '    <div class="item">历史记录</div>',
  '    <div class="item">设置</div>',
  "  </aside>",
  "  <main>",
  '    <div class="bar">这是界面内容。壁纸应当在<b>它后面</b>可见 —— 如果这里被壁纸盖住了，说明层叠策略失效。</div>',
  '    <div class="bubble">把本机 Wallpaper Engine 的壁纸放到 WorkBuddy 界面之后。</div>',
  '    <div class="bubble me">右下角的 🎨 按钮打开设置面板。</div>',
  "  </main>",
  "</div>",
  '<div class="hint">注入预览 · ' + (useLocal ? "本机真实壁纸库" : "内置示例数据") + " · 共 " + scan.items.length + " 条</div>",
  "<script>",
  // 预览页没有 CDP binding，把上报函数做成空实现，让注入脚本正常走 localStorage 路径
  "window.__wbweReport = function(payload){ try { console.log('[preview] report', payload); } catch(e){} };",
  "</" + "script>",
  "<script>",
  built.source,
  "</" + "script>",
  "</body>",
  "</html>",
].join("\n");

await fsp.mkdir(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, "wallpaper-preview.html");
await fsp.writeFile(outFile, page, "utf8");

process.stdout.write("预览页已生成：\n");
process.stdout.write("  " + outFile + "\n");
process.stdout.write("  条目数：" + scan.items.length + "，注入脚本 " + built.source.length + " 字节\n");
process.stdout.write("  用浏览器打开即可（无需 WorkBuddy、无需 CDP）。\n");
