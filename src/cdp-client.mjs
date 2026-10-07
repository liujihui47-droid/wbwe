/**
 * 极简 Chrome DevTools Protocol 客户端。
 *
 * 只实现本项目真正用到的四件事：
 *   1. 通过 `http://127.0.0.1:<port>/json/list` 枚举 target，筛出 WorkBuddy 的渲染进程
 *   2. 对某个 target 开 WebSocket，发 `Runtime.evaluate` 执行注入脚本
 *   3. `Page.addScriptToEvaluateOnNewDocument` —— 让新窗口/新渲染进程一诞生就带上背景
 *   4. `Runtime.addBinding` —— 渲染进程能反向通知宿主（用户换了壁纸要落盘）
 *
 * 刻意**不**引入 `ws` 或 `chrome-remote-interface`：
 *   · 本项目的依赖目标是"零 npm 依赖"，用户 git clone 下来就能跑
 *   · Node 22+ 自带全局 `WebSocket`，足够用
 *   · CDP 的 JSON 协议本身极简，包装一层反而看不清真实行为
 */

import { retryUntil, sleep } from "./util.mjs";

/**
 * 一次 CDP 会话（一条 WebSocket 连接）。
 *
 * 用法：
 *   const session = new CdpSession(wsUrl);
 *   await session.open();
 *   await session.evaluate("1+1");
 *   session.close();
 */
export class CdpSession {
  #ws;
  #url;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(webSocketDebuggerUrl, { timeoutMs = 15_000 } = {}) {
    this.#url = webSocketDebuggerUrl;
    this.timeoutMs = timeoutMs;
  }

  get url() {
    return this.#url;
  }

  get isOpen() {
    return Boolean(this.#ws) && this.#ws.readyState === 1 && !this.#closed;
  }

  open() {
    if (this.#ws) return Promise.resolve(this);
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.#url);
      } catch (error) {
        return reject(new Error(`无法建立 CDP 连接（${this.#url}）：${error.message}`));
      }
      this.#ws = ws;

      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* 已经关了 */
        }
        reject(new Error(`CDP 连接超时（${this.timeoutMs}ms）：${this.#url}`));
      }, this.timeoutMs);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(this);
      });
      ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        // Node 的 WebSocket error 事件不带 message，只能给个可读的描述。
        reject(new Error(`CDP 连接失败：${this.#url}${event?.message ? ` — ${event.message}` : ""}`));
      });
      ws.addEventListener("message", (event) => this.#onMessage(event));
      ws.addEventListener("close", () => {
        this.#closed = true;
        // 连接断了要把所有挂起的请求一次性失败掉，否则调用方会永久悬挂。
        for (const [, entry] of this.#pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("CDP 连接已关闭"));
        }
        this.#pending.clear();
      });
    });
  }

  #onMessage(event) {
    let msg;
    try {
      msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return; // 非 JSON 消息直接忽略（CDP 偶尔有事件载荷）
    }

    if (msg.id !== undefined) {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(`CDP 错误：${msg.error.message ?? JSON.stringify(msg.error)}`));
      else entry.resolve(msg.result);
      return;
    }

    // 事件分发（绑定回调靠它）。
    const handlers = this.#listeners.get(msg.method);
    if (handlers) for (const fn of handlers) {
      try {
        fn(msg.params);
      } catch {
        /* 单个监听器出错不影响其它 */
      }
    }
  }

  /** 发一条 CDP 命令并等结果。 */
  send(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.#ws || this.#ws.readyState !== 1) {
      return Promise.reject(new Error("CDP 会话未打开"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP 命令超时（${method}，${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  /** 订阅 CDP 事件。返回取消订阅函数。 */
  on(method, handler) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(handler);
    return () => this.#listeners.get(method)?.delete(handler);
  }

  /**
   * 在页面里求值。
   *
   * `awaitPromise: true` 让页面里的 async 函数能被正确 await —— 我们的注入脚本
   * 是同步 IIFE，但 scene 初始化那类逻辑需要等 WebWallGL 加载完。
   * `returnByValue: true` 让我们拿到真实对象而不是 RemoteObject 描述。
   */
  async evaluate(expression, { awaitPromise = true, returnByValue = true, timeoutMs } = {}) {
    const result = await this.send(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise,
        returnByValue,
        // 注入脚本必须能在任意上下文跑；用户手势不是必需的（我们不做受手势限制的事）。
        userGesture: false,
        // 让页面里的异常以 exceptionDetails 形式回来，而不是静默失败。
        includeCommandLineAPI: false,
      },
      { timeoutMs: timeoutMs ?? this.timeoutMs },
    );
    if (result?.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "未知错误";
      throw new Error(`页面内求值抛错：${text}`);
    }
    return result?.result?.value;
  }

  /** 让每个**新**文档一加载就执行这段脚本。
   *
   * 这是"背景不闪"的关键：WorkBuddy 新建窗口/刷新时，如果不能在新文档诞生前
   * 就注入，用户会先看到白底再看到壁纸。 */
  addInitScript(source) {
    return this.send("Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true });
  }

  /** 让页面能反向调用宿主函数（参数以 CDP 事件 `Runtime.bindingCalled` 回来）。 */
  async addBinding(name) {
    await this.send("Runtime.addBinding", { name });
  }

  /** 打开页面前置能力。幂等：重复调用不报错。 */
  async enable() {
    for (const domain of ["Page", "Runtime"]) {
      try {
        await this.send(`${domain}.enable`);
      } catch {
        /* 某些 target 不支持某个 domain，忽略 */
      }
    }
    return this;
  }

  close() {
    this.#closed = true;
    if (this.#ws) {
      try {
        this.#ws.close();
      } catch {
        /* 可能已经断了 */
      }
    }
    this.#ws = null;
  }
}

/** 枚举某个 CDP 端口上的全部 target。端口没开/不是 CDP 时抛错。 */
export async function fetchTargets(port, { timeoutMs = 3000, host = "127.0.0.1" } = {}) {
  const url = `http://${host}:${port}/json/list`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error("CDP /json/list 返回的不是数组");
    return list;
  } finally {
    clearTimeout(timer);
  }
}

/** 只保留页面型 target（排除 service worker、iframe 等）。 */
export function isPageTarget(target) {
  // 注意要显式转成布尔：写成 `a && b` 会把 b 的值（这里是 ws 地址字符串）
  // 直接当返回值传出去。对 `filter().length` 之类的用法没影响，
  // 但会让 `assert.equal(isPageTarget(x), true)` 这类断言失败 —— 很值得避免的坑。
  return Boolean(target?.type === "page" && typeof target.webSocketDebuggerUrl === "string" && target.webSocketDebuggerUrl);
}

/**
 * 校验一个 WebSocket URL 确实指向本机回环地址。
 *
 * 这是一道**安全闸**：`/json/list` 的响应来自被调试的进程。如果那个端口被别的
 * 程序占用（或者有人把 CDP 端口暴露到网络上），我们不应该把注入脚本发过去。
 * 所以只接受 `ws:` + `127.0.0.1` + 显式端口，且不带任何认证信息/片段。
 */
export function isLoopbackWebSocketUrl(raw) {
  if (typeof raw !== "string" || !raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return false;
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") return false;
    if (!url.port) return false;
    const port = Number.parseInt(url.port, 10);
    if (!Number.isFinite(port) || port < 1024 || port > 65535) return false;
    if (url.username || url.password || url.hash) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * 取**浏览器级** CDP 端点（`/json/version`）。
 *
 * 守护进程必须用浏览器级会话才能 `Target.setAutoAttach` —— 页面级会话看不到
 * "新窗口诞生"这个事件，而那正是守护存在的理由。
 */
export async function fetchBrowserEndpoint(port, { timeoutMs = 3000, host = "127.0.0.1" } = {}) {
  const url = `http://${host}:${port}/json/version`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const wsUrl = info?.webSocketDebuggerUrl;
    if (!isLoopbackWebSocketUrl(wsUrl)) {
      throw new Error(`CDP 端点不是本机回环地址，拒绝连接：${wsUrl ?? "(空)"}`);
    }
    return { ...info, webSocketDebuggerUrl: wsUrl, port };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 等浏览器级端点出现。
 *
 * 注意：如果 `fetchBrowserEndpoint` 自己抛错（例如拒绝非回环地址），
 * `retryUntil` 会把它当成"还没好"而重试到超时，从而**掩盖**真正的原因。
 * 所以这里把这类硬错误直接抛出，不重试。
 */
export async function waitForBrowserEndpoint(port, { timeoutMs = 60_000, pollMs = 250 } = {}) {
  return retryUntil(
    async () => {
      try {
        return await fetchBrowserEndpoint(port, { timeoutMs: Math.min(3000, pollMs * 8) });
      } catch (error) {
        // "拒绝连接"是安全问题，不是"还没起来"，必须让调用方看到
        if (String(error?.message ?? "").includes("拒绝连接")) throw error;
        return null;
      }
    },
    { timeoutMs, pollMs },
  );
}

/**
 * 筛出 WorkBuddy 的**渲染进程** target。
 *
 * 判据：是 page、URL 命中 `renderer/index.html`。做 URL 过滤很重要 ——
 * WorkBuddy 里还有 devtools、扩展宿主、各种 about:blank 页面，往那些页面
 * 注入会把 CSS 塞到无关文档里。
 *
 * `hint` 为空时退化为"所有 page"（WorkBuddy 改路径时的降级路径，宁可多注入
 * 也不要完全不工作）。
 */
export function filterRendererTargets(targets, { hint = "renderer/index.html" } = {}) {
  const pages = targets.filter(isPageTarget);
  if (!hint) return pages;
  const matched = pages.filter((t) => String(t.url ?? "").toLowerCase().includes(hint.toLowerCase()));
  return matched.length ? matched : [];
}

/**
 * 等到 CDP 端口可用且出现渲染进程 target。
 *
 * 冷启动 WorkBuddy 实测要几秒，而且 `/json/list` 在窗口出现之前可能返回空数组 ——
 * 所以既要等端口开，也要等 target 出现，不能只探一次。
 */
export async function waitForRendererTargets(port, { timeoutMs = 30_000, pollMs = 400, hint, requireTarget = true } = {}) {
  return retryUntil(
    async () => {
      const targets = await fetchTargets(port, { timeoutMs: Math.min(3000, pollMs * 4) });
      const renderers = filterRendererTargets(targets, hint !== undefined ? { hint } : undefined);
      if (requireTarget && renderers.length === 0) return null;
      return renderers.length ? renderers : targets.length ? [] : null;
    },
    {
      timeoutMs,
      pollMs,
      onGiveUp: () =>
        Promise.reject(
          new Error(
            `等待 WorkBuddy 渲染进程超时（端口 ${port}，${timeoutMs}ms）。\n` +
              `排查：1) WorkBuddy 是否已启动；2) 是否用 --remote-debugging-port=${port} 启动的；\n` +
              `      3) 若 WorkBuddy 之前已在运行，它不会接管新端口 —— 需要先完全退出再重启。`,
          ),
        ),
    },
  );
}

/**
 * 对所有命中 target 执行同一段表达式，逐个开短连接。
 *
 * 为什么不为每个 target 常驻连接：注入是一次性动作，做完就断，避免长期占用
 * WebSocket 资源，也避免 WorkBuddy 关窗时留下悬挂回调。
 */
export async function evaluateOnTargets(targets, expression, { SessionClass = CdpSession, timeoutMs = 30_000 } = {}) {
  const results = [];
  for (const target of targets) {
    const session = new SessionClass(target.webSocketDebuggerUrl, { timeoutMs });
    try {
      await session.open();
      await session.enable();
      const value = await session.evaluate(expression);
      results.push({ targetId: target.id, ok: true, value });
    } catch (error) {
      results.push({ targetId: target.id, ok: false, error: error?.message ?? String(error) });
    } finally {
      session.close();
    }
  }
  return results;
}

export { sleep };
