/**
 * scene 贴图挑选与图片头读取的回归。
 *
 * 这两个函数决定了"从解包结果里挑哪张图当背景" —— 挑错了用户看到的是
 * 立绘的边角或者一张 256×256 的缩略图，而且**不会报任何错**。
 *
 * 实测教训：只按文件体积挑，32 个样本里只有 13 个选对。所以要按
 * ① `scene.json` 声明的 objects[].image ② 像素面积 的顺序挑。
 *
 * 用法： node test/verify-extract.mjs
 */

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { pickHeroTexture, readImageSize, cacheDirFor, readCachedExtract } from "../src/we-extract.mjs";

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
// 构造真实的图片头（不引图像库）
// ---------------------------------------------------------------------------

/** 一个合法的 PNG 文件（只有头部 + IHDR + IEND，足够读尺寸）。 */
function makePng(width, height, paddingBytes = 0) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type RGBA
  const ihdr = Buffer.concat([Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR", "ascii"), ihdrData, Buffer.alloc(4)]);
  const iend = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from("IEND", "ascii"), Buffer.alloc(4)]);
  return Buffer.concat([sig, ihdr, Buffer.alloc(paddingBytes), iend]);
}

/**
 * 一个**格式自洽**的 JPEG（SOI + APP0 + 可选的大 APPn + SOF0 + EOI）。
 *
 * ⚠️ 造 fixture 时容易犯两个"声明与实际不符"的错，两个都会伪装成"解析器坏了"：
 *   1. APP0 的段长度字段必须等于实际内容长度（JFIF 标准是 16）。
 *   2. JPEG **不允许**在段之间出现裸字节。想造"很大的头部"，必须把填充装进一个
 *      合法的段里（这里用 APP1，就是真实相机 EXIF 的位置）——
 *      否则解析器按段长正确跳转后，会落在裸零字节上（这是**正确的**拒绝行为）。
 */
function makeJpeg(width, height, paddingBytes = 0) {
  const soi = Buffer.from([0xff, 0xd8]);
  // APP0（JFIF）：FF E0 + 长度(2) + "JFIF\0"(5) + 版本(2) + 单位(1) + 密度(4) + 缩略图(2) = 16
  const app0 = Buffer.concat([
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.from("JFIF\0", "ascii"),
    Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  ]);
  // 可选的大段（APP1，模拟 EXIF）：长度字段 = 2 + 载荷长度
  let app1 = Buffer.alloc(0);
  if (paddingBytes > 0) {
    const payloadLen = Math.min(paddingBytes, 0xfffd - 2);
    app1 = Buffer.alloc(4 + payloadLen);
    app1[0] = 0xff;
    app1[1] = 0xe1;
    app1.writeUInt16BE(payloadLen + 2, 2);
    // 载荷保持零 —— 我们只关心"解析器能不能跳过它找到 SOF"
  }
  // SOF0：FF C0 + 长度(0x0011=17) + 精度(1) + 高(2) + 宽(2) + 分量数(1) + 分量(9) = 19
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, app1, sof, eoi]);
}

/** 一个合法的 GIF（"GIF89a" + 逻辑屏幕描述符）。 */
function makeGif(width, height) {
  const buf = Buffer.alloc(13);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** 一个合法的 BMP。 */
function makeBmp(width, height) {
  const buf = Buffer.alloc(54);
  buf.write("BM", 0, "ascii");
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  return buf;
}

/** 一个 VP8X WebP。 */
function makeWebp(width, height) {
  const buf = Buffer.alloc(30);
  buf.write("RIFF", 0, "ascii");
  buf.write("WEBP", 8, "ascii");
  buf.write("VP8X", 12, "ascii");
  // 24 位小端，值 = 实际尺寸 - 1
  buf[24] = (width - 1) & 0xff;
  buf[25] = ((width - 1) >> 8) & 0xff;
  buf[26] = ((width - 1) >> 16) & 0xff;
  buf[27] = (height - 1) & 0xff;
  buf[28] = ((height - 1) >> 8) & 0xff;
  buf[29] = ((height - 1) >> 16) & 0xff;
  return buf;
}

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wbwe-extract-"));
  try {
    // --- readImageSize ---------------------------------------------------
    const png = path.join(root, "a.png");
    await fsp.writeFile(png, makePng(3840, 2160));
    await checkAsync("readImageSize：PNG 尺寸", async () => {
      assert.deepEqual(await readImageSize(png), { width: 3840, height: 2160 });
    });

    const jpg = path.join(root, "a.jpg");
    await fsp.writeFile(jpg, makeJpeg(1920, 1080));
    await checkAsync("readImageSize：JPEG 尺寸", async () => {
      assert.deepEqual(await readImageSize(jpg), { width: 1920, height: 1080 });
    });

    const jpgBig = path.join(root, "big.jpg");
    await fsp.writeFile(jpgBig, makeJpeg(2560, 1440, 9000));
    await checkAsync("readImageSize：JPEG 即使有大量填充也能找到 SOF", async () => {
      assert.deepEqual(await readImageSize(jpgBig), { width: 2560, height: 1440 });
    });

    const gif = path.join(root, "a.gif");
    await fsp.writeFile(gif, makeGif(512, 288));
    await checkAsync("readImageSize：GIF 尺寸", async () => {
      assert.deepEqual(await readImageSize(gif), { width: 512, height: 288 });
    });

    const bmp = path.join(root, "a.bmp");
    await fsp.writeFile(bmp, makeBmp(800, 600));
    await checkAsync("readImageSize：BMP 尺寸", async () => {
      assert.deepEqual(await readImageSize(bmp), { width: 800, height: 600 });
    });

    const webp = path.join(root, "a.webp");
    await fsp.writeFile(webp, makeWebp(1024, 576));
    await checkAsync("readImageSize：WebP(VP8X) 尺寸", async () => {
      assert.deepEqual(await readImageSize(webp), { width: 1024, height: 576 });
    });

    const junk = path.join(root, "junk.bin");
    await fsp.writeFile(junk, Buffer.from("not an image at all, really"));
    await checkAsync("readImageSize：非图片返回 null 而不抛错", async () => {
      assert.equal(await readImageSize(junk), null);
    });
    await checkAsync("readImageSize：文件不存在返回 null", async () => {
      assert.equal(await readImageSize(path.join(root, "nope.png")), null);
    });
    await checkAsync("readImageSize：空文件返回 null", async () => {
      const empty = path.join(root, "empty.png");
      await fsp.writeFile(empty, Buffer.alloc(0));
      assert.equal(await readImageSize(empty), null);
    });

    // --- pickHeroTexture：没有 scene.json 时按面积挑 ----------------------
    const flat = path.join(root, "flat");
    await fsp.mkdir(flat, { recursive: true });
    // 注意：故意让"小的那张"字节数更大 —— 按体积挑会挑错
    await fsp.writeFile(path.join(flat, "small-heavy.jpg"), makeJpeg(256, 256, 50000));
    await fsp.writeFile(path.join(flat, "big-light.jpg"), makeJpeg(3840, 2160, 0));

    await checkAsync("pickHeroTexture：按像素面积挑（不受字节数误导）", async () => {
      const picked = await pickHeroTexture(flat);
      assert.ok(picked, "没挑出任何图");
      assert.ok(picked.endsWith("big-light.jpg"), `挑成了 ${path.basename(picked)}`);
    });

    // --- pickHeroTexture：有 scene.json 时按声明挑 ------------------------
    const withScene = path.join(root, "withscene");
    await fsp.mkdir(withScene, { recursive: true });
    await fsp.writeFile(path.join(withScene, "background.jpg"), makeJpeg(3840, 2160));
    await fsp.writeFile(path.join(withScene, "sparkle.jpg"), makeJpeg(4096, 4096)); // 面积更大
    const sceneJson = path.join(root, "scene.json");
    await fsp.writeFile(
      sceneJson,
      JSON.stringify({
        objects: [
          { id: 16, name: "background", image: "models/background.json", origin: "1920 1080 0" },
          { id: 17, name: "overlay", image: "models/overlay.json" },
        ],
      }),
    );

    await checkAsync("pickHeroTexture：优先按 scene.json 的 objects[].image 挑", async () => {
      const picked = await pickHeroTexture(withScene, { sceneJsonPath: sceneJson });
      assert.ok(picked.endsWith("background.jpg"), `挑成了 ${path.basename(picked)}（应为 scene.json 声明的 background）`);
    });

    await checkAsync("pickHeroTexture：scene.json 损坏时退化为按面积挑", async () => {
      const broken = path.join(root, "broken.json");
      await fsp.writeFile(broken, "{ not json");
      const picked = await pickHeroTexture(withScene, { sceneJsonPath: broken });
      // 面积最大的是 sparkle.jpg
      assert.ok(picked.endsWith("sparkle.jpg"), `挑成了 ${path.basename(picked)}`);
    });

    await checkAsync("pickHeroTexture：空目录返回 null", async () => {
      const emptyDir = path.join(root, "emptydir");
      await fsp.mkdir(emptyDir, { recursive: true });
      assert.equal(await pickHeroTexture(emptyDir), null);
    });

    await checkAsync("pickHeroTexture：目录不存在返回 null", async () => {
      assert.equal(await pickHeroTexture(path.join(root, "nope")), null);
    });

    // --- 缓存 ------------------------------------------------------------
    await checkAsync("readCachedExtract：没有缓存时返回 null", async () => {
      const cacheRoot = path.join(root, "cache");
      assert.equal(await readCachedExtract("no-such-id", { cacheRoot }), null);
    });

    await checkAsync("readCachedExtract：元数据在但图被删掉时视为无缓存（避免死链）", async () => {
      const cacheRoot = path.join(root, "cache2");
      const dir = cacheDirFor("item1", { cacheRoot });
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, "meta.json"),
        JSON.stringify({ heroPath: path.join(dir, "hero.jpg"), width: 100, height: 100 }),
      );
      // 故意不创建 hero.jpg
      assert.equal(await readCachedExtract("item1", { cacheRoot }), null);
    });

    await checkAsync("readCachedExtract：元数据损坏时返回 null 而不抛错", async () => {
      const cacheRoot = path.join(root, "cache3");
      const dir = cacheDirFor("item2", { cacheRoot });
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "meta.json"), "{ broken");
      assert.equal(await readCachedExtract("item2", { cacheRoot }), null);
    });

    await checkAsync("cacheDirFor：按 id 分目录", async () => {
      const cacheRoot = path.join(root, "cache4");
      assert.equal(cacheDirFor("123", { cacheRoot }), path.join(cacheRoot, "123"));
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }

  process.stdout.write("scene 贴图挑选与图片头读取回归\n");
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
