/**
 * Wallpaper Engine 库盘点的回归测试。
 *
 * 用**临时 fixture 目录**构造各种"真实世界会遇到的怪东西"，所以：
 *   · 不依赖开发机装没装 Wallpaper Engine
 *   · 不依赖 Steam
 *   · 可以在 CI 里跑
 *
 * fixture 覆盖的怪东西（都是实测或推理出的真实情况）：
 *   · `type` 大小写混杂（`Scene` / `scene` / `SCENE`）
 *   · 无 `type` 但有 `preset` 的"预设覆盖层"
 *   · 视频壁纸的 `file` 字段与实际文件名不一致（要靠兜底扫描）
 *   · `project.json` 是 GBK 编码
 *   · `project.json` 带 UTF-8 BOM
 *   · 坏 JSON（必须跳过而不是让整个盘点失败）
 *   · 缺 `project.json` 的目录
 *   · 官方示例工程（有 `scene.json` 但没有 `scene.pkg` → 不可渲染）
 *   · 同名目录出现在两个库里（去重）
 *
 * 用法： node test/verify-we-library.mjs
 */

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scanWeLibrary, readWorkshopItem, WALLPAPER_KINDS } from "../src/we-library.mjs";

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ ok: true, name });
  } catch (error) {
    checks.push({ ok: false, name, message: error?.message ?? String(error) });
  }
}

/** 「水墨」的 GB18030 字节 —— 用于造一个 GBK 编码的 project.json。 */
const GBK_SHUI_MO = [0xcb, 0xae, 0xc4, 0xab];

async function writeJson(file, value, { gbk = false, bom = false } = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let buf;
  if (gbk) {
    // 只支持纯 ASCII 的 JSON + 一段 GBK 字节（够测解码路径了）
    const text = JSON.stringify(value, null, 2);
    const marker = "__GBK__";
    const ascii = Buffer.from(text.replace(marker, "\u0000".repeat(0)), "latin1");
    // 手工拼：把 JSON 里 "title" 的值换成 GBK 字节
    const head = Buffer.from(text.slice(0, text.indexOf(marker)), "latin1");
    const tail = Buffer.from(text.slice(text.indexOf(marker) + marker.length), "latin1");
    buf = Buffer.concat([head, Buffer.from(GBK_SHUI_MO), tail]);
    void ascii;
  } else {
    buf = Buffer.from(JSON.stringify(value, null, 2), "utf8");
    if (bom) buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
  }
  await fsp.writeFile(file, buf);
}

async function makeFixtures(root) {
  // --- 一个有预览图的视频壁纸（file 字段正确）---
  const v1 = path.join(root, "workshop", "1001");
  await writeJson(path.join(v1, "project.json"), {
    title: "视频壁纸 A",
    type: "video",
    file: "a.mp4",
    preview: "preview.jpg",
    contentrating: "Everyone",
    tags: ["Anime"],
  });
  await fsp.writeFile(path.join(v1, "a.mp4"), Buffer.alloc(2048));
  await fsp.writeFile(path.join(v1, "preview.jpg"), Buffer.alloc(64));

  // --- 视频壁纸：file 字段是错的，要靠兜底扫描找到唯一的 mp4 ---
  const v2 = path.join(root, "workshop", "1002");
  await writeJson(path.join(v2, "project.json"), {
    title: "视频壁纸 B（file 字段不可靠）",
    type: "Video",
    file: "不存在的名字.mp4",
  });
  await fsp.writeFile(path.join(v2, "真实文件.mp4"), Buffer.alloc(1024));
  await fsp.writeFile(path.join(v2, "preview.gif"), Buffer.alloc(32));

  // --- 视频壁纸：没有任何视频文件 → 必须整条跳过 ---
  const v3 = path.join(root, "workshop", "1003");
  await writeJson(path.join(v3, "project.json"), { title: "坏掉的视频壁纸", type: "video", file: "gone.mp4" });

  // --- scene 壁纸：有 pkg → 可渲染 ---
  const s1 = path.join(root, "workshop", "2001");
  await writeJson(path.join(s1, "project.json"), {
    title: "场景壁纸 A",
    type: "Scene",
    file: "scene.json",
    preview: "preview.jpg",
    contentrating: "Everyone",
  });
  await fsp.writeFile(path.join(s1, "scene.pkg"), Buffer.alloc(4096));
  await fsp.writeFile(path.join(s1, "scene.json"), "{}");
  await fsp.writeFile(path.join(s1, "preview.jpg"), Buffer.alloc(64));

  // --- scene 壁纸：SCENE 全大写 + 无预览图 ---
  const s2 = path.join(root, "workshop", "2002");
  await writeJson(path.join(s2, "project.json"), { title: "场景壁纸 B", type: "SCENE" });
  await fsp.writeFile(path.join(s2, "scene.pkg"), Buffer.alloc(8192));

  // --- 官方示例工程：有 scene.json 但没有 pkg → **不可渲染** ---
  const d1 = path.join(root, "defaultprojects", "beach");
  await writeJson(path.join(d1, "project.json"), {
    title: "Beach",
    type: "scene",
    file: "scene.json",
    official: true,
  });
  await fsp.writeFile(path.join(d1, "scene.json"), "{}");
  await fsp.writeFile(path.join(d1, "preview.jpg"), Buffer.alloc(64));

  // --- web 壁纸 ---
  const w1 = path.join(root, "workshop", "3001");
  await writeJson(path.join(w1, "project.json"), { title: "网页壁纸", type: "web", file: "index.html" });
  await fsp.mkdir(path.join(w1, "files"), { recursive: true });
  await fsp.writeFile(path.join(w1, "files", "index.html"), "<html></html>");
  await fsp.writeFile(path.join(w1, "preview.jpg"), Buffer.alloc(48));

  // --- preset（无 type，有 preset 字段）→ 必须跳过 ---
  const p1 = path.join(root, "workshop", "4001");
  await writeJson(path.join(p1, "project.json"), { title: "预设覆盖层", preset: "x", dependency: "y" });
  await fsp.writeFile(path.join(p1, "preview.jpg"), Buffer.alloc(16));

  // --- application 壁纸：列出但不渲染 ---
  const a1 = path.join(root, "workshop", "5001");
  await writeJson(path.join(a1, "project.json"), { title: "应用程序壁纸", type: "application", file: "app.exe" });
  await fsp.writeFile(path.join(a1, "preview.jpg"), Buffer.alloc(16));

  // --- 坏 JSON → 必须跳过，不能拖垮整体 ---
  const bad = path.join(root, "workshop", "6001");
  await fsp.mkdir(bad, { recursive: true });
  await fsp.writeFile(path.join(bad, "project.json"), "{ this is not json ");

  // --- 缺 project.json 的目录 → 跳过 ---
  await fsp.mkdir(path.join(root, "workshop", "7001"), { recursive: true });

  // --- GBK 编码的 project.json ---
  const gbk = path.join(root, "workshop", "8001");
  await fsp.mkdir(gbk, { recursive: true });
  await fsp.writeFile(
    path.join(gbk, "project.json"),
    Buffer.concat([
      Buffer.from('{\n  "title": "', "latin1"),
      Buffer.from(GBK_SHUI_MO),
      Buffer.from('",\n  "type": "scene"\n}', "latin1"),
    ]),
  );
  await fsp.writeFile(path.join(gbk, "scene.pkg"), Buffer.alloc(128));

  // --- 带 BOM 的 project.json ---
  const bom = path.join(root, "workshop", "8002");
  await writeJson(path.join(bom, "project.json"), { title: "带 BOM 的壁纸", type: "scene" }, { bom: true });
  await fsp.writeFile(path.join(bom, "scene.pkg"), Buffer.alloc(128));

  // --- 同名 id 出现在第二个库里 → 只应出现一次 ---
  const dup = path.join(root, "library2", "2001");
  await writeJson(path.join(dup, "project.json"), { title: "重复条目（应被去重）", type: "scene" });
  await fsp.writeFile(path.join(dup, "scene.pkg"), Buffer.alloc(64));

  return {
    workshop: path.join(root, "workshop"),
    defaultprojects: path.join(root, "defaultprojects"),
    library2: path.join(root, "library2"),
  };
}

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wbwe-fixture-"));
  let dirs;
  try {
    dirs = await makeFixtures(root);

    const contentDirs = [
      { kind: "workshop", dir: dirs.workshop, library: root },
      { kind: "defaultprojects", dir: dirs.defaultprojects, library: root },
      { kind: "workshop", dir: dirs.library2, library: path.join(root, "lib2") },
    ];

    const result = await scanWeLibrary({
      withSize: false,
      libraries: [root],
      deps: { findWeContentDirs: () => contentDirs },
    });

    const byId = Object.create(null);
    for (const item of result.items) byId[item.id] = item;

    // --- 基本枚举 ---
    check("坏 JSON / 缺 project.json 的目录被跳过，不影响其它条目", () => {
      assert.equal(byId["6001"], undefined, "坏 JSON 没被跳过");
      assert.equal(byId["7001"], undefined, "缺 project.json 没被跳过");
      assert.equal(byId["1003"], undefined, "没有视频文件的视频壁纸没被跳过");
    });

    check("preset 覆盖层被跳过", () => {
      assert.equal(byId["4001"], undefined, "preset 不该进列表");
    });

    check("视频壁纸（file 字段正确）被正确识别", () => {
      const it = byId["1001"];
      assert.ok(it, "1001 丢了");
      assert.equal(it.kind, WALLPAPER_KINDS.VIDEO);
      assert.ok(it.mediaUrl?.endsWith("a.mp4"), `mediaUrl 是 ${it.mediaUrl}`);
      assert.ok(it.renderable, "应可渲染");
      assert.equal(it.rating, "everyone", "内容分级没读到");
      assert.deepEqual(it.tags, ["Anime"]);
    });

    check("视频壁纸 file 字段不可靠时靠兜底扫描找到视频", () => {
      const it = byId["1002"];
      assert.ok(it, "1002 丢了");
      assert.equal(it.kind, WALLPAPER_KINDS.VIDEO);
      assert.ok(it.mediaUrl, "没找到视频文件");
      assert.ok(decodeURIComponent(it.mediaUrl).includes("真实文件.mp4"), `mediaUrl 是 ${it.mediaUrl}`);
      assert.ok(it.renderable);
    });

    check("type 大小写不敏感（Video / SCENE / Scene）", () => {
      assert.equal(byId["1002"].kind, WALLPAPER_KINDS.VIDEO);
      assert.equal(byId["2001"].kind, WALLPAPER_KINDS.SCENE);
      assert.equal(byId["2002"].kind, WALLPAPER_KINDS.SCENE);
    });

    check("scene 有 pkg → 可渲染，且产出 pkgUrl", () => {
      const it = byId["2001"];
      assert.ok(it.pkgUrl, "缺少 pkgUrl");
      assert.ok(it.pkgUrl.endsWith("scene.pkg"));
      assert.ok(it.renderable);
    });

    check("scene 无预览图也能列出（静态兜底退化）", () => {
      const it = byId["2002"];
      assert.equal(it.previewUrl, null, "本来就没有预览图");
      assert.ok(it.renderable, "有 pkg 就可渲染");
    });

    check("官方示例工程（有 scene.json 无 pkg）→ 不可渲染", () => {
      const it = byId["beach"];
      assert.ok(it, "beach 丢了");
      assert.equal(it.kind, WALLPAPER_KINDS.SCENE);
      assert.equal(it.pkgUrl, null);
      assert.equal(it.sceneJsonUrl !== null, true, "应记下 scene.json");
      assert.equal(it.renderable, false, "没有 pkg 不该算可渲染");
      assert.equal(it.official, true, "official 标记没读到");
    });

    check("web 壁纸：有 files/index.html 才可渲染", () => {
      const it = byId["3001"];
      assert.ok(it, "3001 丢了");
      assert.equal(it.kind, WALLPAPER_KINDS.WEB);
      assert.ok(it.webIndexUrl?.endsWith("index.html"), `webIndexUrl 是 ${it.webIndexUrl}`);
      assert.ok(it.renderable);
    });

    check("application 壁纸被列出但不可渲染", () => {
      const it = byId["5001"];
      assert.ok(it, "5001 丢了");
      assert.equal(it.kind, WALLPAPER_KINDS.APPLICATION);
      assert.equal(it.renderable, false, "application 永远不渲染");
    });

    check("GBK 编码的 project.json 标题被正确解码（不是乱码）", () => {
      const it = byId["8001"];
      assert.ok(it, "8001 丢了");
      assert.equal(it.title, "水墨", `标题解成了「${it.title}」`);
    });

    check("带 UTF-8 BOM 的 project.json 能被解析", () => {
      const it = byId["8002"];
      assert.ok(it, "8002 丢了（BOM 导致 JSON.parse 失败）");
      assert.equal(it.title, "带 BOM 的壁纸");
    });

    check("同名 id 出现在两个库里时被去重", () => {
      const same = result.items.filter((i) => i.id === "2001");
      assert.equal(same.length, 1, `去重失效，出现了 ${same.length} 次`);
      // 首个命中胜
      assert.equal(byId["2001"].title, "场景壁纸 A");
    });

    // --- 统计 ---
    check("统计字段正确", () => {
      assert.equal(result.stats.total, result.items.length);
      assert.equal(result.stats.withPreview, result.items.filter((i) => i.previewUrl).length);
      assert.ok(result.stats.byKind.scene >= 3, "scene 计数不对");
      assert.ok(result.stats.byKind.video >= 2, "video 计数不对");
    });

    check("排序：可渲染的排在前面", () => {
      const firstUnrenderable = result.items.findIndex((i) => !i.renderable);
      if (firstUnrenderable >= 0) {
        const after = result.items.slice(firstUnrenderable);
        assert.ok(after.every((i) => !i.renderable), "不可渲染的条目混在了可渲染的中间");
      }
    });

    check("errors 里没有意外失败", () => {
      assert.deepEqual(result.errors, [], `有未预期的错误：${JSON.stringify(result.errors)}`);
    });

    // --- readWorkshopItem 的边界 ---
    check("readWorkshopItem：目录不存在返回 null 而不抛错", () => {
      assert.equal(readWorkshopItem(path.join(root, "not-there")), null);
    });

    check("readWorkshopItem：坏 JSON 返回 null 而不抛错", () => {
      assert.equal(readWorkshopItem(path.join(root, "workshop", "6001")), null);
    });

    check("所有 file:// URL 都是合法编码（无裸空格 / 反斜杠）", () => {
      for (const item of result.items) {
        for (const url of [item.mediaUrl, item.pkgUrl, item.webIndexUrl, item.previewUrl, item.sceneJsonUrl]) {
          if (!url) continue;
          assert.ok(url.startsWith("file:///"), `不是 file URL：${url}`);
          assert.ok(!url.includes("\\"), `URL 里还有反斜杠：${url}`);
          const rest = url.slice("file:///".length);
          assert.ok(!rest.includes(" "), `URL 里有裸空格：${url}`);
        }
      }
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }

  process.stdout.write("WE 库盘点回归（临时 fixture，不依赖本机是否装 WE）\n");
  process.stdout.write("─".repeat(60) + "\n");
  let failed = 0;
  for (const c of checks) {
    if (c.ok) process.stdout.write(`  ✓ ${c.name}\n`);
    else {
      failed += 1;
      process.stdout.write(`  ✗ ${c.name}\n      ${c.message}\n`);
    }
  }
  process.stdout.write(`\n结果：${failed ? `失败（${failed}/${checks.length}）` : `通过（${checks.length} 项）`}\n`);
  if (failed) process.exitCode = 1;
}

await run();
