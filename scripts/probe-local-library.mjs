/**
 * 临时验证脚本：对**本机真实** Wallpaper Engine 库跑一次盘点。
 * 这不是回归测试（回归用 test/verify-we-library.mjs 的 fixture），
 * 而是开发期的"真机自检"，用来确认发现逻辑在真实环境下成立。
 *
 * 用法： node scripts/probe-local-library.mjs
 */

import { scanWeLibrary } from "../src/we-library.mjs";
import { humanSize } from "../src/util.mjs";

const result = await scanWeLibrary({ withSize: true });

console.log("=== Steam 库 ===");
for (const lib of result.libraries) console.log("  " + lib);
console.log("=== WE 内容目录 ===");
for (const d of result.contentDirs) console.log(`  [${d.kind}] ${d.dir}`);

console.log("\n=== 统计 ===");
console.log("  总条目     :", result.stats.total);
console.log("  可渲染     :", result.stats.renderable);
console.log("  有预览图   :", result.stats.withPreview);
console.log("  总体积     :", humanSize(result.stats.totalBytes));
console.log("  按类型     :", JSON.stringify(result.stats.byKind));

console.log("\n=== 条目明细 ===");
const pad = (s, n) => String(s).padEnd(n, " ");
for (const item of result.items) {
  console.log(
    [
      pad(item.kind, 11),
      pad(item.renderable ? "OK " : "-- ", 4),
      pad(item.id, 12),
      pad(humanSize(item.sizeBytes), 9),
      pad(item.previewUrl ? "预览" : "无预览", 7),
      item.title,
    ].join(" "),
  );
}

if (result.errors.length) {
  console.log("\n=== 错误 ===");
  for (const e of result.errors) console.log("  ", e.dir, e.message);
}

console.log("\n=== file:// 地址抽样（百分号编码自检）===");
for (const item of result.items.slice(0, 6)) {
  console.log(`  ${item.kind}: ${item.mediaUrl ?? item.webIndexUrl ?? item.pkgUrl ?? item.previewUrl}`);
}
