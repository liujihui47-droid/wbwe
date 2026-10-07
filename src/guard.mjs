/**
 * 常驻守护：让**之后新建**的窗口也自动带上壁纸。
 *
 * 为什么需要它：注入发生在启动那一刻，那一刻通常只有主窗口。而 WorkBuddy 5.7.6
 * 的设置界面是**独立的 BrowserWindow**（`appId=settings`，900×680，加载同一个
 * `renderer/index.html`，靠 query 里的 `windowAppId` 分发）。那是一个全新的渲染
 * 进程，不在任何已注入的名单里 —— 不管它，用户一打开设置就会看到一块"没有壁纸"
 * 的窗口。
 *
 * 做法（事件驱动，不轮询）：
 *   1. 连**浏览器级** CDP 会话（`/json/version`）
 *   2. `Target.setAutoAttach({ autoAttach, waitForDebuggerOnStart, flatten })`
 *      → 新 target 一诞生就被**暂停**，我们才有机会在文档创建前插手
 *   3. 每个被附加的会话都注册一份 `Page.addScriptToEvaluateOnNewDocument`
 *      （⚠️ 必须**每个会话都注册**：自动附加的会话能活过重载，显式附加的活不过，
 *        而同一窗口可能同时拿到两个会话）
 *   4. **无论如何**都要 `Runtime.runIfWaitingForDebugger`
 *      （⚠️ 漏掉 = 那个渲染进程永久停在出生状态 = 用户看到白屏）
 *
 * 存活：由启动器以 `detached` 子进程方式拉起，pid 写进 `guard-<port>.pid`。
 * 不是计划任务，也不写注册表自启。
 */

import fsp from "node:fs/promises";
import fsSync from "node:fs";
import process from "node:process";

import { CdpSession, filterRendererTargets, waitForBrowserEndpoint } from "./cdp-client.mjs";
import { REPORT_BINDING } from "./constants.mjs";
import { buildInjectScript } from "./injector.mjs";
import { guardPidPath } from "./launch.mjs";
import { appendLog, readState, updateState } from "./state.mjs";
import { resolveStatePaths } from "./platform/workbuddy.mjs";
import { scanWeLibrary } from "./we-library.mjs";
import { sleep } from "./util.mjs";

/** 自动附加的宽限：新 target 诞生后会短暂被暂停，注入不能无限期拖着它 */
const ATTACH_INJECT_TIMEOUT_MS = 4000;
/** 放行（runIfWaitingForDebugger）自己的超时，必须有上限 */
const RESUME_TIMEOUT_MS = 3000;
/** 断线重连的基础退避 */
const RECONNECT_BASE_MS = 1000;
/** 连续失败多少次后放弃（此时应用大概已经关了） */
const MAX_RECONNECT_FAILURES = 6;

export async function runGuard({ flags = {}, json = false, deps = {} } = {}) {
  const paths = resolveStatePaths();
  const port = flags.port ? Number.parseInt(String(flags.port), 10) : null;
  if (!port) throw new Error("guard 需要 --port <N>");

  const say = (line) => {
    if (!json) process.stdout.write(`${line}\n`);
    void appendLog(`[guard ${port}] ${line}`, { paths });
  };

  // 先把注入脚本文本准备好 —— 必须在新窗口诞生**之前**就拿到它，
  // 那一刻守护连一个 target 都还没连上。
  // ⚠️ 这里必须自己扫一遍 WE 库：脚本文本里带着面板要用的库存条目
  //    （缩略图地址、scene 的 pkg 地址）。忘了扫的结果是"新窗口有壁纸层
  //    但面板里一条壁纸都没有"，而且不报任何错。
  const state = await readState({ paths });
  const scan = await scanWeLibrary({ withSize: false });
  const built = await buildInjectScript({ scan, state, paths });
  say(`注入脚本已就绪（${built.source.length} 字节，库存 ${scan.items.length} 条），开始守护端口 ${port}`);

  // 写 pid 文件，让启动器能回答"这个端口是不是已经有守护"
  await fsp.mkdir(paths.stateRoot, { recursive: true });
  const pidPath = guardPidPath(port, { paths });
  await fsp.writeFile(pidPath, String(process.pid), "utf8");

  const guard = new Guard({ port, paths, expression: built.source, say, deps });

  const cleanup = async () => {
    try {
      await fsp.unlink(pidPath);
    } catch {
      /* 已经不在了 */
    }
  };
  // 进程退出时尽力删掉 pid 文件。异步 API 在 exit 处理器里不保证跑完，
  // 所以这里用同步版（只在真正退出这一刻用一次，开销可忽略）。
  process.on("exit", () => {
    try {
      // eslint-disable-next-line no-sync
      fsSync.unlinkSync(pidPath);
    } catch {
      /* 文件已被删掉或权限不足 —— 都无所谓，pid 文件是尽力而为的提示 */
    }
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      say(`收到 ${signal}，退出守护`);
      guard.stop();
      void cleanup().then(() => process.exit(0));
    });
  }

  await guard.start();

  // 主循环：守护自己维护重连，这里只是保持进程活着并定期检查
  while (!guard.stopped) {
    await sleep(2000);
    if (guard.stopped) break;
    // 连续失败到上限 → 应用大概关了，自己退出（不留僵尸进程）
    if (guard.consecutiveFailures > MAX_RECONNECT_FAILURES) {
      say(`连续 ${guard.consecutiveFailures} 次重连失败，判定 WorkBuddy 已退出，守护结束`);
      break;
    }
  }

  await cleanup();
  return { ok: true, port, stopped: true };
}

/**
 * 守护主体。
 *
 * 暴露成类是为了能被测试注入替身（`deps`）。真实运行时只用到默认值。
 */
export class Guard {
  constructor({ port, paths, expression, say, deps = {} }) {
    this.port = port;
    this.paths = paths;
    this.expression = expression;
    this.say = say;
    this.deps = deps;
    this.stopped = false;
    this.consecutiveFailures = 0;
    this.session = null;
    /** 已经处理过的 sessionId（去重）。 */
    this.handledSessions = new Set();
    /** 已经注入过的 targetId（去重）。targetId 是 UUID，不复用，不需要清理。 */
    this.injectedTargets = new Set();
  }

  async start() {
    while (!this.stopped) {
      try {
        await this.connect();
        this.consecutiveFailures = 0;
        return;
      } catch (error) {
        this.consecutiveFailures += 1;
        this.say(`连接失败（第 ${this.consecutiveFailures} 次）：${error.message}`);
        if (this.consecutiveFailures > MAX_RECONNECT_FAILURES) throw error;
        await sleep(RECONNECT_BASE_MS * this.consecutiveFailures);
      }
    }
  }

  async connect() {
    const waitBrowser = this.deps.waitForBrowserEndpoint ?? waitForBrowserEndpoint;
    const SessionClass = this.deps.CdpSession ?? CdpSession;

    this.say("等待浏览器级 CDP 端点…");
    const endpoint = await waitBrowser(this.port, { timeoutMs: 60_000, pollMs: 250 });

    // ⚠️ 浏览器级会话**不能** enable Runtime/Page —— 协议会直接拒绝。
    const session = new SessionClass(endpoint.webSocketDebuggerUrl, { domains: [] });
    if (this.deps.CdpSession) {
      // 测试替身：domains 选项可能不被支持，无所谓
    }
    await session.open();
    this.session = session;
    this.say(`已连上浏览器级端点（${endpoint.Browser ?? "unknown"}）`);

    // 事件：新 target 被附加 / 会话分离
    session.on("Target.attachedToTarget", (params) => {
      void this.handleAttached(params);
    });
    session.on("Target.detachedFromTarget", (params) => {
      if (params?.sessionId) this.handledSessions.delete(params.sessionId);
    });
    session.on("Runtime.bindingCalled", (params) => {
      void this.handleBindingCalled(params);
    });
    session.on("close", () => {
      if (!this.stopped) this.scheduleReconnect();
    });

    // ⚠️ waitForDebuggerOnStart: 新 target 出生即暂停 —— 这是"首屏就有壁纸"的前提。
    //    flatten: 子会话的命令直接带 sessionId，省一层包装。
    await session.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    this.say("已开启 Target.setAutoAttach");

    // setAutoAttach 只管"之后新出现的"，已经在跑的窗口要显式补附加
    await this.attachExisting();

    return session;
  }

  /** 把已经在跑的 target 也纳进来。 */
  async attachExisting() {
    try {
      // 给自动附加的事件一点时间，避免同一个 target 被两条路各附加一次
      // （这本身不致命：注入是幂等的，只是多跑一次）
      await sleep(300);
      const result = await this.session.send("Target.getTargets", {});
      const pages = (result?.targetInfos ?? []).filter((t) => t.type === "page");
      for (const target of pages) {
        if (this.injectedTargets.has(target.targetId)) continue;
        try {
          const attached = await this.session.send("Target.attachToTarget", {
            targetId: target.targetId,
            flatten: true,
          });
          if (attached?.sessionId && !this.handledSessions.has(attached.sessionId)) {
            // 某些构建不发 attachedToTarget 事件 → 手动走一遍
            await this.handleAttached({
              sessionId: attached.sessionId,
              targetInfo: target,
              waitingForDebugger: false,
            });
          }
        } catch (error) {
          this.say(`附加 target ${target.targetId?.slice(0, 8)} 失败：${error.message}`);
        }
      }
    } catch (error) {
      this.say(`枚举既有 target 失败（不影响后续自动附加）：${error.message}`);
    }
  }

  /**
   * 处理一个被附加的 target。
   *
   * ⚠️ 三条硬约束（都在 docs/PITFALLS.md 里）：
   *   1. 非 page target（worker / service worker）**不注入但必须放行** ——
   *      它同样被 waitForDebuggerOnStart 暂停着，不放行会卡住它。
   *   2. 同一窗口可能拿到两个会话（自动 + 显式），而它们寿命不同 →
   *      **每个会话都注册一份首屏脚本**；即时注入与状态同步只做一次。
   *   3. 无论成败都要 `Runtime.runIfWaitingForDebugger`。
   */
  async handleAttached({ sessionId, targetInfo, waitingForDebugger }) {
    if (this.stopped || !sessionId) return;
    if (this.handledSessions.has(sessionId)) return;
    this.handledSessions.add(sessionId);

    const url = String(targetInfo?.url ?? "");
    const isRenderer = url.toLowerCase().includes("renderer/index.html");

    if (targetInfo?.type !== "page" || !isRenderer) {
      // 不是我们要注入的页面，但可能被暂停着 —— 必须放行
      await this.resumeIfWaiting(sessionId, waitingForDebugger, targetInfo);
      return;
    }

    const targetId = targetInfo?.targetId;
    const firstTime = !targetId || !this.injectedTargets.has(targetId);

    try {
      await this.inject(sessionId, { targetInfo, firstTime });
      if (targetId) this.injectedTargets.add(targetId);
      this.say(`已注入 ${url.slice(0, 90)}${firstTime ? "" : "（仅注册首屏脚本，重复会话）"}`);
    } catch (error) {
      this.say(`注入失败 ${url.slice(0, 90)}：${error.message}`);
    } finally {
      // ⚠️ 必须放行，且必须在 finally 里 —— 漏掉就是白屏
      await this.resumeIfWaiting(sessionId, waitingForDebugger, targetInfo);
    }
  }

  async inject(sessionId, { targetInfo, firstTime }) {
    const isRendererUrl = String(targetInfo?.url ?? "").toLowerCase().includes("renderer/index.html");
    if (!isRendererUrl) return;

    // 等待与注入之间加一道超时：新 target 被暂停着，注入不能无限期拖着它
    const work = (async () => {
      // 反向上报通道：渲染进程改了设置要能落盘
      try {
        await this.session.send("Runtime.enable", {}, { sessionId });
        await this.session.send("Runtime.addBinding", { name: REPORT_BINDING }, { sessionId });
      } catch (error) {
        this.say(`  注册上报通道失败（设置将只写 localStorage）：${error.message}`);
      }

      // 首屏脚本：让这个窗口**一诞生**就带壁纸，避免先看到白底再看到壁纸
      try {
        await this.session.send("Page.enable", {}, { sessionId });
        await this.session.send(
          "Page.addScriptToEvaluateOnNewDocument",
          { source: this.expression, runImmediately: true },
          { sessionId },
        );
      } catch (error) {
        this.say(`  注册首屏脚本失败：${error.message}`);
      }

      if (!firstTime) return;

      // 即时注入：这个窗口已经加载完了（例如守护是后起的），首屏脚本只对
      // "之后的导航"生效，所以还要现在就跑一遍。
      try {
        await this.session.send(
          "Runtime.evaluate",
          { expression: this.expression, awaitPromise: true, returnByValue: true },
          { sessionId },
        );
      } catch (error) {
        this.say(`  即时注入失败：${error.message}`);
      }
    })();

    await Promise.race([work, sleep(this.deps.attachTimeoutMs ?? ATTACH_INJECT_TIMEOUT_MS)]);
  }

  /**
   * 放行一个被 `waitForDebuggerOnStart` 暂停的 target。
   *
   * ⚠️ 这是守护里**最不能省**的一步：漏掉它，那个渲染进程会永久停在"出生即暂停"
   *    的状态，用户看到的是**白屏**。
   *
   * 这里不按 `waitingForDebugger` 字段做条件判断 —— 那是刻意的：
   *   · 有些构建不填这个字段
   *   · 对**没有**在等待的 target 调用 `runIfWaitingForDebugger` 是无害的空操作
   * 两害相权，无条件调用更安全。超时上限也是必须的：会话已经死了的话，
   * 这个 send 会一直挂着，从而把整个 attach 流程卡住。
   */
  async resumeIfWaiting(sessionId) {
    try {
      await Promise.race([
        this.session.send("Runtime.runIfWaitingForDebugger", {}, { sessionId }),
        sleep(this.deps.resumeTimeoutMs ?? RESUME_TIMEOUT_MS),
      ]);
    } catch (error) {
      // 非 page target / 已经在跑的 target 上没有执行上下文，报错属正常
      void error;
    }
  }

  /** 渲染进程回传数据（目前只有"状态变了"一种）。 */
  async handleBindingCalled(params) {
    if (params?.name !== REPORT_BINDING) return;
    let payload;
    try {
      payload = JSON.parse(params.payload ?? "{}");
    } catch {
      return;
    }
    if (payload?.type !== "state" || !payload.state) return;
    try {
      await updateState(
        {
          activeId: payload.state.activeId ?? null,
          tunables: payload.state.tunables,
          hidden: payload.state.hidden === true,
          rotateMinutes: payload.state.rotateMinutes,
          autoplay: payload.state.autoplay,
          rating: payload.state.rating,
          enabledKinds: payload.state.enabledKinds,
        },
        { paths: this.paths },
      );
    } catch (error) {
      this.say(`写状态失败：${error.message}`);
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    // 会话全都没了；target 还在的话不该重复即时注入，但首屏脚本需要重新注册，
    // 所以只清 handledSessions，保留 injectedTargets 会漏掉重连后的注册 ——
    // 因此两个都清：重连后重新走一遍完整流程（注入是幂等的，代价可接受）。
    this.handledSessions.clear();
    this.injectedTargets.clear();
    this.say("CDP 连接断开，准备重连…");
    void this.start();
  }

  stop() {
    this.stopped = true;
    try {
      this.session?.close();
    } catch {
      /* 忽略 */
    }
    this.session = null;
  }
}

export { filterRendererTargets };
