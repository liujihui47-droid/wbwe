/**
 * 全局常量与可调项的**单一真源**。
 *
 * 注入脚本与宿主脚本是两个不同的执行环境（宿主是 Node，注入端是渲染进程），
 * 没法共享 import —— 所以注入端需要用到的常量统一从这里序列化进 payload。
 * 改这里一处即可，不要在注入脚本里另抄一份默认值。
 */

export const PRODUCT_ID = "workbuddy-wallpaper-engine";
export const PRODUCT_NAME = "WorkBuddy Wallpaper Engine";

/** 状态文档 schema 版本。结构不兼容变更时 +1，并在读取处做迁移。 */
export const STATE_SCHEMA_VERSION = 1;

/** 注入的 DOM 节点 id（卸载时按这些 id 精确清理）。 */
export const DOM_IDS = Object.freeze({
  // 背景媒体层（视频 / canvas / 静态图）
  layer: "wbwe-layer",
  // 承载 scene 的 WebWallGL canvas
  sceneHolder: "wbwe-scene",
  // 设置面板根
  panel: "wbwe-panel",
  // 悬浮小按钮（打开面板 / 暂停）
  launcher: "wbwe-launcher",
  // 注入的 <style>
  style: "wbwe-style",
});

/** 渲染进程里挂载的全局对象名（幂等卸载靠它）。 */
export const GLOBAL_KEY = "__wbWallpaperEngine";

/** 渲染进程 → 宿主的反向上报通道名（Runtime.addBinding）。 */
export const REPORT_BINDING = "__wbweReport";

/**
 * 默认可调项。
 *
 * 这些名字会变成 CSS 自定义属性（`--wbwe-*`），并被设置面板的滑块直接驱动 ——
 * 改名字要同步改注入脚本里的 CSS 变量引用。
 */
export const DEFAULT_TUNABLES = Object.freeze({
  /** 背景模糊半径（px）。0 = 清晰。 */
  blurPx: 0,
  /** 压暗遮罩强度 0–1。深色壁纸上文字可读性全靠它。 */
  scrim: 0.28,
  /** 背景整体不透明度 0–1。 */
  opacity: 1,
  /** 暗角（vignette）强度 0–1。 */
  vignette: 0,
  /** 饱和度 0–2（1 = 原样）。 */
  saturation: 1,
  /** 亮度 0–2（1 = 原样）。 */
  brightness: 1,
  /** 玻璃面板模糊（px）。 */
  glassBlurPx: 22,
  /** 玻璃面板底色不透明度 0–1。 */
  glassAlpha: 0.5,
  /** 玻璃边框不透明度 0–1。 */
  glassBorder: 0.35,
  /** 玻璃高光强度 0–1（iOS 液态玻璃的"边缘折射"观感）。 */
  glassSpecular: 0.55,
  /** 圆角（px）。 */
  cornerPx: 14,
  /** 背景动画帧率上限（scene 用；video 不受限）。 */
  fps: 30,
  /** 音量 0–1（scene 自带音频 / video 有声壁纸）。 */
  volume: 0,
  /** 是否静音。 */
  muted: true,
});

/** 可调项的元数据 —— 设置面板据此自动生成滑块（范围、步长、标签）。 */
export const TUNABLE_SCHEMA = Object.freeze([
  { key: "scrim", label: "压暗", labelEn: "Scrim", min: 0, max: 1, step: 0.01, group: "appearance" },
  { key: "blurPx", label: "背景模糊", labelEn: "Backdrop blur", min: 0, max: 60, step: 1, unit: "px", group: "appearance" },
  { key: "opacity", label: "背景透明度", labelEn: "Background opacity", min: 0, max: 1, step: 0.01, group: "appearance" },
  { key: "vignette", label: "暗角", labelEn: "Vignette", min: 0, max: 1, step: 0.01, group: "appearance" },
  { key: "saturation", label: "饱和度", labelEn: "Saturation", min: 0, max: 2, step: 0.01, group: "appearance" },
  { key: "brightness", label: "亮度", labelEn: "Brightness", min: 0, max: 2, step: 0.01, group: "appearance" },
  { key: "glassBlurPx", label: "玻璃模糊", labelEn: "Glass blur", min: 0, max: 60, step: 1, unit: "px", group: "glass" },
  { key: "glassAlpha", label: "玻璃透明度", labelEn: "Glass opacity", min: 0, max: 0.95, step: 0.01, group: "glass" },
  { key: "glassBorder", label: "玻璃描边", labelEn: "Glass border", min: 0, max: 1, step: 0.01, group: "glass" },
  { key: "glassSpecular", label: "高光", labelEn: "Specular", min: 0, max: 1, step: 0.01, group: "glass" },
  { key: "cornerPx", label: "圆角", labelEn: "Corner radius", min: 0, max: 32, step: 1, unit: "px", group: "glass" },
  { key: "fps", label: "渲染帧率", labelEn: "FPS cap", min: 10, max: 60, step: 5, group: "playback" },
  { key: "volume", label: "音量", labelEn: "Volume", min: 0, max: 1, step: 0.01, group: "playback" },
]);

/** 内容分级过滤档位（对应 WE 的 contentrating 字段）。 */
export const RATING_LEVELS = Object.freeze([
  { key: "everyone", label: "全年龄", labelEn: "Everyone", matcher: (r) => !r || r === "everyone" },
  { key: "questionable", label: "轻度", labelEn: "Questionable", matcher: (r) => !r || r === "everyone" || r === "questionable" },
  { key: "mature", label: "全部", labelEn: "All", matcher: () => true },
]);

/** 轮播间隔候选（分钟）。 */
export const ROTATE_INTERVALS = Object.freeze([0, 5, 10, 15, 30, 60]);

/** 玻璃预设 —— 一键切换整套玻璃观感。 */
export const GLASS_PRESETS = Object.freeze([
  {
    id: "factory-frosted",
    name: "霜面",
    nameEn: "Frosted",
    tunables: { glassBlurPx: 26, glassAlpha: 0.55, glassBorder: 0.3, glassSpecular: 0.4, cornerPx: 14 },
  },
  {
    id: "factory-clear",
    name: "通透",
    nameEn: "Clear",
    tunables: { glassBlurPx: 10, glassAlpha: 0.3, glassBorder: 0.22, glassSpecular: 0.65, cornerPx: 16 },
  },
  {
    id: "factory-vivid",
    name: "浓郁",
    nameEn: "Vivid",
    tunables: { glassBlurPx: 34, glassAlpha: 0.68, glassBorder: 0.45, glassSpecular: 0.8, cornerPx: 18 },
  },
  {
    id: "factory-night",
    name: "夜色",
    nameEn: "Night",
    tunables: { glassBlurPx: 30, glassAlpha: 0.74, glassBorder: 0.26, glassSpecular: 0.3, cornerPx: 12 },
  },
  {
    id: "factory-readable",
    name: "易读",
    nameEn: "Readable",
    tunables: { glassBlurPx: 40, glassAlpha: 0.82, glassBorder: 0.4, glassSpecular: 0.25, cornerPx: 10 },
  },
  {
    id: "factory-default",
    name: "默认",
    nameEn: "Default",
    tunables: { ...DEFAULT_TUNABLES },
  },
]);

/** 注入脚本里用的 CSS 变量前缀。 */
export const CSS_VAR_PREFIX = "--wbwe";
