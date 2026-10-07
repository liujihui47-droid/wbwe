/**
 * 守护进程（guard）的逻辑回归。
 *
 * 守护是整条链上**最危险**的一环：它走 `Target.setAutoAttach` +
 * `waitForDebuggerOnStart`，也就是"让新窗口出生即暂停，注入完再放行"。
 * 一旦漏掉放行那一步，那个渲染进程会**永久停在出生状态 = 用户看到白屏**。
 *
 * 所以这个测试的核心目的就是：**证明放行一定会被调用**，即使注入本身失败。
 *
 * 做法：用一个假的 CDP 会话（记录所有 send / 手动触发事件）替换真会话。
 * 真实 Chromium 的行为已经在 test/verify-cdp-client.mjs 里用迷你 WebSocket
 * 服务器验证过了，这里只验守护自己的决策逻辑。
 *
 * 用法： node test/verify-guard.mjs
 */

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Guard } from "../src/guard.mjs";
import { REPORT_BINDING } from "../src/constants.mjs";
import { readState } from "../src/state.mjs";

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

/** 记录一切的假会话。 */
class FakeSession {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.handlers = new Map();
    this.closed = false;
    /** 让某些命令抛错，用于验证"注入失败也要放行"。 */
    this.failOn = new Set();
  }
  async open() {
    return this;
  }
  async send(method, params = {}, opts = {}) {
    this.sent.push({ method, params, sessionId: opts.sessionId ?? null });
    if (this.failOn.has(method)) throw new Error(`fake failure: ${method}`);
    if (method === "Target.getTargets") return { targetInfos: [] };
    return {};
  }
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }
  close() {
    this.closed = true;
  }
  /** 某个方法被调用了几次。 */
  count(method, sessionId = undefined) {
    return this.sent.filter((s) => s.method === method && (sessionId === undefined || s.sessionId === sessionId)).length;
  }
}

/**
 * 造一个可用的 Guard，但把真实 CdpSession 换成记录型的假会话。
 *
 * ⚠️ 关键点：假会话必须**只创建一次**，然后把它内部的 `sent` / `handlers` /
 * `closed` 以 getter 的形式暴露给每次 `new` 出来的实例 ——
 * 守护会在重连时重新 `new CdpSession(...)`，如果每个实例各有自己的数组，
 * 断言就会读到空数组（看起来像"守护什么都没做"）。
 */
function makeGuard({ paths, failOn = [] } = {}) {
  const lines = [];
  const inner = new FakeSession("ws://127.0.0.1:9999/devtools/browser/X");
  inner.failOn = new Set(failOn);

  class Session extends FakeSession {
    constructor(url) {
      super(url);
      // 不要在这里建自己的 sent/handlers —— 用闭包里那个共享的
      Object.defineProperty(this, "sent", { get: () => inner.sent });
      Object.defineProperty(this, "handlers", { get: () => inner.handlers });
      Object.defineProperty(this, "closed", {
        get: () => inner.closed,
        set: (v) => {
          inner.closed = v;
        },
      });
      this.failOn = inner.failOn;
    }
  }

  const guard = new Guard({
    port: 9334,
    paths,
    expression: "(function(){ return 'injected'; })()",
    say: (line) => lines.push(line),
    deps: {
      CdpSession: Session,
      waitForBrowserEndpoint: async () => ({ Browser: "FakeChrome/1", webSocketDebuggerUrl: inner.url, port: 9334 }),
      attachTimeoutMs: 200,
      resumeTimeoutMs: 200,
    },
  });
  return { guard, session: inner, lines };
}

const RENDERER = { targetId: "T-render", type: "page", url: "file:///D:/WorkBuddy/resources/app.asar/renderer/index.html" };
const DEVTOOLS = { targetId: "T-dev", type: "page", url: "devtools://devtools/bundled/inspector.html" };
const WORKER = { targetId: "T-worker", type: "service_worker", url: "file:///D:/x/renderer/index.html" };

async function run() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wbwe-guard-"));
  const paths = {
    stateRoot: root,
    statePath: path.join(root, "state.json"),
    logPath: path.join(root, "injector.log"),
    cacheRoot: path.join(root, "cache"),
  };

  try {
    // --- 1. 连接阶段 ------------------------------------------------------
    const g1 = makeGuard({ paths });
    await g1.guard.connect();

    check("连接后开启了 setAutoAttach（守护的前提）", () => {
      const call = g1.session.sent.find((s) => s.method === "Target.setAutoAttach");
      assert.ok(call, "没有调用 Target.setAutoAttach");
      assert.equal(call.params.autoAttach, true);
      assert.equal(call.params.waitForDebuggerOnStart, true, "必须让新窗口出生即暂停，否则首屏会先看到白底");
      assert.equal(call.params.flatten, true);
    });

    check("浏览器级会话不 enable Runtime/Page（协议会拒绝）", () => {
      assert.equal(g1.session.count("Runtime.enable"), 0, "浏览器级会话不该 enable Runtime");
      assert.equal(g1.session.count("Page.enable"), 0, "浏览器级会话不该 enable Page");
    });

    check("连接后枚举了既有 target（补附加在跑的窗口）", () => {
      assert.ok(g1.session.count("Target.getTargets") >= 1);
    });

    // --- 2. 渲染 target：注入 + 放行 -------------------------------------
    const g2 = makeGuard({ paths });
    await g2.guard.connect();
    g2.session.sent.length = 0;
    await g2.guard.handleAttached({ sessionId: "S1", targetInfo: RENDERER, waitingForDebugger: true });

    check("渲染 target：注册了反向上报通道", () => {
      const call = g2.session.sent.find((s) => s.method === "Runtime.addBinding");
      assert.ok(call, "没有 addBinding");
      assert.equal(call.params.name, REPORT_BINDING);
    });

    check("渲染 target：注册了首屏脚本（addScriptToEvaluateOnNewDocument）", () => {
      const call = g2.session.sent.find((s) => s.method === "Page.addScriptToEvaluateOnNewDocument");
      assert.ok(call, "没有注册首屏脚本");
      assert.equal(call.params.source, "(function(){ return 'injected'; })()");
      assert.equal(call.params.runImmediately, true);
    });

    check("渲染 target：做了即时注入（Runtime.evaluate）", () => {
      assert.equal(g2.session.count("Runtime.evaluate", "S1"), 1);
    });

    check("渲染 target：命令都带了 sessionId（flatten 模式）", () => {
      for (const s of g2.session.sent) {
        assert.equal(s.sessionId, "S1", `${s.method} 没带 sessionId`);
      }
    });

    check("★ 渲染 target：调用了 runIfWaitingForDebugger（漏了就是白屏）", () => {
      assert.equal(g2.session.count("Runtime.runIfWaitingForDebugger", "S1"), 1);
    });

    // --- 3. 非 page target：不注入但必须放行 ------------------------------
    const g3 = makeGuard({ paths });
    await g3.guard.connect();
    g3.session.sent.length = 0;
    await g3.guard.handleAttached({ sessionId: "W1", targetInfo: WORKER, waitingForDebugger: true });

    check("service worker：不注入（没有 evaluate / 首屏脚本）", () => {
      assert.equal(g3.session.count("Runtime.evaluate", "W1"), 0, "不该往 worker 里注入");
      assert.equal(g3.session.count("Page.addScriptToEvaluateOnNewDocument", "W1"), 0);
    });

    check("★ service worker：仍然被放行（它同样被暂停着）", () => {
      assert.equal(g3.session.count("Runtime.runIfWaitingForDebugger", "W1"), 1);
    });

    // --- 4. devtools 页面：不注入但放行 -----------------------------------
    const g4 = makeGuard({ paths });
    await g4.guard.connect();
    g4.session.sent.length = 0;
    await g4.guard.handleAttached({ sessionId: "D1", targetInfo: DEVTOOLS, waitingForDebugger: true });

    check("devtools 页面不注入", () => {
      assert.equal(g4.session.count("Runtime.evaluate", "D1"), 0);
    });
    check("devtools 页面也被放行", () => {
      assert.equal(g4.session.count("Runtime.runIfWaitingForDebugger", "D1"), 1);
    });

    // --- 5. 注入失败时仍然必须放行（最关键的一条）-------------------------
    const g5 = makeGuard({ paths, failOn: ["Runtime.evaluate"] });
    await g5.guard.connect();
    g5.session.sent.length = 0;
    await g5.guard.handleAttached({ sessionId: "F1", targetInfo: RENDERER, waitingForDebugger: true });

    check("★ 注入抛错时依然放行（否则那个窗口永久白屏）", () => {
      assert.equal(g5.session.count("Runtime.runIfWaitingForDebugger", "F1"), 1, "注入失败后没有放行 —— 会导致白屏");
    });

    // --- 6. 会话去重 ------------------------------------------------------
    const g6 = makeGuard({ paths });
    await g6.guard.connect();
    await g6.guard.handleAttached({ sessionId: "S9", targetInfo: RENDERER, waitingForDebugger: true });
    g6.session.sent.length = 0;
    await g6.guard.handleAttached({ sessionId: "S9", targetInfo: RENDERER, waitingForDebugger: true });

    check("同一个 sessionId 不会被处理两次", () => {
      assert.equal(g6.session.count("Runtime.evaluate", "S9"), 0, "重复处理了同一个会话");
      assert.equal(g6.session.count("Runtime.runIfWaitingForDebugger", "S9"), 0);
    });

    // --- 7. 同一窗口两个会话：各自都要注册首屏脚本 ------------------------
    const g7 = makeGuard({ paths });
    await g7.guard.connect();
    g7.session.sent.length = 0;
    await g7.guard.handleAttached({ sessionId: "A1", targetInfo: RENDERER, waitingForDebugger: true });
    g7.session.sent.length = 0;
    await g7.guard.handleAttached({ sessionId: "A2", targetInfo: RENDERER, waitingForDebugger: true });

    check("★ 第二个会话也注册首屏脚本（会话寿命不同，不能只注册一个）", () => {
      assert.equal(g7.session.count("Page.addScriptToEvaluateOnNewDocument", "A2"), 1, "第二个会话没注册首屏脚本");
    });

    check("第二个会话不做即时注入（避免重复跑）", () => {
      assert.equal(g7.session.count("Runtime.evaluate", "A2"), 0, "重复做了即时注入");
    });

    check("第二个会话也被放行", () => {
      assert.equal(g7.session.count("Runtime.runIfWaitingForDebugger", "A2"), 1);
    });

    // --- 8. 反向上报写状态 ------------------------------------------------
    const g8 = makeGuard({ paths });
    await g8.guard.connect();
    await g8.guard.handleBindingCalled({
      name: REPORT_BINDING,
      payload: JSON.stringify({
        type: "state",
        state: {
          activeId: "scn-42",
          tunables: { scrim: 0.7, blurPx: 12 },
          hidden: false,
          rotateMinutes: 15,
          autoplay: true,
          rating: "questionable",
          enabledKinds: ["scene"],
        },
      }),
    });

    await checkAsync("反向上报的状态被写进 state.json", async () => {
      const state = await readState({ paths });
      assert.equal(state.activeId, "scn-42");
      assert.equal(state.tunables.scrim, 0.7);
      assert.equal(state.tunables.blurPx, 12);
      assert.equal(state.rotateMinutes, 15);
      assert.equal(state.rating, "questionable");
      assert.deepEqual(state.enabledKinds, ["scene"]);
    });

    await checkAsync("坏 payload 不抛错也不写状态", async () => {
      const before = await fsp.readFile(paths.statePath, "utf8");
      await g8.guard.handleBindingCalled({ name: REPORT_BINDING, payload: "{ not json" });
      const after = await fsp.readFile(paths.statePath, "utf8");
      assert.equal(before, after, "坏 payload 竟然改了状态文件");
    });

    await checkAsync("其它 binding 名字被忽略", async () => {
      const before = await fsp.readFile(paths.statePath, "utf8");
      await g8.guard.handleBindingCalled({ name: "someOtherBinding", payload: JSON.stringify({ type: "state", state: { activeId: "X" } }) });
      const after = await fsp.readFile(paths.statePath, "utf8");
      assert.equal(before, after, "别人的 binding 被我们处理了");
    });

    // --- 9. stop ----------------------------------------------------------
    const g9 = makeGuard({ paths });
    await g9.guard.connect();
    g9.guard.stop();
    check("stop() 关了会话并置位 stopped", () => {
      assert.equal(g9.guard.stopped, true);
      assert.equal(g9.session.closed, true);
    });

    await checkAsync("stop() 之后不再处理新的 attach", async () => {
      g9.session.sent.length = 0;
      await g9.guard.handleAttached({ sessionId: "Z1", targetInfo: RENDERER, waitingForDebugger: true });
      assert.equal(g9.session.sent.length, 0, "停了之后还在发命令");
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }

  process.stdout.write("守护进程逻辑回归（假 CDP 会话）\n");
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
