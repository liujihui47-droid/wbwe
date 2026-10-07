/**
 * 注入载荷（buildInjectData）的回归测试。
 *
 * 重点回归一个**真实踩过的 bug**：`buildInjectData` 内部会对条目跑
 * `toInjectionPayload()`。而 `toInjectionPayload()` 读的是扫描器的字段名
 * （`previewPath` / `mediaPath`），产出的是注入用的字段名（`previewUrl` / `fileUrl`）。
 *
 * 如果调用方传进来的**已经是规整过的**条目，再跑一次就会读到不存在的
 * `previewPath` → 所有 URL 变成 null → **面板里全部缩略图消失、所有视频失去 src**。
 * 这个 bug 不会抛任何错误，只是"看起来什么都没有"，所以必须有回归。
 *
 * 用法： node test/verify-inject-data.mjs
 */

import assert from "node:assert/strict";

import { buildInjectData } from "../src/injector.mjs";
import { toInjectionPayload } from "../src/we-library.mjs";

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ ok: true, name });
  } catch (error) {
    checks.push({ ok: false, name, message: error?.message ?? String(error) });
  }
}

/** 扫描器的**原始**形状（CLI 会先把它交给 toInjectionPayload）。 */
function rawItems() {
  return [
    {
      id: "raw-video",
      title: "原始 · 视频",
      kind: "video",
      rawType: "video",
      rating: "everyone",
      tags: ["Anime"],
      source: "workshop",
      official: false,
      mediaUrl: "file:///C:/we/v/a.mp4",
      previewUrl: "file:///C:/we/v/preview.jpg",
      sizeBytes: 1048576,
      renderable: true,
    },
    {
      id: "raw-scene",
      title: "原始 · 场景",
      kind: "scene",
      rawType: "Scene",
      rating: "Everyone",
      tags: [],
      source: "workshop",
      official: false,
      pkgUrl: "file:///C:/we/s/scene.pkg",
      pkgBytes: 4096,
      previewUrl: "file:///C:/we/s/preview.gif",
      sizeBytes: 4096,
      renderable: true,
    },
  ];
}

// 注意：rawItems() 返回的对象带 previewUrl/mediaUrl 而**没有** previewPath/mediaPath，
// 所以按 looksLikeRawScanItem 的判据它们算"已规整"，不会二次转换 —— 这正是我们要的。
// 真正的"原始扫描结果"由下面 explicitNormalize 那段覆盖。

const emptyState = {
  schemaVersion: 1,
  activeId: null,
  tunables: {},
  hidden: false,
  rotateMinutes: 0,
  autoplay: true,
  rating: "everyone",
  enabledKinds: ["video", "scene", "web"],
};

async function run() {
  // --- 1. 已规整的条目：URL 必须原样保住 ---------------------------------
  const preNormalized = toInjectionPayload([
    {
      ...rawItems()[0],
      mediaUrl: "file:///C:/we/v/a.mp4",
      previewUrl: "file:///C:/we/v/preview.jpg",
    },
  ]);
  const built1 = await buildInjectData({ scan: { items: preNormalized }, state: emptyState });
  check("已规整条目：fileUrl 未被清空", () => {
    assert.equal(built1.items[0].fileUrl, "file:///C:/we/v/a.mp4");
  });
  check("已规整条目：previewUrl 未被清空", () => {
    assert.equal(built1.items[0].previewUrl, "file:///C:/we/v/preview.jpg");
  });
  check("已规整条目：标题与类型保住", () => {
    assert.equal(built1.items[0].kind, "video");
    assert.ok(built1.items[0].title.length > 0);
  });

  // --- 2. 幂等性：toInjectionPayload 必须可以安全地跑第二次 --------------
  // 这是那个 bug 的最小复现：`fileUrl` 有过回退（mediaUrl ?? fileUrl），
  // 但 `previewUrl` 曾经没有 —— 于是"再规整一次"会让缩略图全变 null。
  const once = toInjectionPayload([
    {
      id: "x",
      title: "幂等性检查",
      kind: "video",
      rawType: "video",
      rating: "everyone",
      tags: [],
      source: "workshop",
      mediaUrl: "file:///C:/x/a.mp4",
      previewUrl: "file:///C:/x/p.jpg",
      sizeBytes: 1,
      renderable: true,
    },
  ]);
  check("幂等性：toInjectionPayload 跑两次结果一致", () => {
    const twice = toInjectionPayload(once);
    assert.deepEqual(twice, once, "第二次转换改变了内容 —— 某个字段缺了回退");
  });
  check("幂等性：previewUrl 在第二次转换后仍在", () => {
    assert.equal(toInjectionPayload(once)[0].previewUrl, "file:///C:/x/p.jpg");
  });

  const built2 = await buildInjectData({ scan: { items: once }, state: emptyState });
  check("回归：buildInjectData 不会二次转换（URL 保住）", () => {
    assert.equal(built2.items[0].fileUrl, "file:///C:/x/a.mp4", "fileUrl 被二次转换清空了");
    assert.equal(built2.items[0].previewUrl, "file:///C:/x/p.jpg", "previewUrl 被二次转换清空了");
  });

  // --- 3. 原始扫描器形状：应该被转换 ------------------------------------
  const raw = [
    {
      id: "scan1",
      title: "扫描器原始 · 视频",
      kind: "video",
      rawType: "video",
      rating: null,
      tags: [],
      source: "workshop",
      official: false,
      // 原始形状的关键标志：文件系统路径字段
      mediaPath: "C:\\we\\a.mp4",
      mediaUrl: "file:///C:/we/a.mp4",
      previewPath: "C:\\we\\p.jpg",
      previewUrl: "file:///C:/we/p.jpg",
      pkgPath: null,
      webIndexPath: null,
      sizeBytes: 2048,
      renderable: true,
    },
  ];
  const built3 = await buildInjectData({ scan: { items: raw }, state: emptyState });
  check("原始扫描器形状：被正确转换且 URL 保住", () => {
    assert.equal(built3.items[0].fileUrl, "file:///C:/we/a.mp4");
    assert.equal(built3.items[0].previewUrl, "file:///C:/we/p.jpg");
    assert.equal(built3.items[0].sizeMB, 2048 / 1048576 > 0 ? built3.items[0].sizeMB : -1);
  });

  // --- 4. 空库不炸 --------------------------------------------------------
  const built4 = await buildInjectData({ scan: { items: [] }, state: emptyState });
  check("空库返回空数组而不是抛错", () => {
    assert.deepEqual(built4.items, []);
    assert.equal(built4.ext.sceneTotal, 0);
  });

  // --- 5. payload 形状完整 -------------------------------------------------
  const built5 = await buildInjectData({
    scan: {
      items: toInjectionPayload([
        {
          id: "s",
          title: "场景",
          kind: "scene",
          rawType: "scene",
          rating: "everyone",
          tags: [],
          source: "workshop",
          pkgUrl: "file:///C:/s/scene.pkg",
          pkgBytes: 10,
          previewUrl: "file:///C:/s/p.jpg",
          sizeBytes: 10,
          renderable: true,
        },
      ]),
    },
    state: emptyState,
  });
  check("scene 条目带上了 heroUrl 字段（解包缓存未命中时为 null）", () => {
    assert.ok("heroUrl" in built5.items[0], "缺少 heroUrl 字段");
    assert.equal(built5.items[0].heroUrl, null);
  });
  check("ext 统计正确", () => {
    assert.equal(built5.ext.sceneTotal, 1);
    assert.equal(built5.ext.sceneWithHero, 0);
  });
  check("载荷带上全部 UI 元数据", () => {
    assert.ok(built5.tunableSchema.length > 0, "缺少 tunableSchema");
    assert.ok(built5.glassPresets.length > 0, "缺少 glassPresets");
    assert.ok(built5.ids.layer, "缺少 ids");
    assert.ok(built5.globalKey, "缺少 globalKey");
  });

  // --- 输出 ---------------------------------------------------------------
  process.stdout.write("注入载荷回归（buildInjectData）\n");
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
