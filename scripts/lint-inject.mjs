/**
 * 注入脚本的静态体检。
 *
 * 为什么需要它：注入脚本跑在**另一个进程**里（WorkBuddy 的渲染进程），出了错
 * 只能在 devtools 控制台看到，而且很多错误的表现是"什么都没发生"。
 * 上游仓库有同样的工具（lint-menu.mjs），这里是它的等价物。
 *
 * 检查项：
 *   1. 分片里没有 `import` / `export`（不是模块）
 *   2. 分片里没有反引号 —— 历史红线：注入脚本里出现反引号会**静默截断**整段脚本
 *   3. 装配出来的完整表达式能通过 `new Function()` 语法检查
 *   4. payload 序列化后不含会在 `Runtime.evaluate` 里出问题的字符
 *   5. 关键能力都在（build / dispose / applyItem / getState）
 *   6. 数据里引用的节点 id 与常量一致
 *
 * 用法： node scripts/lint-inject.mjs
 * 退出码非 0 表示失败（可直接用于 CI）。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { DOM_IDS, GLOBAL_KEY, REPORT_BINDING } from "../src/constants.mjs";
import { buildInjectScript, lintScript, readInjectParts } from "../src/injector.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE;

const failures = [];
const notes = [];

function check(condition, message) {
  if (condition) notes.push(`  ✓ ${message}`);
  else failures.push(`  ✗ ${message}`);
}

// --- 1/2. 分片级约束 -------------------------------------------------------
let parts = "";
try {
  parts = await readInjectParts();
  notes.push("  ✓ 分片读取成功（无 import / export / 反引号）");
} catch (error) {
  failures.push(`  ✗ 分片约束检查失败：${error.message}`);
}

if (parts) {
  check(!/^\s*import[\s(]/m.test(parts) && !/\bimport\s*\(/.test(parts), "分片不含 import");
  check(!/^\s*export\s/m.test(parts), "分片不含 export");
  check(!parts.includes("`"), "分片不含反引号");
  // 行尾必须是 LF（CRLF 会让注入内容与预期字节不一致）
  check(!parts.includes("\r"), "分片行尾已规范化成 LF");
}

// --- 3. 完整表达式语法 -----------------------------------------------------
// 用一份**假数据**装配，避免真的去扫 Steam 库（体检要快、要能在没装 WE 的机器上跑）。
const fakeScan = {
  items: [
    {
      id: "1",
      title: "视频壁纸",
      kind: "video",
      rawType: "video",
      rating: "everyone",
      tags: [],
      source: "workshop",
      dir: "C:\\fake\\1",
      dirUrl: "file:///C:/fake/1",
      mediaPath: "C:\\fake\\1\\a.mp4",
      mediaUrl: "file:///C:/fake/1/a.mp4",
      pkgPath: null,
      pkgUrl: null,
      pkgBytes: 0,
      sceneJsonPath: null,
      sceneJsonUrl: null,
      webIndexPath: null,
      webIndexUrl: null,
      previewPath: "C:\\fake\\1\\preview.jpg",
      previewUrl: "file:///C:/fake/1/preview.jpg",
      sizeBytes: 1024,
      renderable: true,
    },
    {
      id: "2",
      title: "场景壁纸（含引号 \" 与反斜杠 \\ 与换行）",
      kind: "scene",
      rawType: "Scene",
      rating: "Everyone",
      tags: ["Anime"],
      source: "workshop",
      dir: "C:\\fake\\2",
      dirUrl: "file:///C:/fake/2",
      mediaPath: null,
      mediaUrl: null,
      pkgPath: "C:\\fake\\2\\scene.pkg",
      pkgUrl: "file:///C:/fake/2/scene.pkg",
      pkgBytes: 2048,
      sceneJsonPath: null,
      sceneJsonUrl: null,
      webIndexPath: null,
      webIndexUrl: null,
      previewPath: null,
      previewUrl: null,
      sizeBytes: 2048,
      renderable: true,
    },
  ],
  stats: { total: 2, renderable: 2 },
};

let built = null;
try {
  built = await buildInjectScript({ scan: fakeScan });
  notes.push(`  ✓ 注入脚本装配成功（${built.source.length} 字节）`);
} catch (error) {
  failures.push(`  ✗ 装配失败：${error.message}`);
}

if (built) {
  const lint = lintScript(built.source);
  check(lint.ok, `装配产物语法合法${lint.ok ? "" : "：" + lint.message}`);

  // --- 4. payload 安全性 ---------------------------------------------------
  // U+2028 / U+2029 在旧引擎里是行终止符，会截断表达式；`</script>` 会提前结束
  // 内联脚本（预览页要用它）。
  check(!/[\u2028\u2029]/.test(built.source), "不含 U+2028 / U+2029（会截断表达式）");
  check(!built.source.includes("</script"), "不含未转义的 </script");

  // 单个双引号必须被 JSON.stringify 正确转义（上面假数据里故意放了引号/反斜杠）
  check(built.source.includes('\\"'), "引号已转义");

  // --- 5. 关键能力存在性 ---------------------------------------------------
  const source = built.source;
  for (const symbol of ["dispose", "applyItem", "getState", "build", "renderPanel", "releaseScene", "releaseVideo"]) {
    check(new RegExp(`\\b${symbol}\\b`).test(source), `含关键能力 ${symbol}`);
  }

  // 幂等红线：卸载必须释放媒体
  check(/NS\.dispose\s*=/.test(source), "定义了 NS.dispose（幂等卸载入口）");
  check(/removeAttribute\("src"\)/.test(source), "释放视频时清了 src（否则解码器还在跑）");
  check(/sceneInstance\.destroy\(\)/.test(source), "释放 scene 时调了 destroy()（否则漏 WebGL 上下文）");

  // --- 6. id 一致性 --------------------------------------------------------
  for (const key of ["layer", "panel", "launcher", "style"]) {
    check(source.includes(JSON.stringify(DOM_IDS[key])), `注入了 DOM id ${DOM_IDS[key]}`);
  }
  check(built.data.globalKey === GLOBAL_KEY, `全局键一致（${GLOBAL_KEY}）`);
  check(built.data.reportBinding === REPORT_BINDING, `上报通道一致（${REPORT_BINDING}）`);

  // --- 7. 数据完整性 -------------------------------------------------------
  check(Array.isArray(built.data.items) && built.data.items.length === 2, "载荷带上了条目");
  check(built.data.state && typeof built.data.state === "object", "载荷带上了状态");
  check(Array.isArray(built.data.tunableSchema) && built.data.tunableSchema.length > 0, "载荷带上了可调项 schema");
}

// --- 输出 ------------------------------------------------------------------
process.stdout.write("注入脚本体检\n");
process.stdout.write("─".repeat(56) + "\n");
for (const line of notes) process.stdout.write(line + "\n");
if (failures.length) {
  process.stdout.write("\n失败项：\n");
  for (const line of failures) process.stdout.write(line + "\n");
  process.stdout.write(`\n结果：失败（${failures.length} 项）\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\n结果：通过（${notes.length} 项检查）\n`);
}
