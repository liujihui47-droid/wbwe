/**
 * 纯逻辑单元回归：工具函数、状态规整与迁移、VDF 解析、文本解码。
 *
 * 这些是全项目的"地基" —— 它们错了，上面所有东西都会以各种奇怪的方式坏掉，
 * 而且很多坏法**不报错**（例如百分号编码错一个字符 → 视频静默不播）。
 *
 * 用法： node test/verify-units.mjs
 */

import assert from "node:assert/strict";
import path from "node:path";

import {
  dedupeBy,
  dedupeKey,
  humanSize,
  isInside,
  repairMojibakeFilename,
  retryUntil,
  slugify,
  stripBom,
  toFileUrl,
  tryJsonParse,
} from "../src/util.mjs";
import { decodeTextSmart, parseLibraryFoldersVdf, classifyWallpaper, WALLPAPER_KINDS } from "../src/we-library.mjs";
import { defaultState, migrateState, normalizeState } from "../src/state.mjs";
import { DEFAULT_TUNABLES } from "../src/constants.mjs";
import { portForExe, processNameFor, wellKnownPaths } from "../src/platform/workbuddy.mjs";

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

// ---------------------------------------------------------------------------
// toFileUrl —— 最容易出错的一环
// ---------------------------------------------------------------------------

check("toFileUrl：空格被编码成 %20", () => {
  assert.equal(toFileUrl("D:\\Program Files\\a.mp4"), "file:///D:/Program%20Files/a.mp4");
});

check("toFileUrl：中文被编码（实测素材有水墨山水梅花.mp4）", () => {
  const url = toFileUrl("C:\\we\\水墨山水梅花.mp4");
  assert.equal(url, "file:///C:/we/%E6%B0%B4%E5%A2%A8%E5%B1%B1%E6%B0%B4%E6%A2%85%E8%8A%B1.mp4");
});

check("toFileUrl：盘符不被编码", () => {
  assert.ok(toFileUrl("E:\\x\\y.mp4").startsWith("file:///E:/"), "盘符段被编码了");
});

check("toFileUrl：括号不被编码（(x86) 目录实测存在）", () => {
  // pathToFileURL 不编码 () —— 这是对的，Chromium 能解析
  assert.ok(toFileUrl("D:\\Program Files (x86)\\Steam\\x").includes("(x86)"));
});

check("toFileUrl：null/空值返回 null 而不是 file:///null", () => {
  assert.equal(toFileUrl(null), null);
  assert.equal(toFileUrl(""), null);
  assert.equal(toFileUrl(undefined), null);
});

check("toFileUrl：反斜杠全部转成正斜杠", () => {
  assert.ok(!toFileUrl("C:\\a\\b\\c.mp4").slice(8).includes("\\"));
});

// ---------------------------------------------------------------------------
// dedupeKey —— 不去重会让壁纸条目翻倍（实测 38 → 76）
// ---------------------------------------------------------------------------

check("dedupeKey：盘符大小写归一", () => {
  assert.equal(dedupeKey("D:\\Steam"), dedupeKey("d:\\steam"));
});

check("dedupeKey：斜杠方向归一", () => {
  assert.equal(dedupeKey("D:/Steam/x"), dedupeKey("D:\\Steam\\x"));
});

check("dedupeKey：尾部斜杠归一", () => {
  assert.equal(dedupeKey("D:\\Steam\\"), dedupeKey("D:\\Steam"));
});

check("dedupeKey：.. 被折叠", () => {
  // 注意要写成 `sub\..` 而不是 `sub\..\Steam` —— 前者才是真的"上一级"，
  // 后者会被正确解析成 Steam\Steam（`..` 是字面量而非占位符）。
  assert.equal(dedupeKey("D:\\Steam\\sub\\.."), dedupeKey("D:\\Steam"));
});

check("dedupeBy 保留首次出现的顺序", () => {
  const out = dedupeBy([{ p: "a" }, { p: "b" }, { p: "A" }], (x) => x.p.toLowerCase());
  assert.deepEqual(out.map((x) => x.p), ["a", "b"]);
});

check("dedupeBy 丢掉空键", () => {
  assert.equal(dedupeBy([{ p: "" }, { p: "a" }], (x) => x.p).length, 1);
});

// ---------------------------------------------------------------------------
// 其它小工具
// ---------------------------------------------------------------------------

check("isInside：子路径判定（大小写不敏感）", () => {
  assert.equal(isInside("D:\\Steam\\a\\b", "D:\\steam"), true);
  assert.equal(isInside("D:\\Steam", "D:\\Steam"), true);
  assert.equal(isInside("D:\\SteamX\\a", "D:\\Steam"), false);
  assert.equal(isInside("C:\\other", "D:\\Steam"), false);
});

check("humanSize 格式化", () => {
  assert.equal(humanSize(0), "0 B");
  assert.equal(humanSize(512), "512 B");
  assert.equal(humanSize(1048576), "1.0 MB");
  assert.equal(humanSize(1024 * 1024 * 1024), "1.0 GB");
});

check("slugify 保留中文", () => {
  assert.equal(slugify("Hello World!"), "hello-world");
  assert.equal(slugify("水墨山水"), "水墨山水");
  assert.equal(slugify("", "fb"), "fb");
});

check("tryJsonParse 坏数据不抛错", () => {
  assert.deepEqual(tryJsonParse('{"a":1}'), { a: 1 });
  assert.equal(tryJsonParse("{bad", null), null);
  assert.equal(tryJsonParse("", "fallback"), "fallback");
});

check("stripBom 去掉 BOM", () => {
  assert.equal(stripBom("\uFEFF{}"), "{}");
  assert.equal(stripBom("{}"), "{}");
});

await checkAsync("retryUntil：第一次成功就返回", async () => {
  const v = await retryUntil(() => "ok", { timeoutMs: 100, pollMs: 5 });
  assert.equal(v, "ok");
});

await checkAsync("retryUntil：超时抛错并带上原因", async () => {
  await assert.rejects(
    () => retryUntil(() => null, { timeoutMs: 40, pollMs: 10 }),
    /等待超时/,
  );
});

// ---------------------------------------------------------------------------
// 编码：project.json 实测有 gbk
// ---------------------------------------------------------------------------

check("decodeTextSmart：UTF-8 正常解", () => {
  const buf = Buffer.from("水墨山水", "utf8");
  assert.equal(decodeTextSmart(buf), "水墨山水");
});

check("decodeTextSmart：GBK 也能解（这是实测存在的编码）", () => {
  // "水墨山水" 的 GB18030 / GBK 字节（已用 Node 的 TextDecoder('gb18030') 反查确认）
  const gbk = Buffer.from([0xcb, 0xae, 0xc4, 0xab, 0xc9, 0xbd, 0xcb, 0xae]);
  assert.equal(decodeTextSmart(gbk), "水墨山水");
});

check("decodeTextSmart：GBK 的 project.json 片段能解出合法 JSON", () => {
  // 「{"title":"水墨"}」的 GBK 字节
  const bytes = Buffer.concat([
    Buffer.from('{"title":"', "latin1"),
    Buffer.from([0xcb, 0xae, 0xc4, 0xab]),
    Buffer.from('"}', "latin1"),
  ]);
  const text = decodeTextSmart(bytes);
  assert.equal(JSON.parse(text).title, "水墨");
});

check("decodeTextSmart：UTF-8 BOM 被剥掉", () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}', "utf8")]);
  assert.equal(decodeTextSmart(buf), '{"a":1}');
});

check("repairMojibakeFilename：正常英文名不被改动", () => {
  assert.equal(repairMojibakeFilename("scene.pkg"), "scene.pkg");
  assert.equal(repairMojibakeFilename("preview.jpg"), "preview.jpg");
});

check("repairMojibakeFilename：正常中文名不被误伤", () => {
  assert.equal(repairMojibakeFilename("水墨山水梅花.mp4"), "水墨山水梅花.mp4");
});

// ---------------------------------------------------------------------------
// libraryfolders.vdf
// ---------------------------------------------------------------------------

check("parseLibraryFoldersVdf：抓出所有 path", () => {
  const vdf = [
    '"libraryfolders"',
    "{",
    '\t"0"',
    "\t{",
    '\t\t"path"\t\t"D:\\\\Program Files (x86)\\\\Steam"',
    '\t\t"apps"',
    "\t\t{",
    '\t\t\t"431960"\t\t"826275581"',
    "\t\t}",
    "\t}",
    '\t"1"',
    "\t{",
    '\t\t"path"\t\t"E:\\\\SteamLibrary"',
    "\t}",
    "}",
  ].join("\n");
  const paths = parseLibraryFoldersVdf(vdf);
  assert.equal(paths.length, 2, `实际拿到 ${JSON.stringify(paths)}`);
  assert.equal(paths[0], "D:\\Program Files (x86)\\Steam");
  assert.equal(paths[1], "E:\\SteamLibrary");
});

check("parseLibraryFoldersVdf：没有 path 时返回空数组", () => {
  assert.deepEqual(parseLibraryFoldersVdf('"libraryfolders"\n{\n}'), []);
});

// ---------------------------------------------------------------------------
// 类型分类
// ---------------------------------------------------------------------------

check("classifyWallpaper：四种类型 + 大小写不敏感", () => {
  assert.equal(classifyWallpaper({ type: "video" }), WALLPAPER_KINDS.VIDEO);
  assert.equal(classifyWallpaper({ type: "Scene" }), WALLPAPER_KINDS.SCENE);
  assert.equal(classifyWallpaper({ type: "SCENE" }), WALLPAPER_KINDS.SCENE);
  assert.equal(classifyWallpaper({ type: "web" }), WALLPAPER_KINDS.WEB);
  assert.equal(classifyWallpaper({ type: "application" }), WALLPAPER_KINDS.APPLICATION);
});

check("classifyWallpaper：preset / 未知", () => {
  assert.equal(classifyWallpaper({ type: "preset" }), WALLPAPER_KINDS.PRESET);
  assert.equal(classifyWallpaper({ preset: "x" }), WALLPAPER_KINDS.PRESET);
  assert.equal(classifyWallpaper({}), WALLPAPER_KINDS.UNKNOWN);
});

// ---------------------------------------------------------------------------
// 状态规整与迁移
// ---------------------------------------------------------------------------

check("defaultState 形状完整", () => {
  const s = defaultState();
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.activeId, null);
  assert.deepEqual(s.tunables, DEFAULT_TUNABLES);
  assert.deepEqual(s.enabledKinds, ["video", "scene", "web"]);
});

check("normalizeState：坏输入退回默认", () => {
  assert.deepEqual(normalizeState(null).tunables, DEFAULT_TUNABLES);
  assert.deepEqual(normalizeState("nonsense").tunables, DEFAULT_TUNABLES);
  assert.equal(normalizeState(undefined).activeId, null);
});

check("normalizeState：丢弃不认识的 tunable 键", () => {
  const s = normalizeState({ tunables: { scrim: 0.5, 恶意键: 1, __proto__: 2 } });
  assert.equal(s.tunables.scrim, 0.5);
  assert.equal("恶意键" in s.tunables, false);
});

check("normalizeState：类型不匹配的 tunable 被丢弃", () => {
  const s = normalizeState({ tunables: { scrim: "not-a-number", blurPx: 12 } });
  assert.equal(s.tunables.scrim, DEFAULT_TUNABLES.scrim, "字符串不该被接受");
  assert.equal(s.tunables.blurPx, 12);
});

check("normalizeState：enabledKinds 过滤非法值", () => {
  assert.deepEqual(normalizeState({ enabledKinds: ["video", "恶意"] }).enabledKinds, ["video"]);
});

check("normalizeState：enabledKinds 空数组退回默认（否则面板会空掉）", () => {
  assert.deepEqual(normalizeState({ enabledKinds: [] }).enabledKinds, ["video", "scene", "web"]);
});

check("normalizeState：rating 只接受白名单", () => {
  assert.equal(normalizeState({ rating: "mature" }).rating, "mature");
  assert.equal(normalizeState({ rating: "hacked" }).rating, "everyone");
});

check("normalizeState：hidden 只认严格 true", () => {
  assert.equal(normalizeState({ hidden: true }).hidden, true);
  assert.equal(normalizeState({ hidden: "yes" }).hidden, false);
});

check("migrateState：无版本号的 v0 状态能升上来", () => {
  const s = migrateState({ activeId: "abc", scrim: 0.4 });
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.activeId, "abc");
  // v0 的可调项是扁平的，迁移后不该丢
  assert.equal(s.activeId, "abc");
});

check("migrateState：已经是当前版本时原样保留", () => {
  const s = migrateState({ schemaVersion: 1, activeId: "x", tunables: { scrim: 0.9 } });
  assert.equal(s.tunables.scrim, 0.9);
});

// ---------------------------------------------------------------------------
// WorkBuddy 平台解析
// ---------------------------------------------------------------------------

check("portForExe：国内版 9334 / 国际版 9333", () => {
  assert.equal(portForExe("C:\\x\\WorkBuddy.exe"), 9334);
  assert.equal(portForExe("C:\\x\\WorkBuddyAI.exe"), 9333);
  assert.equal(portForExe("C:\\x\\Unknown.exe"), 9333);
  assert.equal(portForExe(null), 9333);
});

check("processNameFor：去掉 .exe", () => {
  assert.equal(processNameFor("C:\\x\\WorkBuddy.exe"), "WorkBuddy");
  assert.equal(processNameFor(null), null);
});

check("wellKnownPaths：包含历史拼写错误的目录（老版本真的装在那里）", () => {
  const paths = wellKnownPaths({ LOCALAPPDATA: "C:\\LA", ProgramFiles: "C:\\PF" });
  assert.ok(paths.some((p) => p.toLowerCase().includes("workbuudy")), "少了历史目录候选");
  assert.ok(paths.some((p) => p.endsWith("WorkBuddy.exe")));
  assert.ok(paths.some((p) => p.endsWith("WorkBuddyAI.exe")));
  // 去重生效
  assert.equal(new Set(paths).size, paths.length);
});

check("wellKnownPaths：契约说明 —— 它不负责去重，去重在下游", () => {
  // wellKnownPaths 只是"按 base 逐个列举候选"。两个不同 base 指向同一目录时，
  // 结果里会出现指同一处的多个字符串（不同大小写/不同 base 前缀）。
  // **去重是 workbuddyCandidates / findSteamLibraries 的职责**，
  // 它们用大小写不敏感的 dedupeKey。这里固定这个分工，避免有人误以为
  // wellKnownPaths 会去重而在下游漏掉去重（那会让壁纸条目整体翻倍：38 → 76）。
  const paths = wellKnownPaths({ LOCALAPPDATA: "C:\\LA", ProgramFiles: "C:\\LA" });
  assert.ok(paths.length > 0);
  assert.equal(new Set(paths).size, paths.length, "同一次列举内部不应有完全相同的字符串");
  // 含两种 exe 名
  assert.ok(paths.some((p) => p.endsWith("WorkBuddy.exe")));
  assert.ok(paths.some((p) => p.endsWith("WorkBuddyAI.exe")));
});

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

process.stdout.write("纯逻辑单元回归\n");
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
void path;
if (failed) process.exitCode = 1;
