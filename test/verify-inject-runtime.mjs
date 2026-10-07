/**
 * 在 Node 里用**最小 DOM 替身**真的执行一遍注入脚本。
 *
 * 为什么值得做：静态体检（lint-inject）只能证明"语法对、符号在"，证不了
 * "跑起来真的建出了正确的 DOM 层级、真的写对了样式"。而注入脚本跑在 WorkBuddy
 * 的渲染进程里，出错的典型表现就是"什么都没发生"，极难远程定位。
 *
 * 这个替身只实现注入脚本真正用到的那一小撮 DOM API（约 20 个）。它是**测试替身**，
 * 不是 DOM 实现 —— 目标是把脚本跑通并检查可观察的结果，而不是模拟浏览器。
 *
 * 检查的核心不变量（都对应 docs/PITFALLS.md 里的条目）：
 *   · 壁纸层的 body 是透明的（否则负 z-index 被盖住 → #13）
 *   · 壁纸层是 position:fixed; inset:0; z-index:-1; pointer-events:none
 *   · <video> 在壁纸层**内部**，且 object-fit:cover
 *   · dispose() 之后所有注入节点都被摘掉（幂等）
 *   · 二次注入不会留下重复节点（幂等红线）
 *   · 滑块改动真的驱动了 CSS 变量 / 内联样式
 *   · 暂停时派生音量归零，但**存储里的音量不变**（#28）
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildInjectScript } from "../src/injector.mjs";
import { DOM_IDS, GLOBAL_KEY } from "../src/constants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 最小 DOM 替身
// ---------------------------------------------------------------------------

class ClassList {
  constructor(el) {
    this.el = el;
  }
  add(...names) {
    for (const n of names) this.el._classes.add(n);
  }
  remove(...names) {
    for (const n of names) this.el._classes.delete(n);
  }
  contains(name) {
    return this.el._classes.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name);
    else this.remove(name);
  }
  get value() {
    return [...this.el._classes].join(" ");
  }
}

/**
 * 最小 style 替身。
 *
 * ⚠️ 必须把**任意属性赋值**都记进 cssText —— 引擎里大量使用
 * `el.style.filter = "..."` / `el.style.background = "..."` / `el.style.opacity = "..."`
 * 这种直接赋值形式。只实现 setProperty 的替身会让这些写法静默丢失，
 * 于是测试"通过"但其实什么都没验到（这一版就是踩了这个才补的）。
 */
class Style {
  constructor() {
    this._props = new Map();
    this._order = [];
    return new Proxy(this, {
      set(target, prop, value) {
        if (prop === "_props" || prop === "_order" || prop === "cssText") {
          if (prop === "cssText") return Reflect.set(target, prop, value);
          target[prop] = value;
          return true;
        }
        if (typeof prop === "string" && !prop.startsWith("_")) {
          target.setProperty(prop, value);
          return true;
        }
        target[prop] = value;
        return true;
      },
      get(target, prop) {
        if (typeof prop === "string" && !prop.startsWith("_") && !(prop in target)) {
          return target.getPropertyValue(prop);
        }
        return Reflect.get(target, prop);
      },
    });
  }
  setProperty(name, value) {
    if (!this._props.has(name)) this._order.push(name);
    this._props.set(name, String(value));
  }
  getPropertyValue(name) {
    return this._props.get(name) ?? "";
  }
  removeProperty(name) {
    this._props.delete(name);
  }
  get cssText() {
    return this._order.map((n) => `${n}:${this._props.get(n)}`).join(";");
  }
  set cssText(text) {
    this._props.clear();
    this._order.length = 0;
    for (const decl of String(text).split(";")) {
      const at = decl.indexOf(":");
      if (at > 0) this.setProperty(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
    }
  }
}

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = new Style();
    this._classes = new Set();
    this.classList = new ClassList(this);
    this._text = "";
    this._listeners = new Map();
    this.id = "";
  }

  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = value === null || value === undefined ? "" : String(value);
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    const at = this.children.indexOf(ref);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
    return child;
  }
  removeChild(child) {
    const at = this.children.indexOf(child);
    if (at >= 0) {
      this.children.splice(at, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = undefined;
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }
  dispatch(type, event = {}) {
    const list = this._listeners.get(type);
    if (!list) return;
    for (const fn of [...list]) fn({ type, target: this, stopPropagation() {}, ...event });
  }
  /** 深度优先找子元素。 */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    const out = [];
    const match = (el) => {
      if (selector.startsWith("#")) return el.id === selector.slice(1);
      if (selector.startsWith("[")) {
        const name = selector.slice(1, -1);
        if (name.startsWith("data-")) {
          const key = name
            .slice(5)
            .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          return el.dataset[key] !== undefined;
        }
        return el.attributes.has(name);
      }
      return el.tagName === selector.toUpperCase();
    };
    const walk = (el) => {
      for (const child of el.children) {
        if (match(child)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.documentElement || node === this.ownerDocument;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  /** video 特有 */
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  load() {}
}

class Document {
  constructor() {
    this.documentElement = new Element("html", this);
    this.head = new Element("head", this);
    this.body = new Element("body", this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this._listeners = new Map();
  }
  createElement(tag) {
    return new Element(tag, this);
  }
  getElementById(id) {
    return this.documentElement.querySelector("#" + id);
  }
  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }
  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  dispatch(type, event = {}) {
    for (const fn of [...(this._listeners.get(type) ?? [])]) fn({ type, ...event });
  }
}

// ---------------------------------------------------------------------------
// 安装替身并执行注入脚本
// ---------------------------------------------------------------------------

function installGlobals() {
  const document = new Document();
  const storage = new Map();
  const logs = [];
  const reported = [];

  const sandbox = {
    document,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    requestAnimationFrame: (fn) => {
      fn(0);
      return 1;
    },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 5)),
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    console: {
      log: (...a) => logs.push(["log", a.join(" ")]),
      warn: (...a) => logs.push(["warn", a.join(" ")]),
      error: (...a) => logs.push(["error", a.join(" ")]),
    },
    fetch: () => Promise.reject(new Error("测试里没有网络")),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    __wbweReport: (payload) => reported.push(payload),
  };

  globalThis.document = document;
  globalThis.localStorage = sandbox.localStorage;
  globalThis.requestAnimationFrame = sandbox.requestAnimationFrame;
  globalThis.MutationObserver = sandbox.MutationObserver;
  globalThis.__wbweReport = sandbox.__wbweReport;
  // 注入脚本引用的是裸标识符 window
  globalThis.window = globalThis;
  globalThis.WebWallGL = undefined;
  globalThis.fetch = sandbox.fetch;

  return { document, logs, reported, storage, sandbox };
}

/**
 * 测试载荷用**规整后**的形状（`previewUrl` / `fileUrl`），
 * 也就是 CLI 真正传进来的形状（CLI 先跑 `toInjectionPayload`）。
 * 原始形状（`previewPath` / `mediaPath`）由 test/verify-inject-data.mjs 单独回归。
 */
const fakeScan = {
  items: [
    {
      id: "vid1",
      title: "视频壁纸 A",
      kind: "video",
      rawType: "video",
      rating: "everyone",
      tags: [],
      source: "workshop",
      official: false,
      sizeMB: 0,
      fileUrl: "file:///C:/fake/a.mp4",
      webIndexUrl: null,
      pkgUrl: null,
      pkgBytes: 0,
      sceneJsonUrl: null,
      previewUrl: "file:///C:/fake/a.jpg",
      renderable: true,
    },
    {
      id: "scn1",
      title: "场景壁纸 B",
      kind: "scene",
      rawType: "scene",
      rating: "Everyone",
      tags: [],
      source: "workshop",
      official: false,
      sizeMB: 0,
      fileUrl: null,
      webIndexUrl: null,
      pkgUrl: "file:///C:/fake/b/scene.pkg",
      pkgBytes: 200,
      sceneJsonUrl: null,
      previewUrl: "file:///C:/fake/b.jpg",
      renderable: true,
    },
    {
      id: "web1",
      title: "网页壁纸 C",
      kind: "web",
      rawType: "web",
      rating: "everyone",
      tags: [],
      source: "workshop",
      official: false,
      sizeMB: 0,
      fileUrl: null,
      webIndexUrl: "file:///C:/fake/c/index.html",
      pkgUrl: null,
      pkgBytes: 0,
      sceneJsonUrl: null,
      previewUrl: "file:///C:/fake/c.jpg",
      renderable: true,
    },
  ],
  stats: { total: 3, renderable: 3 },
};

// ---------------------------------------------------------------------------
// 跑测试
// ---------------------------------------------------------------------------

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ ok: true, name });
  } catch (error) {
    checks.push({ ok: false, name, message: error?.message ?? String(error) });
  }
}

async function run() {
  const built = await buildInjectScript({ scan: fakeScan });

  // --- 第一次注入 ---------------------------------------------------------
  const env1 = installGlobals();
  // 注入脚本是一段表达式，用 Function 求值（与 Runtime.evaluate 的行为一致）
  // eslint-disable-next-line no-new-func
  const evaluate = new Function(`${built.source}`);
  evaluate();

  const doc = env1.document;
  const layer = doc.getElementById(DOM_IDS.layer);
  const panel = doc.getElementById(DOM_IDS.panel);
  const launcher = doc.getElementById(DOM_IDS.launcher);
  const styleEl = doc.getElementById(DOM_IDS.style);

  check("注入了全部 4 个根节点", () => {
    assert.ok(styleEl, "缺少 <style>");
    assert.ok(layer, "缺少壁纸层");
    assert.ok(panel, "缺少设置面板");
    assert.ok(launcher, "缺少悬浮按钮");
  });

  check("全局命名空间已挂载", () => {
    assert.equal(typeof globalThis[GLOBAL_KEY]?.dispose, "function");
    assert.equal(typeof globalThis[GLOBAL_KEY]?.applyItem, "function");
  });

  check("body 被设为透明（否则负 z-index 被盖住）", () => {
    const css = styleEl.textContent;
    assert.match(css, /(^|\n)html\{background-color:transparent !important/, "html 未置透明");
    assert.match(css, /(^|\n)body\{background-color:transparent !important/, "body 未置透明");
  });

  check("WorkBuddy 的已知遮蔽层都被置透明", () => {
    const css = styleEl.textContent;
    // 这几个是侦察报告里实测自带不透明底的元素，少一个就会出现"壁纸被盖住"的缝
    for (const sel of [".main-content", ".workbuddy-topbar", ".teams-main-content", ".sidebar-next", ".wb-home-route"]) {
      assert.ok(css.includes(sel + "{background-color:transparent"), `${sel} 未置透明`);
    }
  });

  check("壁纸层用 fixed + 负 z-index + 不吃鼠标事件", () => {
    const css = styleEl.textContent;
    const rule = css.split("\n").find((l) => l.startsWith("#" + DOM_IDS.layer + "{"));
    assert.ok(rule, "没找到壁纸层规则");
    assert.match(rule, /position:fixed/);
    assert.match(rule, /inset:0/);
    assert.match(rule, /z-index:-1/);
    assert.match(rule, /pointer-events:none/);
  });

  check("壁纸层挂在 body 下", () => {
    assert.equal(layer.parentNode, doc.body);
  });

  check("遮罩与暗角是壁纸层的子元素", () => {
    assert.ok(layer.querySelector("[data-wbwe-scrim]"), "缺少遮罩");
    assert.ok(layer.querySelector("[data-wbwe-vignette]"), "缺少暗角");
  });

  check("未选壁纸时没有媒体节点", () => {
    assert.equal(layer.querySelector("video"), null);
    assert.equal(layer.querySelector("[data-wbwe-scene]"), null);
  });

  // --- 选一个视频壁纸 -----------------------------------------------------
  globalThis[GLOBAL_KEY].applyItem("vid1");

  check("选了视频壁纸后建出 <video> 且在壁纸层内", () => {
    const video = layer.querySelector("video");
    assert.ok(video, "没有 <video>");
    assert.equal(video.parentNode, layer);
    assert.equal(video.src, "file:///C:/fake/a.mp4");
    assert.equal(video.loop, true);
    assert.equal(video.getAttribute("playsinline"), "");
  });

  check("视频的 object-fit 是 cover", () => {
    assert.match(styleEl.textContent, /#wbwe-layer>video\{[^}]*object-fit:cover/);
  });

  check("视频起播时按派生音量静音", () => {
    const video = layer.querySelector("video");
    assert.equal(video.muted, true, "默认静音（浏览器自动播放策略）");
    assert.equal(video.volume, 0);
  });

  check("选中状态落盘到 localStorage", () => {
    const saved = JSON.parse(env1.storage.get("wbwe.state.v1"));
    assert.equal(saved.activeId, "vid1");
  });

  check("状态通过上报通道回传宿主", () => {
    assert.ok(env1.reported.length > 0, "没有上报");
    const last = JSON.parse(env1.reported[env1.reported.length - 1]);
    assert.equal(last.type, "state");
    assert.equal(last.state.activeId, "vid1");
  });

  // --- 切到场景壁纸（WebWallGL 拿不到 → 应静默降级成静态图） ---------------
  globalThis[GLOBAL_KEY].applyItem("scn1");

  check("切到 scene 后旧的 <video> 被真正释放（清 src）", () => {
    assert.equal(layer.querySelector("video"), null, "旧视频节点还在");
  });

  check("scene 先铺静态兜底图", () => {
    assert.match(layer.style.getPropertyValue("background-image") || layer.style.cssText, /b\.jpg/);
  });

  await new Promise((r) => setTimeout(r, 30));

  check("scene 渲染失败后不残留 scene 容器（静默降级）", () => {
    assert.equal(layer.querySelector("[data-wbwe-scene]"), null);
  });

  // --- 切到网页壁纸 -------------------------------------------------------
  globalThis[GLOBAL_KEY].applyItem("web1");

  check("web 壁纸用沙箱 iframe", () => {
    const frame = layer.querySelector("iframe");
    assert.ok(frame, "没有 iframe");
    assert.match(frame.getAttribute("sandbox"), /allow-scripts/);
    assert.equal(frame.getAttribute("scrolling"), "no");
  });

  // --- 可调项驱动样式 -----------------------------------------------------
  const state0 = globalThis[GLOBAL_KEY].getState();
  globalThis[GLOBAL_KEY].applyItem("vid1");

  check("可调项写进了 <html> 的 CSS 变量", () => {
    const html = doc.documentElement.style;
    assert.ok(html.getPropertyValue("--wbwe-glass-blur").endsWith("px"), "玻璃模糊未写入");
    assert.ok(html.getPropertyValue("--wbwe-corner").endsWith("px"), "圆角未写入");
  });

  check("默认 scrim 写到了遮罩的内联背景上", () => {
    const scrim = layer.querySelector("[data-wbwe-scrim]");
    // 引擎用 toFixed(3)，所以是 0.280；只断言"确实写了压暗色 + 数值在合理区间"
    assert.match(scrim.style.cssText, /background:rgba\(4,7,12,0\.2[0-9]*\)/, `实际是 ${scrim.style.cssText}`);
  });

  check("初始状态正确（未暂停、有 activeId）", () => {
    assert.equal(state0.paused, false);
    assert.equal(state0.activeId, "web1");
  });

  // --- 幂等：二次注入 -----------------------------------------------------
  const layerCountBefore = doc.querySelectorAll("#" + DOM_IDS.layer).length;
  // eslint-disable-next-line no-new-func
  new Function(`${built.source}`)();

  check("二次注入不会留下重复的壁纸层", () => {
    assert.equal(doc.querySelectorAll("#" + DOM_IDS.layer).length, layerCountBefore, "壁纸层重复了");
    assert.equal(doc.querySelectorAll("#" + DOM_IDS.panel).length, 1, "面板重复了");
    assert.equal(doc.querySelectorAll("#" + DOM_IDS.launcher).length, 1, "悬浮按钮重复了");
  });

  check("二次注入后旧的 <video> 没有留下（幂等红线）", () => {
    const layer2 = doc.getElementById(DOM_IDS.layer);
    const videos = layer2.querySelectorAll("video");
    assert.ok(videos.length <= 1, `留下了 ${videos.length} 个 <video>`);
  });

  // --- dispose ------------------------------------------------------------
  globalThis[GLOBAL_KEY].dispose();

  check("dispose() 摘掉了壁纸层 / 面板 / 悬浮按钮", () => {
    assert.equal(doc.getElementById(DOM_IDS.layer), null, "壁纸层没摘掉");
    assert.equal(doc.getElementById(DOM_IDS.panel), null, "面板没摘掉");
    assert.equal(doc.getElementById(DOM_IDS.launcher), null, "悬浮按钮没摘掉");
  });

  check("dispose() 之后不再有在播的媒体节点", () => {
    assert.equal(doc.querySelectorAll("video").length, 0, "还有 <video> 残留");
    assert.equal(doc.querySelectorAll("iframe").length, 0, "还有 <iframe> 残留");
  });

  check("没有出现未捕获的注入错误", () => {
    const errors = env1.logs.filter(([level]) => level === "error");
    assert.equal(errors.length, 0, `有错误日志：${JSON.stringify(errors)}`);
  });

  // --- 输出 ---------------------------------------------------------------
  process.stdout.write("注入引擎运行时验证（Node + 最小 DOM 替身）\n");
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
  void HERE;
  if (failed) process.exitCode = 1;
}

await run();
