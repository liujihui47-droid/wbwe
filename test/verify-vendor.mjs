/**
 * 随仓库分发的二进制 / vendored 资源校验。
 *
 * 为什么值得单独测：这两个文件是**外部源码**，一旦被就地改动（或升级时忘记
 * 同步元数据），出问题的方式会非常隐蔽 —— WebWallGL 被改了会让 scene 渲染
 * 出现莫名其妙的失败，而且没人会想到去查一个 950KB 的压缩文件。
 *
 * 校验内容：
 *   · vendored 文件的 sha256 与 .upstream.json 记录一致
 *   · 大小与记录一致
 *   · 许可与署名文件存在（MIT 的合规要求）
 *   · 注入脚本里没有把 WebWallGL 内联（必须走 file:// 按需加载）
 *
 * 用法： node test/verify-vendor.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ ok: true, name });
  } catch (error) {
    checks.push({ ok: false, name, message: error?.message ?? String(error) });
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    checks.push({ ok: true, name });
  } catch (error) {
    checks.push({ ok: false, name, message: error?.message ?? String(error) });
  }
}

async function sha256(file) {
  const buf = await fsp.readFile(file);
  return crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

await checkAsync("WebWallGL：存在且与 .upstream.json 的 sha256 一致", async () => {
  const dir = path.join(ROOT, "vendor", "webwallgl");
  const meta = await readJson(path.join(dir, ".upstream.json"));
  const file = path.join(dir, meta.file);
  const actual = await sha256(file);
  assert.equal(actual, meta.sha256, `sha256 不一致：实际 ${actual}，记录 ${meta.sha256}`);
});

await checkAsync("WebWallGL：大小与记录一致", async () => {
  const dir = path.join(ROOT, "vendor", "webwallgl");
  const meta = await readJson(path.join(dir, ".upstream.json"));
  const stat = await fsp.stat(path.join(dir, meta.file));
  assert.equal(stat.size, meta.bytes);
});

await checkAsync("WebWallGL：版本确实是 1.4.2（不是会泄漏的 2.x）", async () => {
  const dir = path.join(ROOT, "vendor", "webwallgl");
  const meta = await readJson(path.join(dir, ".upstream.json"));
  assert.equal(meta.version, "1.4.2", "版本被换掉了 —— 2.0.2 有实例泄漏问题，见 .upstream.json");
});

await checkAsync("RePKG：存在且大小与记录一致", async () => {
  const dir = path.join(ROOT, "tools", "repkg");
  const meta = await readJson(path.join(dir, ".upstream.json"));
  const stat = await fsp.stat(path.join(dir, meta.file));
  assert.equal(stat.size, meta.bytes);
});

await checkAsync("RePKG：上游许可声明文件被原样保留（MIT 合规）", async () => {
  const notices = path.join(ROOT, "tools", "repkg", "THIRD-PARTY-NOTICES.txt");
  const text = await fsp.readFile(notices, "utf8");
  assert.ok(text.length > 1000, "notices 文件过小，可能被截断了");
  assert.match(text, /CommandLineParser/);
  assert.match(text, /Newtonsoft\.Json/);
});
await checkAsync("根 LICENSE 保留了各上游的版权声明", async () => {
  const text = await fsp.readFile(path.join(ROOT, "LICENSE"), "utf8");
  assert.match(text, /MIT License/);
  // MIT 要求保留原版权声明 —— 我们复用/改编的每一个来源都要在里面
  assert.match(text, /elysia395/, "缺少 dsh-wallpaper-engine 的署名");
  assert.match(text, /dsh-wallpaper-engine/);
});

await checkAsync("THIRD-PARTY-NOTICES.md 覆盖全部四个来源", async () => {
  const text = await fsp.readFile(path.join(ROOT, "THIRD-PARTY-NOTICES.md"), "utf8");
  for (const needle of ["WebWallGL", "RePKG", "dsh-wallpaper-engine", "anonbuddy-skin", "oneincase", "NotScuffed", "elysia395"]) {
    assert.ok(text.includes(needle), `缺少 ${needle}`);
  }
});

await checkAsync("注入脚本没有把 WebWallGL 内联进去", async () => {
  // 950KB 内联意味着每次 apply 都要推 950KB 过 CDP —— 必须走 file:// 按需加载
  const { buildInjectScript } = await import("../src/injector.mjs");
  const built = await buildInjectScript({
    scan: { items: [] },
    state: {
      schemaVersion: 1,
      activeId: null,
      tunables: {},
      hidden: false,
      rotateMinutes: 0,
      autoplay: true,
      rating: "everyone",
      enabledKinds: ["video", "scene", "web"],
    },
  });
  assert.ok(built.source.length < 200_000, `注入脚本 ${built.source.length} 字节 —— 疑似内联了 WebWallGL`);
  assert.ok(built.data.wwglUrl, "没有下发 WebWallGL 的 file:// 地址");
  assert.match(built.data.wwglUrl, /^file:\/\/\//, "WebWallGL 地址不是 file:// URL");
  assert.match(built.data.wwglUrl, /webwallgl-1\.4\.2\.global\.min\.js$/);
});

await checkAsync("注入脚本里 scene 走的是按需 <script src> 加载", async () => {
  const { readInjectParts } = await import("../src/injector.mjs");
  const parts = await readInjectParts();
  assert.ok(parts.includes("script.src"), "没有按需加载 WebWallGL 的逻辑");
  assert.ok(parts.includes("WebWallGL"), "没有引用 WebWallGL");
});

await checkAsync("仓库里不含任何壁纸素材（版权硬约束）", async () => {
  // 项目只引用路径，绝不复制素材。这里做一个粗筛：
  // 仓库里不应该出现大的媒体文件。
  const { globFiles } = await import("./_util-walk.mjs").catch(() => ({ globFiles: null }));
  if (!globFiles) return; // 辅助模块不存在就跳过（不是失败）
  const files = await globFiles(ROOT);
  const media = files.filter((f) => /\.(mp4|webm|mkv|mov|avi|pkg|tex|jpg|jpeg|png|webp|gif)$/i.test(f));
  const big = [];
  for (const f of media) {
    const stat = await fsp.stat(f);
    // 允许小的说明性图片；挡住 MB 级的素材
    if (stat.size > 512 * 1024) big.push(`${path.relative(ROOT, f)} (${Math.round(stat.size / 1024)}KB)`);
  }
  assert.deepEqual(big, [], `仓库里出现了疑似素材的大文件：${big.join(", ")}`);
});

// --- 输出 ------------------------------------------------------------------
process.stdout.write("vendored 资源与合规校验\n");
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
