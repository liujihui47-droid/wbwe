/*
 * 注入到 WorkBuddy 渲染进程的壁纸引擎。
 *
 * ⚠️ 这是一个"脚本分片"，不是 ES 模块：
 *   · 不许出现 import / export
 *   · 不许出现反引号（历史上的坑：注入脚本里注释带反引号会静默截断整段脚本）
 *   · 通过字符串拼接装配，因此里面的转义不会被"吃掉一层"
 * 体检工具：scripts/lint-inject.mjs
 *
 * 职责边界：本文件只负责**渲染进程内**的事 —— 铺壁纸、放设置面板、写状态。
 * 它不做任何文件系统访问（渲染进程也做不了），所有素材信息由 payload 带进来，
 * 且**只带路径不带字节**（WE 素材动辄几百 MB）。
 */

const D = data;
const NS = (window[D.globalKey] = window[D.globalKey] || {});

// ---------------------------------------------------------------------------
// 0. 幂等收尾：把上一个实例彻底停掉
// ---------------------------------------------------------------------------
// 只删 DOM 节点是不够的 —— 旧的 MutationObserver、定时器、以及**在播的媒体解码器**
// 都还活着。实测症状是"pause 之后设置又自己回来了"、"重复 apply 留下两个叠在一起
// 的视频在响"。所以顺序必须是：先停旧实例，再建新的。
try {
  if (typeof NS.dispose === "function") NS.dispose();
} catch (e) {
  console.warn("[wbwe] 卸载上一个实例失败（忽略）：", e);
}

const state = {
  // 当前选中的壁纸条目 id（null = 不显示壁纸）
  activeId: D.state.activeId || null,
  // 可调项：浅拷贝一份，避免直接改 payload
  tunables: Object.assign({}, D.state.tunables),
  // 是否暂停（视频/scene 都受影响）
  paused: D.state.hidden === true,
  // 是否隐藏背景（临时把整层藏起来，但保留选择）
  hidden: D.state.hidden === true,
  rotateMinutes: D.state.rotateMinutes || 0,
  autoplay: D.state.autoplay !== false,
  rating: D.state.rating || "everyone",
  enabledKinds: D.state.enabledKinds || ["video", "scene", "web"],
  // 面板是否展开
  panelOpen: false,
};

let disposed = false;
let layer = null;        // 背景媒体层根节点
let scrimEl = null;      // 压暗遮罩
let vignetteEl = null;   // 暗角
let mediaEl = null;      // 当前 <video>（静态图不用节点，直接当 layer 的 background）
let sceneHolder = null;  // 承载 WebWallGL canvas 的容器
let sceneInstance = null; // WebWallGL 渲染实例
let sceneGeneration = 0;  // 世代号：作废"在飞的"异步渲染
let styleEl = null;
let panelEl = null;
let launcherEl = null;
let statusEl = null;
let rotateTimer = 0;
let cleanupFns = [];

const itemsById = Object.create(null);
for (let i = 0; i < D.items.length; i += 1) {
  itemsById[D.items[i].id] = D.items[i];
}

// ---------------------------------------------------------------------------
// 1. 工具
// ---------------------------------------------------------------------------

function h(tag, css, attrs) {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css;
  if (attrs) {
    for (const key in attrs) {
      if (key === "text") el.textContent = attrs[key];
      else if (key === "dataset") for (const dk in attrs.dataset) el.dataset[dk] = attrs.dataset[dk];
      else el.setAttribute(key, attrs[key]);
    }
  }
  return el;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// 面板上的 0..100 滑块 → 实际值
function fromSlider(spec, pct) {
  return spec.min + ((spec.max - spec.min) * clamp(pct, 0, 100)) / 100;
}

// 实际值 → 0..100 滑块
function toSlider(spec, value) {
  if (spec.max === spec.min) return 0;
  return clamp(Math.round(((value - spec.min) / (spec.max - spec.min)) * 100), 0, 100);
}

function fmtValue(spec, value) {
  let text;
  if (Number.isInteger(spec.step) && spec.step >= 1) text = String(Math.round(value));
  else text = (Math.round(value * 100) / 100).toFixed(2);
  return spec.unit ? text + spec.unit : text;
}

// ---------------------------------------------------------------------------
// 2. 持久化
// ---------------------------------------------------------------------------
// 两条路都写：
//   · 宿主的 state.json（通过 CDP binding 回传）—— 权威真源，跨重启保留
//   · localStorage —— binding 不在场时（用户手跑一次 apply 就退出）的兜底
const LS_KEY = "wbwe.state.v1";

function persist() {
  const snapshot = {
    activeId: state.activeId,
    tunables: state.tunables,
    hidden: state.hidden,
    rotateMinutes: state.rotateMinutes,
    autoplay: state.autoplay,
    rating: state.rating,
    enabledKinds: state.enabledKinds,
  };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(snapshot));
  } catch (e) {
    /* 配额满 / 隐私模式：不影响本次会话 */
  }
  try {
    const report = window[D.reportBinding];
    if (typeof report === "function") report(JSON.stringify({ type: "state", state: snapshot }));
  } catch (e) {
    /* binding 不在场是常态，不是错误 */
  }
}

function restoreSnapshot() {
  // payload 里的 state 已经由宿主从 state.json 读好，优先信它，
  // 只有"宿主没给出选择"时才回头看 localStorage。
  if (state.activeId) return;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved && saved.activeId && itemsById[saved.activeId]) {
      state.activeId = saved.activeId;
      if (saved.tunables) {
        for (const key in saved.tunables) {
          if (key in state.tunables && typeof saved.tunables[key] === "number") {
            state.tunables[key] = saved.tunables[key];
          }
        }
      }
      if (typeof saved.rotateMinutes === "number") state.rotateMinutes = saved.rotateMinutes;
      if (typeof saved.rating === "string") state.rating = saved.rating;
      if (saved.enabledKinds && saved.enabledKinds.length) state.enabledKinds = saved.enabledKinds;
    }
  } catch (e) {
    /* 坏数据就当没有 */
  }
}

// ---------------------------------------------------------------------------
// 3. CSS
// ---------------------------------------------------------------------------
// ⚠️ 关键不变量（见 docs/PITFALLS.md #13）：
//   body 必须有透明背景，否则负 z-index 的壁纸层会被 body 的不透明底整个盖住。
//   实测整屏只差 34/160000 字节 —— 看起来就是"壁纸没生效"，极难定位。
//
// 下面这一组选择器来自**对 WorkBuddy 5.7.6 的实测侦察**（见 docs/WORKBUDDY-DOM.md）：
// 这些元素都自带不透明底，都在壁纸层**之上**绘制，必须逐个置透明，
// 否则壁纸只在"没有被它们盖住"的缝隙里露出来。
const OCCLUDERS = [
  "html",
  "body",
  // 主页内容区：background = var(--wb-home-bg-secondary) → #fff(浅) / #141414(深)
  ".main-content",
  ".main-content--initializing",
  ".workbuddy-topbar",
  ".teams-top-bar",
  ".teams-content-wrapper",
  ".teams-main-content",
  ".wb-home-route",
  // 侧边栏（Windows 无边框标题栏形态）自带 --color-bg-primary-default
  ".sidebar-next",
  ".sidebar-next--windows-chrome",
  "#skeleton-root",
];

const CSS_TEXT = [
  // 遮蔽层透明化。用 !important 是必须的：这些底多半是内联或高优先级 var() 声明。
  OCCLUDERS.map(function (sel) {
    return sel + "{background-color:transparent !important;background-image:none !important;}";
  }).join("\n"),
  // 可选：把侧栏 / 输入框的毛玻璃一起关掉（某些壁纸下玻璃会显脏）。默认关闭。
  "[data-wbwe-noblur='1'] .sidebar-next,[data-wbwe-noblur='1'] .cr-input-container{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}",
  // 壁纸层：固定铺满、负 z-index、不吃鼠标事件。
  // 用负 z-index 而不是高 z-index：WorkBuddy 的 #root 自带层叠上下文，
  // 负 z-index 层天然落在它之下，且换壁纸时怎么 append 都不会打乱层级。
  "#" + D.ids.layer + "{position:fixed;inset:0;z-index:-1;pointer-events:none;background-color:#0b0f16;background-position:center center;background-repeat:no-repeat;background-size:cover;transition:opacity .3s ease;}",
  // 壁纸层：固定铺满、负 z-index、不吃鼠标事件。
  // 用负 z-index 而不是高 z-index：WorkBuddy 的 #root 是 position:relative;z-index:0，
  // 自带层叠上下文，负 z-index 层天然落在它之下，且换壁纸时怎么 append 都不会打乱层级。
  "#" + D.ids.layer + "{position:fixed;inset:0;z-index:-1;pointer-events:none;background-color:#0b0f16;background-position:center center;background-repeat:no-repeat;background-size:cover;transition:opacity .3s ease;}",
  "#" + D.ids.layer + ">video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;}",
  "#" + D.ids.layer + ">[" + "data-wbwe-scene]{position:absolute;inset:0;pointer-events:none;opacity:0;transition:opacity .45s ease;}",
  "#" + D.ids.layer + ">[" + "data-wbwe-scrim]{position:absolute;inset:0;pointer-events:none;}",
  "#" + D.ids.layer + ">[" + "data-wbwe-vignette]{position:absolute;inset:0;pointer-events:none;}",
  "#" + D.ids.layer + "[data-wbwe-hidden='1']{opacity:0;}",
  // 悬浮按钮
  "#" + D.ids.launcher + "{position:fixed;z-index:2147483000;right:14px;bottom:14px;display:flex;gap:6px;align-items:center;font:500 12px/1.4 system-ui,'Microsoft YaHei',sans-serif;user-select:none;}",
  "#" + D.ids.launcher + " button{width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.28);background:rgba(20,24,32,.55);color:#fff;cursor:pointer;font-size:15px;line-height:1;padding:0;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);}",
  "#" + D.ids.launcher + " button:hover{background:rgba(30,36,48,.7);}",
  // 设置面板（iOS 液态玻璃观感：模糊 + 半透明釉色 + 细描边 + 顶部高光）
  "#" + D.ids.panel + "{position:fixed;z-index:2147483001;right:14px;bottom:58px;width:336px;max-height:min(74vh,660px);overflow-y:auto;overscroll-behavior:contain;display:none;padding:0;color:#eef2f8;font:500 12px/1.5 system-ui,'Microsoft YaHei',sans-serif;border-radius:var(--wbwe-corner,14px);border:1px solid rgba(255,255,255,var(--wbwe-glass-border,.35));background:rgba(16,20,28,var(--wbwe-glass-alpha,.5));backdrop-filter:blur(var(--wbwe-glass-blur,22px)) saturate(1.3) brightness(1.04);-webkit-backdrop-filter:blur(var(--wbwe-glass-blur,22px)) saturate(1.3) brightness(1.04);box-shadow:0 18px 48px rgba(0,0,0,.42);}",
  "#" + D.ids.panel + "[data-wbwe-open='1']{display:block;}",
  "#" + D.ids.panel + " .wbwe-h{padding:11px 13px;font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,calc(var(--wbwe-glass-border,.35)*.6));}",
  "#" + D.ids.panel + " .wbwe-b{padding:10px 13px 14px;}",
  "#" + D.ids.panel + " .wbwe-cap{margin:12px 0 6px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.62;}",
  "#" + D.ids.panel + " .wbwe-cap:first-child{margin-top:2px;}",
  "#" + D.ids.panel + " .wbwe-row{display:flex;align-items:center;gap:9px;margin:7px 0;}",
  "#" + D.ids.panel + " .wbwe-row label{flex:0 0 68px;opacity:.86;}",
  "#" + D.ids.panel + " .wbwe-row input[type=range]{flex:1;min-width:0;height:18px;-webkit-appearance:none;appearance:none;background:transparent;}",
  "#" + D.ids.panel + " .wbwe-row input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:rgba(255,255,255,.26);}",
  "#" + D.ids.panel + " .wbwe-row input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#fff;border:1px solid rgba(0,0,0,.25);box-shadow:0 1px 4px rgba(0,0,0,.35);}",
  "#" + D.ids.panel + " .wbwe-val{flex:0 0 46px;text-align:right;opacity:.8;font-variant-numeric:tabular-nums;}",
  "#" + D.ids.panel + " .wbwe-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;}",
  "#" + D.ids.panel + " .wbwe-card{position:relative;border-radius:9px;overflow:hidden;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);cursor:pointer;padding:0;aspect-ratio:16/9;}",
  "#" + D.ids.panel + " .wbwe-card img{width:100%;height:100%;object-fit:cover;display:block;}",
  "#" + D.ids.panel + " .wbwe-card[data-wbwe-sel='1']{outline:2px solid #6ab0ff;outline-offset:1px;}",
  "#" + D.ids.panel + " .wbwe-card[data-wbwe-off='1']{opacity:.38;}",
  "#" + D.ids.panel + " .wbwe-badge{position:absolute;left:4px;top:4px;padding:1px 5px;border-radius:5px;background:rgba(0,0,0,.62);font-size:10px;letter-spacing:.02em;}",
  "#" + D.ids.panel + " .wbwe-btns{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px;}",
  "#" + D.ids.panel + " .wbwe-btn{flex:1 1 auto;padding:6px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.09);color:inherit;cursor:pointer;font:inherit;}",
  "#" + D.ids.panel + " .wbwe-btn:hover{background:rgba(255,255,255,.17);}",
  "#" + D.ids.panel + " .wbwe-btn[data-wbwe-on='1']{background:rgba(106,176,255,.3);border-color:rgba(106,176,255,.6);}",
  "#" + D.ids.panel + " .wbwe-note{opacity:.58;font-size:11px;margin-top:8px;}",
  "#" + D.ids.panel + " .wbwe-list{max-height:216px;overflow-y:auto;padding-right:2px;}",
  "@media (prefers-reduced-motion: reduce){#" + D.ids.layer + ",#" + D.ids.panel + "{transition:none;}}",
].join("\n");

// ---------------------------------------------------------------------------
// 4. 可调项 → 样式
// ---------------------------------------------------------------------------
// ⚠️ 性能纪律（见 docs/PITFALLS.md #14）：
//   在 <html> 上写 CSS 自定义属性会触发**全文档**样式重算（实测 2269 元素 ≈ 23ms/次）。
//   所以"每帧都会变的量"（模糊、暗度、暗角）一律写**真实元素的内联 style**；
//   只有低频的颜色类才走 CSS 变量。
function applyTunables() {
  if (!layer) return;
  const t = state.tunables;

  // 背景不透明度
  layer.style.opacity = String(clamp(t.opacity, 0, 1));

  // 背景模糊：反向外扩，否则视口四边会露出未模糊的边框（实测可见白边）
  const blur = clamp(t.blurPx, 0, 60);
  if (blur >= 0.5) {
    layer.style.filter =
      "blur(" + blur.toFixed(2) + "px) saturate(" + clamp(t.saturation, 0, 2).toFixed(2) + ") brightness(" + clamp(t.brightness, 0, 2).toFixed(2) + ")";
    const grow = (-2 * blur).toFixed(2) + "px";
    layer.style.inset = grow;
  } else {
    // 注意：blur(0px) 也会创建一个全屏合成层（白耗 GPU），所以低于阈值就整个摘掉。
    const sat = clamp(t.saturation, 0, 2);
    const bri = clamp(t.brightness, 0, 2);
    layer.style.filter = sat === 1 && bri === 1 ? "" : "saturate(" + sat.toFixed(2) + ") brightness(" + bri.toFixed(2) + ")";
    layer.style.inset = "0px";
  }

  if (scrimEl) scrimEl.style.background = "rgba(4,7,12," + clamp(t.scrim, 0, 1).toFixed(3) + ")";

  if (vignetteEl) {
    const v = clamp(t.vignette, 0, 1);
    vignetteEl.style.background =
      v <= 0.001 ? "" : "radial-gradient(ellipse at center, rgba(0,0,0,0) 42%, rgba(0,0,0," + (v * 0.86).toFixed(3) + ") 100%)";
  }

  // 玻璃类：低频（只在拖动玻璃滑块时变），走 CSS 变量即可。
  const root = document.documentElement;
  root.style.setProperty("--wbwe-glass-blur", clamp(t.glassBlurPx, 0, 60) + "px");
  root.style.setProperty("--wbwe-glass-alpha", clamp(t.glassAlpha, 0, 0.95).toFixed(3));
  root.style.setProperty("--wbwe-glass-border", clamp(t.glassBorder, 0, 1).toFixed(3));
  root.style.setProperty("--wbwe-corner", clamp(t.cornerPx, 0, 32) + "px");

  // 音量：**派生值**，绝不把"暂停"实现成 volume=0 ——
  // 那会把用户设的音量一起写进存储，暂停后声音永久消失（实测踩过）。
  applyVolume();
}

function effectiveVolume() {
  if (state.paused || state.hidden) return 0;
  const t = state.tunables;
  return t.muted ? 0 : clamp(t.volume, 0, 1);
}

function applyVolume() {
  const vol = effectiveVolume();
  // ⚠️ 用 DOM 兜底选元素：切壁纸/重建 <video> 的时序里，JS 引用可能已与真实节点脱钩。
  //    实测症状：存储写对了、muted 也变了，唯独 volume 停在 0。
  const video = mediaEl && mediaEl.isConnected ? mediaEl : layer ? layer.querySelector("video") : null;
  if (video) {
    try {
      video.volume = vol;
      video.muted = vol <= 0;
      const rate = clamp(state.tunables.rate === undefined ? 1 : state.tunables.rate, 0.5, 2);
      video.playbackRate = rate;
    } catch (e) {
      /* 元素正在被销毁 */
    }
  }
  if (sceneInstance) {
    // scene 壁纸没有 <video>，声音只走 WebWallGL 实例
    try {
      if (typeof sceneInstance.setVolume === "function") sceneInstance.setVolume(vol);
    } catch (e) {
      /* 实例已释放 */
    }
  }
}

// ---------------------------------------------------------------------------
// 5. 媒体层
// ---------------------------------------------------------------------------

function releaseVideo() {
  if (!mediaEl) return;
  const video = mediaEl;
  mediaEl = null;
  try {
    video.pause();
    // ⚠️ 只把节点从 DOM 摘掉，解码器可能还在跑；必须清 src 再 load()。
    video.removeAttribute("src");
    video.load();
  } catch (e) {
    /* 已销毁 */
  }
  try {
    video.remove();
  } catch (e) {
    /* 已移除 */
  }
}

function releaseScene() {
  // 世代号自增 → 所有"在飞的" renderScene 会在下一个 await 后早退
  sceneGeneration += 1;
  if (sceneInstance) {
    try {
      // destroy() 是唯一会停渲染循环并释放 WebGL 上下文的动作。
      // 漏掉 = 漏上下文（浏览器同页上下文数量有限）+ 叠渲染循环。
      sceneInstance.destroy();
    } catch (e) {
      /* 已销毁 */
    }
    sceneInstance = null;
  }
  if (sceneHolder) {
    try {
      sceneHolder.remove();
    } catch (e) {
      /* 已移除 */
    }
    sceneHolder = null;
  }
}

function releaseMedia() {
  releaseVideo();
  releaseScene();
}

// 静态图：直接写 layer 的 background-image（不建节点，最省）
function setStaticImage(url) {
  if (!layer) return;
  if (url) {
    layer.style.backgroundImage = "url(" + JSON.stringify(url) + ")";
  } else {
    layer.style.backgroundImage = "";
  }
}

function setVideo(item) {
  if (!layer || !item.fileUrl) return;
  const video = document.createElement("video");
  video.src = item.fileUrl;          // file:// 直读，零拷贝
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.preload = "auto";
  // 浏览器不允许非静音自动播放 → 先按"派生音量"起播，用户开声音时已有手势
  const vol = effectiveVolume();
  video.muted = vol <= 0;
  video.volume = vol;
  video.style.opacity = "0";
  video.style.transition = "opacity .4s ease";
  layer.appendChild(video);
  mediaEl = video;
  video.addEventListener("loadeddata", function () {
    video.style.opacity = "1";
  });
  syncPlayback();
}

function syncPlayback() {
  const video = mediaEl && mediaEl.isConnected ? mediaEl : layer ? layer.querySelector("video") : null;
  if (video) {
    if (state.paused || state.hidden) {
      try {
        video.pause();
      } catch (e) {
        /* 已销毁 */
      }
    } else {
      const p = video.play();
      // 自动播放被拒是正常的（策略），静默吞掉即可
      if (p && typeof p.catch === "function") p.catch(function () {});
    }
  }
  if (sceneInstance) {
    try {
      if (state.paused || state.hidden) {
        if (typeof sceneInstance.pause === "function") sceneInstance.pause();
      } else if (typeof sceneInstance.resume === "function") {
        sceneInstance.resume();
      }
    } catch (e) {
      /* 实例已释放 */
    }
  }
}

// 带超时的 fetch：file:// 大包 + 慢盘时不能无限挂
function fetchWithTimeout(url, ms) {
  return new Promise(function (resolve, reject) {
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error("fetch 超时 " + ms + "ms"));
    }, ms);
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.arrayBuffer();
      })
      .then(function (buf) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(buf);
      })
      .catch(function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

let libPromise = null;

function loadWebWallGL() {
  if (window.WebWallGL) return Promise.resolve(window.WebWallGL);
  if (libPromise) return libPromise;
  if (!D.wwglUrl) return Promise.reject(new Error("没有 WebWallGL 地址"));
  libPromise = new Promise(function (resolve, reject) {
    const script = document.createElement("script");
    script.dataset.wbweWwgl = "1";
    script.src = D.wwglUrl;
    script.onload = function () {
      if (window.WebWallGL) resolve(window.WebWallGL);
      else reject(new Error("WebWallGL 未挂到 window"));
    };
    script.onerror = function () {
      reject(new Error("WebWallGL 加载失败"));
    };
    document.head.appendChild(script);
  }).catch(function (err) {
    libPromise = null; // 允许下次重试
    throw err;
  });
  return libPromise;
}

/*
 * 渲染一个 scene 壁纸。**不要 await 它** —— 调用方必须立刻返回，
 * 静态贴图先顶上，真渲染好了再淡入顶替（渐进增强）。
 */
function renderScene(item) {
  if (!layer || !item.pkgUrl || !D.wwglUrl) return;
  const myId = item.id;
  const myGeneration = (releaseScene(), sceneGeneration);

  const holder = h("div", "", { dataset: { wbweScene: "1" } });
  layer.appendChild(holder);
  sceneHolder = holder;

  let bufPromise;
  try {
    // 60s 超时：实测复杂场景最慢 9.1s，给慢机器和大包留数倍余量
    bufPromise = fetchWithTimeout(item.pkgUrl, 60000);
  } catch (e) {
    return;
  }

  bufPromise
    .then(function (buffer) {
      // 每个 await 之后都要重新比对 —— 用户可能在解析期间切走了
      if (disposed || myGeneration !== sceneGeneration || state.activeId !== myId) return null;
      return loadWebWallGL().then(function (lib) {
        return { lib: lib, buffer: buffer };
      });
    })
    .then(function (ctx) {
      if (!ctx) return null;
      if (disposed || myGeneration !== sceneGeneration || state.activeId !== myId) return null;
      const lib = ctx.lib;
      if (typeof lib.mount !== "function") throw new Error("WebWallGL.mount 不可用");
      // bytesSource(bytes, root, key)：key 参与库内解析缓存，用稳定 id 拼，
      // 这样切回同一个场景不会重新解析（复杂场景解析要好几秒）。
      const source =
        typeof lib.bytesSource === "function"
          ? lib.bytesSource(ctx.buffer, item.dirUrl || null, "wbwe-" + myId)
          : ctx.buffer;
      const mounting = lib.mount(holder, {
        source: source,
        fps: clamp(state.tunables.fps, 10, 60),
        volume: effectiveVolume(),
        autoplay: !state.paused && !state.hidden,
      });

      let timer = 0;
      return Promise.race([
        mounting,
        new Promise(function (_, reject) {
          timer = setTimeout(function () {
            reject(new Error("mount 超时"));
          }, 60000);
        }),
      ])
        .then(function (instance) {
          clearTimeout(timer);
          return instance;
        })
        .catch(function (err) {
          clearTimeout(timer);
          // ⚠️ 超时那条路上，在飞的 mount 稍后**仍可能成功**，而那时它没人接管 ——
          //    必须自己接住并销毁，否则它会在容器上一直渲染（漏 WebGL 上下文）。
          //
          // ⚠️ 这个兜底**只能**注册在 catch 分支里。挂在 race 外侧的话，正常返回的
          //    实例也会被它销毁（先注册的 then 回调排在 await 续体之前，那一刻实例
          //    变量还没赋值），症状极具迷惑性：mount 正常 resolve、canvas 尺寸也对，
          //    但 info 恒为 null、fps 恒为 0。
          if (mounting && typeof mounting.then === "function") {
            mounting
              .then(function (late) {
                try {
                  if (late && typeof late.destroy === "function") late.destroy();
                } catch (e) {
                  /* 忽略 */
                }
              })
              .catch(function () {});
          }
          throw err;
        });
    })
    .then(function (instance) {
      if (!instance) return;
      if (disposed || myGeneration !== sceneGeneration || state.activeId !== myId) {
        try {
          instance.destroy();
        } catch (e) {
          /* 忽略 */
        }
        return;
      }
      sceneInstance = instance;
      applyVolume();
      // 首帧已出 → 淡入，静态图被顶替。用户只看到"更顺滑了"。
      requestAnimationFrame(function () {
        if (holder && holder.isConnected) holder.style.opacity = "1";
      });
      refreshStatus();
    })
    .catch(function (err) {
      // 静默降级：留在静态贴图 / 工坊预览图上，用户不必知道背后发生了什么。
      console.warn("[wbwe] scene 实时渲染不可用，已降级为静态图：", err && err.message);
      if (sceneHolder === holder) {
        try {
          holder.remove();
        } catch (e) {
          /* 忽略 */
        }
        sceneHolder = null;
      }
      refreshStatus();
    });
}

// web 壁纸：以 iframe 加载（沙箱、不吃焦点）
function setWebFrame(item) {
  if (!layer || !item.webIndexUrl) return;
  const frame = document.createElement("iframe");
  frame.src = item.webIndexUrl;
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.setAttribute("scrolling", "no");
  frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none;";
  layer.appendChild(frame);
  // 记在 mediaEl 之外的地方不合适；web 帧的释放跟 scene 一样挂在 layer 上，
  // 统一由 releaseMedia 处理不到 —— 因此这里单独挂一个清理函数。
  cleanupFns.push(function () {
    try {
      frame.removeAttribute("src");
      frame.remove();
    } catch (e) {
      /* 忽略 */
    }
  });
}

// 应用一个壁纸（媒体的唯一入口）
function applyItem(id) {
  const item = id ? itemsById[id] : null;
  if (disposed) return;

  // 先彻底释放上一轮的一切
  releaseMedia();
  while (cleanupFns.length) {
    const fn = cleanupFns.pop();
    try {
      fn();
    } catch (e) {
      /* 忽略 */
    }
  }
  setStaticImage(null);

  state.activeId = item ? item.id : null;

  if (!item) {
    if (layer) layer.style.backgroundImage = "";
    persist();
    renderPanel();
    refreshStatus();
    return;
  }

  // 静态兜底先上：解出的 4K 贴图 → 工坊预览图。
  // 这一步让"任何后续失败"都不会留下黑屏。
  const hero = item.heroUrl || item.previewUrl;
  if (hero) setStaticImage(hero);

  if (!item.renderable) {
    // 不可渲染的条目（例如官方示例工程只有 scene.json + 散装贴图）
    persist();
    renderPanel();
    refreshStatus();
    return;
  }

  if (item.kind === "video") {
    setVideo(item);
  } else if (item.kind === "scene") {
    // 渐进增强：静态图已经在显示，真渲染异步顶替
    renderScene(item);
  } else if (item.kind === "web") {
    setWebFrame(item);
  }

  persist();
  renderPanel();
  refreshStatus();
}

// ---------------------------------------------------------------------------
// 6. 轮播
// ---------------------------------------------------------------------------

function rotationCandidates() {
  const out = [];
  for (let i = 0; i < D.items.length; i += 1) {
    const item = D.items[i];
    if (!item.renderable) continue;
    if (state.enabledKinds.indexOf(item.kind) < 0) continue;
    if (!ratingAllows(item)) continue;
    out.push(item);
  }
  return out;
}

function ratingAllows(item) {
  const r = (item.rating || "").toLowerCase();
  if (state.rating === "mature") return true;
  if (state.rating === "questionable") return !r || r === "everyone" || r === "questionable";
  return !r || r === "everyone";
}

function setupRotation() {
  if (rotateTimer) {
    clearInterval(rotateTimer);
    rotateTimer = 0;
  }
  if (!state.rotateMinutes || state.rotateMinutes <= 0) return;
  const ms = state.rotateMinutes * 60000;
  rotateTimer = setInterval(function () {
    if (disposed || state.paused || state.hidden) return;
    const list = rotationCandidates();
    if (list.length < 2) return;
    let idx = 0;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].id === state.activeId) {
        idx = (i + 1) % list.length;
        break;
      }
    }
    applyItem(list[idx].id);
  }, ms);
}

// ---------------------------------------------------------------------------
// 7. 设置面板
// ---------------------------------------------------------------------------

function tabButton(label, on, onClick) {
  const b = h("button", "", { text: label, "data-wbwe-on": on ? "1" : "0" });
  b.className = "wbwe-btn";
  b.type = "button";
  b.addEventListener("click", function (ev) {
    ev.stopPropagation();
    onClick();
  });
  return b;
}

function buildSlider(spec) {
  const row = h("div", "");
  row.className = "wbwe-row";
  const label = h("label", "", { text: spec.label });
  label.title = spec.labelEn || spec.label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = "100";
  input.step = "1";
  input.value = String(toSlider(spec, state.tunables[spec.key]));
  const value = h("span", "", { text: fmtValue(spec, state.tunables[spec.key]) });
  value.className = "wbwe-val";

  input.addEventListener("input", function () {
    // 拖动中：只做渲染同步，**不更新数字标签** ——
    // 设置面板打开时改任意文本会让整篇布局变脏（实测一次约 29ms），拖动只剩 ~33fps。
    state.tunables[spec.key] = fromSlider(spec, Number(input.value));
    applyTunables();
  });
  input.addEventListener("change", function () {
    // 松手：更新读数并落盘
    value.textContent = fmtValue(spec, state.tunables[spec.key]);
    persist();
  });
  // 防止冒泡到"点空白关闭"之类的逻辑
  for (const evt of ["click", "pointerdown", "mousedown"]) {
    input.addEventListener(evt, function (e) {
      e.stopPropagation();
    });
  }

  row.appendChild(label);
  row.appendChild(input);
  row.appendChild(value);
  return row;
}

// 状态行：告诉用户"当前是真渲染还是降级成静态图"
function refreshStatus() {
  if (!statusEl) return;
  const item = state.activeId ? itemsById[state.activeId] : null;
  let text;
  if (!item) text = "未选择壁纸（回到原生外观）";
  else if (state.hidden) text = "已隐藏：" + item.title;
  else if (item.kind === "video" && mediaEl) text = "视频播放中：" + item.title;
  else if (item.kind === "scene" && sceneInstance) text = "Scene 实时渲染：" + item.title;
  else if (item.kind === "scene") text = "Scene 静态图（实时渲染不可用）：" + item.title;
  else if (item.kind === "web") text = "网页壁纸：" + item.title;
  else text = item.title;
  statusEl.textContent = text;
}

function renderPanel() {
  if (!panelEl || disposed) return;
  panelEl.textContent = "";

  const head = h("div", "");
  head.className = "wbwe-h";
  head.appendChild(h("span", "", { text: "Wallpaper Engine 壁纸" }));
  const closeBtn = h("button", "", { text: "✕" });
  closeBtn.className = "wbwe-btn";
  closeBtn.type = "button";
  closeBtn.style.cssText = "flex:0 0 auto;padding:2px 8px;";
  closeBtn.addEventListener("click", function (ev) {
    ev.stopPropagation();
    togglePanel(false);
  });
  head.appendChild(closeBtn);
  panelEl.appendChild(head);

  const body = h("div", "");
  body.className = "wbwe-b";
  panelEl.appendChild(body);

  // --- 播放控制 ---
  const ctrl = h("div", "");
  ctrl.className = "wbwe-btns";
  ctrl.appendChild(
    tabButton(state.paused ? "继续播放" : "暂停", false, function () {
      state.paused = !state.paused;
      applyTunables();
      syncPlayback();
      persist();
      renderPanel();
      refreshStatus();
    }),
  );
  ctrl.appendChild(
    tabButton(state.hidden ? "显示壁纸" : "隐藏壁纸", state.hidden, function () {
      state.hidden = !state.hidden;
      if (layer) layer.dataset.wbweHidden = state.hidden ? "1" : "0";
      applyTunables();
      syncPlayback();
      persist();
      renderPanel();
      refreshStatus();
    }),
  );
  ctrl.appendChild(
    tabButton("静音", state.tunables.muted, function () {
      state.tunables.muted = !state.tunables.muted;
      applyVolume();
      persist();
      renderPanel();
    }),
  );
  body.appendChild(ctrl);

  // --- 外观类滑块 ---
  body.appendChild(h("div", "", { class: "wbwe-cap", text: "外观" }));
  for (let i = 0; i < D.tunableSchema.length; i += 1) {
    const spec = D.tunableSchema[i];
    if (spec.group !== "appearance") continue;
    body.appendChild(buildSlider(spec));
  }

  // --- 液态玻璃 ---
  body.appendChild(h("div", "", { class: "wbwe-cap", text: "液态玻璃" }));
  const presets = h("div", "");
  presets.className = "wbwe-btns";
  for (let i = 0; i < D.glassPresets.length; i += 1) {
    const preset = D.glassPresets[i];
    presets.appendChild(
      tabButton(preset.name, false, function () {
        for (const key in preset.tunables) {
          if (key in state.tunables) state.tunables[key] = preset.tunables[key];
        }
        applyTunables();
        persist();
        renderPanel();
      }),
    );
  }
  body.appendChild(presets);
  for (let i = 0; i < D.tunableSchema.length; i += 1) {
    const spec = D.tunableSchema[i];
    if (spec.group !== "glass") continue;
    body.appendChild(buildSlider(spec));
  }

  // --- 播放类滑块 ---
  body.appendChild(h("div", "", { class: "wbwe-cap", text: "播放" }));
  for (let i = 0; i < D.tunableSchema.length; i += 1) {
    const spec = D.tunableSchema[i];
    if (spec.group !== "playback") continue;
    body.appendChild(buildSlider(spec));
  }

  // --- 轮播间隔 ---
  const rotateRow = h("div", "");
  rotateRow.className = "wbwe-btns";
  const intervals = [0, 5, 10, 15, 30, 60];
  for (let i = 0; i < intervals.length; i += 1) {
    const minutes = intervals[i];
    const label = minutes === 0 ? "不轮播" : minutes + "分";
    rotateRow.appendChild(
      tabButton(label, state.rotateMinutes === minutes, function () {
        state.rotateMinutes = minutes;
        setupRotation();
        persist();
        renderPanel();
      }),
    );
  }
  body.appendChild(h("div", "", { class: "wbwe-cap", text: "自动轮播" }));
  body.appendChild(rotateRow);

  // --- 内容分级 ---
  body.appendChild(h("div", "", { class: "wbwe-cap", text: "内容分级" }));
  const ratings = [
    { key: "everyone", label: "全年龄" },
    { key: "questionable", label: "轻度" },
    { key: "mature", label: "全部" },
  ];
  const ratingRow = h("div", "");
  ratingRow.className = "wbwe-btns";
  for (let i = 0; i < ratings.length; i += 1) {
    const option = ratings[i];
    ratingRow.appendChild(
      tabButton(option.label, state.rating === option.key, function () {
        state.rating = option.key;
        persist();
        renderPanel();
      }),
    );
  }
  body.appendChild(ratingRow);

  // --- 类型过滤 ---
  body.appendChild(h("div", "", { class: "wbwe-cap", text: "类型过滤" }));
  const kinds = [
    { key: "video", label: "Video" },
    { key: "scene", label: "Scene" },
    { key: "web", label: "Web" },
  ];
  const kindRow = h("div", "");
  kindRow.className = "wbwe-btns";
  for (let i = 0; i < kinds.length; i += 1) {
    const kind = kinds[i];
    const on = state.enabledKinds.indexOf(kind.key) >= 0;
    kindRow.appendChild(
      tabButton(kind.label, on, function () {
        const at = state.enabledKinds.indexOf(kind.key);
        if (at >= 0) {
          // 至少留一种类型，否则网格会空掉
          if (state.enabledKinds.length > 1) state.enabledKinds.splice(at, 1);
        } else {
          state.enabledKinds.push(kind.key);
        }
        persist();
        renderPanel();
      }),
    );
  }
  body.appendChild(kindRow);

  // --- 壁纸网格 ---
  body.appendChild(h("div", "", { class: "wbwe-cap", text: "选择壁纸（" + D.items.length + "）" }));
  const grid = h("div", "");
  grid.className = "wbwe-grid";
  const list = h("div", "");
  list.className = "wbwe-list";
  list.appendChild(grid);

  const visible = [];
  for (let i = 0; i < D.items.length; i += 1) {
    const item = D.items[i];
    if (state.enabledKinds.indexOf(item.kind) < 0) continue;
    if (!ratingAllows(item)) continue;
    visible.push(item);
  }

  for (let i = 0; i < visible.length; i += 1) {
    const item = visible[i];
    const card = h("button", "", { dataset: { wbweSel: state.activeId === item.id ? "1" : "0", wbweOff: item.renderable ? "0" : "1" } });
    card.className = "wbwe-card";
    card.type = "button";
    card.title = item.title + "（" + item.kind + "）";
    if (item.previewUrl) {
      const img = document.createElement("img");
      img.loading = "lazy";   // 列表里绝不放 <video>：几十个解码器会拖垮渲染进程
      img.src = item.previewUrl;
      img.alt = item.title;
      card.appendChild(img);
    }
    card.appendChild(h("span", "", { class: "wbwe-badge", text: item.kind }));
    card.addEventListener("click", function (ev) {
      ev.stopPropagation();
      applyItem(state.activeId === item.id ? null : item.id);
    });
    grid.appendChild(card);
  }
  body.appendChild(list);

  // --- 底部：清除 + 说明 ---
  const foot = h("div", "");
  foot.className = "wbwe-btns";
  foot.appendChild(
    tabButton("清除壁纸（回到原生）", false, function () {
      applyItem(null);
    }),
  );
  body.appendChild(foot);
  body.appendChild(
    h("div", "", {
      class: "wbwe-note",
      text: "素材来自本机 Wallpaper Engine，仅本机可用、不可分享。本插件不修改 WorkBuddy 的任何官方文件。",
    }),
  );

  refreshStatus();
}

function togglePanel(open) {
  state.panelOpen = open === undefined ? !state.panelOpen : open;
  if (panelEl) panelEl.dataset.wbweOpen = state.panelOpen ? "1" : "0";
}

// ---------------------------------------------------------------------------
// 8. 挂载
// ---------------------------------------------------------------------------

function build() {
  styleEl = document.getElementById(D.ids.style);
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = D.ids.style;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = CSS_TEXT;

  // 悬浮按钮（面板的入口 + 快速暂停）
  const existingLauncher = document.getElementById(D.ids.launcher);
  if (existingLauncher) existingLauncher.remove();
  launcherEl = h("div", "", { id: D.ids.launcher });
  const gear = h("button", "", { text: "🎨", title: "Wallpaper Engine 壁纸（点击开关面板）" });
  gear.type = "button";
  gear.addEventListener("click", function (ev) {
    ev.stopPropagation();
    togglePanel();
  });
  const pause = h("button", "", { text: state.paused ? "▶" : "❚❚", title: "暂停 / 继续" });
  pause.type = "button";
  pause.addEventListener("click", function (ev) {
    ev.stopPropagation();
    state.paused = !state.paused;
    syncPlayback();
    persist();
    pause.textContent = state.paused ? "▶" : "❚❚";
    refreshStatus();
  });
  launcherEl.appendChild(pause);
  launcherEl.appendChild(gear);
  document.body.appendChild(launcherEl);

  // 面板
  const existingPanel = document.getElementById(D.ids.panel);
  if (existingPanel) existingPanel.remove();
  panelEl = h("div", "", { id: D.ids.panel, dataset: { wbweOpen: state.panelOpen ? "1" : "0" } });
  document.body.appendChild(panelEl);
  statusEl = null;
  // 状态行放在面板头部下方，方便一眼看出当前是不是真渲染
  panelEl.addEventListener("click", function (ev) {
    ev.stopPropagation();
  });

  // 背景层
  const existingLayer = document.getElementById(D.ids.layer);
  if (existingLayer) existingLayer.remove();
  layer = h("div", "", { id: D.ids.layer, dataset: { wbweHidden: state.hidden ? "1" : "0" } });
  document.body.appendChild(layer);

  scrimEl = h("div", "", { dataset: { wbweScrim: "1" } });
  layer.appendChild(scrimEl);
  vignetteEl = h("div", "", { dataset: { wbweVignette: "1" } });
  layer.appendChild(vignetteEl);

  // 状态行插到面板里（在头部之后）
  statusEl = h("div", "");
  statusEl.className = "wbwe-note";
  statusEl.style.cssText = "padding:8px 13px 0;";
  panelEl.insertBefore(statusEl, panelEl.firstChild ? panelEl.firstChild.nextSibling : null);

  applyTunables();
  restoreSnapshot();
  applyItem(state.activeId);
  setupRotation();
  refreshStatus();

  console.log("[wbwe] 壁纸引擎已注入，可用条目 " + D.items.length + " 个");
}

// 卸载：必须把**所有**长期存活的资源都停掉。
// 顺序有讲究：先释放 WebGL（它依赖 layer 还在），再删 layer。
NS.dispose = function () {
  disposed = true;
  if (rotateTimer) {
    clearInterval(rotateTimer);
    rotateTimer = 0;
  }
  releaseMedia();
  while (cleanupFns.length) {
    const fn = cleanupFns.pop();
    try {
      fn();
    } catch (e) {
      /* 忽略 */
    }
  }
  if (layer) {
    try {
      layer.remove();
    } catch (e) {
      /* 忽略 */
    }
    layer = null;
  }
  if (panelEl) {
    try {
      panelEl.remove();
    } catch (e) {
      /* 忽略 */
    }
    panelEl = null;
  }
  if (launcherEl) {
    try {
      launcherEl.remove();
    } catch (e) {
      /* 忽略 */
    }
    launcherEl = null;
  }
  // style 节点留着不删是刻意的：删了会让"下一次 apply 之前"的一瞬间闪回原生外观。
  // 下一次 build() 会复用同一个 <style> 并覆写内容。
  sceneInstance = null;
  sceneHolder = null;
  mediaEl = null;
};

NS.applyItem = applyItem;
NS.getState = function () {
  return JSON.parse(JSON.stringify(state));
};

build();
