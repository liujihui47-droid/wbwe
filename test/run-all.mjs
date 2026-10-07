/**
 * 跑全部回归。
 *
 * 用法： node test/run-all.mjs
 *
 * 设计：每个测试文件是**独立进程**，失败互不影响；汇总退出码。
 * 之所以要分开跑而不是 import 到一起：注入运行时测试会污染全局
 * （`document` / `window` / `localStorage`），和别的测试同进程会互相干扰。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const SUITES = [
  { name: "单元（工具 / 状态 / 编码 / 平台）", script: "test/verify-units.mjs" },
  { name: "WE 库盘点（临时 fixture）", script: "test/verify-we-library.mjs" },
  { name: "scene 贴图挑选", script: "test/verify-extract.mjs" },
  { name: "vendored 资源与合规", script: "test/verify-vendor.mjs" },
  { name: "注入脚本静态体检", script: "scripts/lint-inject.mjs" },
  { name: "注入载荷装配", script: "test/verify-inject-data.mjs" },
  { name: "注入引擎运行时", script: "test/verify-inject-runtime.mjs" },
  { name: "CDP 客户端", script: "test/verify-cdp-client.mjs" },
  { name: "守护进程逻辑", script: "test/verify-guard.mjs" },
];

const results = [];

for (const suite of SUITES) {
  process.stdout.write(`\n${"=".repeat(64)}\n▶ ${suite.name}  (${suite.script})\n${"=".repeat(64)}\n`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(ROOT, suite.script)], {
    cwd: ROOT,
    // inherit 而不是 pipe：pipe 在受限沙箱里会 EPERM，而且测试输出本来就该直显
    stdio: "inherit",
    windowsHide: true,
  });
  const elapsed = Date.now() - started;
  results.push({ ...suite, code: result.status ?? 1, elapsed });
}

process.stdout.write(`\n${"=".repeat(64)}\n汇总\n${"=".repeat(64)}\n`);
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed += 1;
  process.stdout.write(`  ${ok ? "✓" : "✗"} ${r.name}  ${(r.elapsed / 1000).toFixed(1)}s\n`);
}
process.stdout.write(
  `\n${failed ? `失败：${failed}/${results.length} 个测试套件未通过` : `全部通过（${results.length} 个测试套件）`}\n`,
);
process.exitCode = failed ? 1 : 0;
