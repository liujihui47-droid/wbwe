/**
 * CDP 客户端的回归测试。
 *
 * 这一层是整个插件里**最难在被测环境里验证**的部分：真实使用时对端是 WorkBuddy
 * 的 Chromium。所以这里起一个**真的 HTTP 服务器 + 迷你 WebSocket 服务器**
 * （只实现握手与文本帧），让代码走真实的 socket 路径，而不是打桩打掉一切。
 *
 * 覆盖：
 *   · `/json/list` 枚举与 target 过滤（renderer URL 命中）
 *   · `/json/version` 浏览器级端点 + **回环地址安全闸**（拒绝非 127.0.0.1）
 *   · CdpSession 的 id/await 关联、超时、事件分发、CDP error 传递
 *   · Runtime.evaluate 的 exceptionDetails 转成异常
 *   · 断线时把挂起请求一次性失败掉（避免调用方永久悬挂）
 *
 * 用法： node test/verify-cdp-client.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";

import {
  CdpSession,
  evaluateOnTargets,
  fetchBrowserEndpoint,
  fetchTargets,
  filterRendererTargets,
  isLoopbackWebSocketUrl,
  isPageTarget,
} from "../src/cdp-client.mjs";

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
// 迷你 WebSocket 服务器（只实现握手 + 文本帧 + 关闭）
// ---------------------------------------------------------------------------

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * 从一个累积缓冲里尝试解出一帧。
 * 返回 `{frame, rest}` 或 null（数据还不够）。客户端发来的帧一定是掩码的。
 */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { frame: { fin, opcode, payload }, rest: buf.subarray(offset + len) };
}

/**
 * 起一个假 CDP 服务器。
 *
 * `handler(text, socket, ctx)` 收到一条客户端消息，可以：
 *   · `socket.send(obj)` 回一条响应
 *   · `socket.sendRaw(str)` 回一条原始文本（测坏 JSON）
 *   · `socket.close()` 主动断开
 */
function startFakeCdp({ targets = [], version = null, handler = null } = {}) {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/json/list")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(targets));
      return;
    }
    if (req.url.startsWith("/json/version")) {
      if (!version) {
        res.writeHead(404);
        res.end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(version));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const sockets = new Set();

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);

    let buffer = Buffer.alloc(0);
    const wrapper = {
      send: (obj) => socket.write(encodeTextFrame(typeof obj === "string" ? obj : JSON.stringify(obj))),
      sendRaw: (text) => socket.write(encodeTextFrame(text)),
      close: () => socket.destroy(),
      socket,
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const decoded = decodeFrame(buffer);
        if (!decoded) break;
        buffer = decoded.rest;
        const { frame } = decoded;
        if (frame.opcode === 0x8) {
          socket.destroy();
          return;
        }
        if (frame.opcode === 0x1) {
          if (handler) handler(frame.payload.toString("utf8"), wrapper);
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** 一个"标准"的假 CDP 行为：evaluate 返回计算好的结果。 */
function defaultHandler(text, socket) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }
  if (msg.method === "Runtime.evaluate") {
    socket.send({ id: msg.id, result: { result: { type: "string", value: "EVAL:" + msg.params.expression } } });
    return;
  }
  socket.send({ id: msg.id, result: {} });
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

check("isLoopbackWebSocketUrl：接受 127.0.0.1", () => {
  assert.equal(isLoopbackWebSocketUrl("ws://127.0.0.1:9334/devtools/page/ABC"), true);
  assert.equal(isLoopbackWebSocketUrl("ws://localhost:9334/x"), true);
});

check("isLoopbackWebSocketUrl：拒绝非回环地址（安全闸）", () => {
  assert.equal(isLoopbackWebSocketUrl("ws://192.168.1.5:9334/x"), false);
  assert.equal(isLoopbackWebSocketUrl("ws://evil.example.com:9334/x"), false);
  assert.equal(isLoopbackWebSocketUrl("wss://10.0.0.1:9334/x"), false);
});

check("isLoopbackWebSocketUrl：拒绝缺少端口 / 带认证 / 带 hash", () => {
  assert.equal(isLoopbackWebSocketUrl("ws://127.0.0.1/x"), false, "缺端口应拒绝");
  assert.equal(isLoopbackWebSocketUrl("ws://user:pass@127.0.0.1:9334/x"), false, "带认证应拒绝");
  assert.equal(isLoopbackWebSocketUrl("ws://127.0.0.1:9334/x#frag"), false, "带 hash 应拒绝");
});

check("isLoopbackWebSocketUrl：拒绝非 ws 协议与垃圾输入", () => {
  assert.equal(isLoopbackWebSocketUrl("http://127.0.0.1:9334/x"), false);
  assert.equal(isLoopbackWebSocketUrl(""), false);
  assert.equal(isLoopbackWebSocketUrl(null), false);
  assert.equal(isLoopbackWebSocketUrl("not a url"), false);
});

check("isPageTarget：只认有 ws 地址的 page", () => {
  assert.equal(isPageTarget({ type: "page", webSocketDebuggerUrl: "ws://127.0.0.1:1/x" }), true);
  assert.equal(isPageTarget({ type: "page" }), false);
  assert.equal(isPageTarget({ type: "service_worker", webSocketDebuggerUrl: "ws://127.0.0.1:1/x" }), false);
  assert.equal(isPageTarget(null), false);
});

check("filterRendererTargets：命中 renderer/index.html", () => {
  const targets = [
    { type: "page", url: "file:///D:/WorkBuddy/resources/app.asar/renderer/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9334/a" },
    { type: "page", url: "devtools://devtools/bundled/x.html", webSocketDebuggerUrl: "ws://127.0.0.1:9334/b" },
    { type: "service_worker", url: "file:///x/renderer/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9334/c" },
  ];
  const hit = filterRendererTargets(targets);
  assert.equal(hit.length, 1);
  assert.ok(hit[0].url.includes("renderer/index.html"));
});

check("filterRendererTargets：大小写不敏感", () => {
  const targets = [{ type: "page", url: "file:///X/Renderer/Index.HTML", webSocketDebuggerUrl: "ws://127.0.0.1:1/a" }];
  assert.equal(filterRendererTargets(targets).length, 1);
});

check("filterRendererTargets：没有命中时返回空数组（不误伤别的页面）", () => {
  const targets = [{ type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:1/a" }];
  assert.deepEqual(filterRendererTargets(targets), []);
});

check("filterRendererTargets：hint 为空时退化为所有 page", () => {
  const targets = [
    { type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:1/a" },
    { type: "page", url: "file:///x", webSocketDebuggerUrl: "ws://127.0.0.1:1/b" },
  ];
  assert.equal(filterRendererTargets(targets, { hint: "" }).length, 2);
});

// ---------------------------------------------------------------------------
// HTTP 层
// ---------------------------------------------------------------------------

await checkAsync("fetchTargets：能枚举 target", async () => {
  const fake = await startFakeCdp({
    targets: [
      { id: "T1", type: "page", url: "file:///x/renderer/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:1/a" },
    ],
  });
  try {
    const list = await fetchTargets(fake.port);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "T1");
  } finally {
    await fake.close();
  }
});

await checkAsync("fetchTargets：端口不通时抛错（带超时，不会永久挂起）", async () => {
  await assert.rejects(() => fetchTargets(1, { timeoutMs: 800 }));
});

await checkAsync("fetchBrowserEndpoint：返回浏览器级 ws 地址", async () => {
  // ⚠️ 端口必须用真实的临时端口：安全闸会拒绝 <1024 的特权端口（那是**正确的**策略），
  //    所以测试里不能写死 ws://127.0.0.1:1/... —— 那会被正确地拒掉，
  //    看起来像"功能坏了"，其实正说明安全策略生效。
  const version = { Browser: "Chrome/138" };
  const fake = await startFakeCdp({ version });
  // 拿到真实端口后再补上 ws 地址（version 对象是引用，服务器读的是同一个对象）
  version.webSocketDebuggerUrl = `ws://127.0.0.1:${fake.port}/devtools/browser/XYZ`;
  try {
    const endpoint = await fetchBrowserEndpoint(fake.port);
    assert.equal(endpoint.Browser, "Chrome/138");
    assert.ok(endpoint.webSocketDebuggerUrl.includes("/devtools/browser/"));
    assert.ok(endpoint.webSocketDebuggerUrl.includes(String(fake.port)));
  } finally {
    await fake.close();
  }
});

await checkAsync("fetchBrowserEndpoint：非回环地址被拒绝（安全闸生效）", async () => {
  const fake = await startFakeCdp({ version: { Browser: "Chrome", webSocketDebuggerUrl: "ws://198.51.100.7:9334/devtools/browser/X" } });
  try {
    await assert.rejects(() => fetchBrowserEndpoint(fake.port), /不是本机回环地址|拒绝连接/);
  } finally {
    await fake.close();
  }
});

await checkAsync("fetchBrowserEndpoint：没有 /json/version 时抛错", async () => {
  const fake = await startFakeCdp({ version: null });
  try {
    await assert.rejects(() => fetchBrowserEndpoint(fake.port), /HTTP 404/);
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// WebSocket 会话层
// ---------------------------------------------------------------------------

await checkAsync("CdpSession：连接成功并完成 id/await 关联", async () => {
  const fake = await startFakeCdp({ handler: defaultHandler });
  const session = new CdpSession(`ws://127.0.0.1:${fake.port}/devtools/page/T1`);
  try {
    await session.open();
    const value = await session.evaluate("1+1");
    assert.equal(value, "EVAL:1+1");
  } finally {
    session.close();
    await fake.close();
  }
});

await checkAsync("CdpSession：并发请求能正确配对（按 id 而非顺序）", async () => {
  const fake = await startFakeCdp({
    handler: (text, socket) => {
      const msg = JSON.parse(text);
      if (msg.method === "Runtime.evaluate") {
        // 故意**乱序**回复：后到的先回，先到的后回
        const delay = msg.params.expression.includes("slow") ? 60 : 0;
        setTimeout(() => {
          socket.send({ id: msg.id, result: { result: { type: "string", value: msg.params.expression } } });
        }, delay);
      } else {
        socket.send({ id: msg.id, result: {} });
      }
    },
  });
  const session = new CdpSession(`ws://127.0.0.1:${fake.port}/x`);
  try {
    await session.open();
    const [slow, fast] = await Promise.all([session.evaluate("slow-expr"), session.evaluate("fast-expr")]);
    assert.equal(slow, "slow-expr", "慢请求被配错了响应");
    assert.equal(fast, "fast-expr", "快请求被配错了响应");
  } finally {
    session.close();
    await fake.close();
  }
});

await checkAsync("CdpSession：CDP error 被转成异常", async () => {
  const fake = await startFakeCdp({
    handler: (text, socket) => {
      const msg = JSON.parse(text);
      socket.send({ id: msg.id, error: { code: -32601, message: "Method not found" } });
    },
  });
  const session = new CdpSession(`ws://127.0.0.1:${fake.port}/x`);
  try {
    await session.open();
    await assert.rejects(() => session.evaluate("x"), /Method not found/);
  } finally {
    session.close();
    await fake.close();
  }
});

await checkAsync("CdpSession：命令超时会抛错（不会永久悬挂）", async () => {
  const fake = await startFakeCdp({ handler: () => {} }); // 永不回复
  const session = new CdpSession(`ws://127.0.0.1:${fake.port}/x`, { timeoutMs: 300 });
  try {
    await session.open();
    await assert.rejects(() => session.evaluate("x"), /超时/);
  } finally {
    session.close();
    await fake.close();
  }
});

await checkAsync("CdpSession：页面内抛错（exceptionDetails）变成异常", async () => {
  const fake = await startFakeCdp({
    handler: (text, socket) => {
      const msg = JSON.parse(text);
      socket.send({
        id: msg.id,
        result: {
          result: { type: "object", subtype: "error" },
          exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: x is not a function" } },
        },
      });
    },
  });
  const session = new CdpSession(`ws://127.0.0.1:${fake.port}/x`);
  try {
    await session.open();
    await assert.rejects(() => session.evaluate("x()"), /TypeError: x is not a function/);
  } finally {
    session.close();
    await fake.close();
  }
});

await checkAsync("CdpSession：事件分发到监听器", async () => {
  const fake = await startFakeCdp({
    handler: (text, socket) => {
      const msg = JSON.parse(text);
      socket.send({ id: msg.id, result: {} });
      // 顺带推一条事件
      socket.send({ method: "Runtime.bindingCalled", params: { name: "test", payload: "hello" } });
    },
  });
  const session = new CdpSession(`ws://127.0.0.1:${fake.port}/x`);
  try {
    await session.open();
    const seen = [];
    session.on("Runtime.bindingCalled", (params) => seen.push(params));
    await session.send("Runtime.enable");
    // 给事件一点到达时间
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].payload, "hello");
  } finally {
    session.close();
    await fake.close();
  }
});

await checkAsync("CdpSession：单个监听器抛错不影响其它监听器", async () => {
  const fake = await startFakeCdp({
    handler: (text, socket) => {
      const msg = JSON.parse(text);
      socket.send({ id: msg.id, result: {} });
      socket.send({ method: "Some.event", params: { n: 1 } });
    },
  });
  const session = new CdpSession(`ws://127.0.0.1:${fake.port}/x`);
  try {
    await session.open();
    let secondCalled = false;
    session.on("Some.event", () => {
      throw new Error("第一个监听器炸了");
    });
    session.on("Some.event", () => {
      secondCalled = true;
    });
    await session.send("X");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(secondCalled, true, "第一个监听器抛错把第二个也带走了");
  } finally {
    session.close();
    await fake.close();
  }
});

await checkAsync("CdpSession：连接断开时挂起的请求被失败掉（不永久悬挂）", async () => {
  const fake = await startFakeCdp({
    handler: () => {
      /* 不回复 */
    },
  });
  const session = new CdpSession(`ws://127.0.0.1:${fake.port}/x`, { timeoutMs: 30_000 });
  try {
    await session.open();
    const pending = session.evaluate("never-answered");
    await new Promise((r) => setTimeout(r, 80));
    session.close();
    await assert.rejects(() => pending, /关闭|关闭|CDP/);
  } finally {
    await fake.close();
  }
});

await checkAsync("CdpSession：on() 返回的退订函数生效", async () => {
  const fake = await startFakeCdp({ handler: defaultHandler });
  const session = new CdpSession(`ws://127.0.0.1:${fake.port}/x`);
  try {
    await session.open();
    let count = 0;
    const off = session.on("E", () => {
      count += 1;
    });
    off();
    assert.equal(typeof off, "function");
  } finally {
    session.close();
    await fake.close();
  }
});

await checkAsync("CdpSession：未打开就 send 会立刻拒绝", async () => {
  const session = new CdpSession("ws://127.0.0.1:1/x");
  await assert.rejects(() => session.send("A"), /未打开/);
});

await checkAsync("CdpSession：连不上时 open() 抛错而不是挂住", async () => {
  const session = new CdpSession("ws://127.0.0.1:1/x", { timeoutMs: 800 });
  await assert.rejects(() => session.open());
});

// ---------------------------------------------------------------------------
// evaluateOnTargets
// ---------------------------------------------------------------------------

await checkAsync("evaluateOnTargets：逐个 target 求值，失败被隔离", async () => {
  const good = await startFakeCdp({ handler: defaultHandler });
  try {
    const targets = [
      { id: "ok", webSocketDebuggerUrl: `ws://127.0.0.1:${good.port}/a` },
      { id: "bad", webSocketDebuggerUrl: "ws://127.0.0.1:1/b" }, // 连不上
    ];
    const results = await evaluateOnTargets(targets, "hi", { timeoutMs: 1500 });
    assert.equal(results.length, 2);
    const okResult = results.find((r) => r.targetId === "ok");
    const badResult = results.find((r) => r.targetId === "bad");
    assert.equal(okResult.ok, true);
    assert.equal(okResult.value, "EVAL:hi");
    assert.equal(badResult.ok, false, "连不上的 target 应记为失败而不是让整体抛错");
    assert.ok(badResult.error);
  } finally {
    await good.close();
  }
});

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

process.stdout.write("CDP 客户端回归（含迷你 WebSocket 服务器）\n");
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
void net;
if (failed) process.exitCode = 1;
