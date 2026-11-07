// Failure modes: a body declared far too large is read anyway, so a request nobody has checked yet holds a connection for
// nothing; a client told no is left on a connection that still expects the rest of its body, which breaks its next request;
// a connection nobody has touched for a few seconds is closed while this process could not answer anyway, and whoever was
// holding it finds it dead the moment it is needed.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

setup("body-limit");
const hub = await import("./hub.ts");
const { makeHandler } = await import("../host/server.ts");
const { serve } = await import("../host/http.ts");
const runtime = makeHandler();
after(runtime.close);
const key = hub.addKey("source", "app");
const MB = 1024 * 1024;

test("a body declared far too large isn't read at all", async () => {
  let read = 0;
  const body = new ReadableStream({
    pull(controller) {
      read += MB;
      controller.enqueue(new Uint8Array(MB));
    },
  });
  const answer = await runtime.handle(
    new Request("http://local/v1/events", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-length": String(8 * MB + 1) },
      body,
      duplex: "half",
    } as RequestInit),
  );
  assert.equal(answer.status, 413);
  assert.ok(read <= MB, `read ${read} bytes`);
});

test("a refused request that never sent its body gets its answer and a closed connection", async () => {
  const server = serve(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const socket = connect(port, "127.0.0.1");
    let said = "";
    socket.on("data", (chunk) => (said += chunk));
    socket.write(
      "POST /v1/events HTTP/1.1\r\nHost: local\r\n" +
        `Authorization: Bearer ${key}\r\nContent-Length: ${8 * MB + 1}\r\n\r\n`,
    );
    await once(socket, "close");
    assert.match(said, /^HTTP\/1\.1 413 /);
    assert.match(said, /connection: close/i);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("中台卡住几秒之后，闲着的那条连接还在：谁拿着它都不该发现它死了", async () => {
  // 这就是 phase3-verification-round2.md #3：中台和接单程序在一个进程里（host/up.ts），接单程序在 Windows 上
  // 隔一阵要走一遍整张进程表，一两秒的同步活儿，实测压上去过 6.8 秒。这几秒里中台答不了，也来不及按时关连接；
  // 回过神来才发现那条连接「闲置超过 keepAliveTimeout」就把它销毁，而对面刚把下一个请求写进去——于是 ECONNRESET。
  // 实测：取样每拍都走的时候十分钟 13 次，取样关掉 0 次。所以这个数字要比这个进程可能卡住的时间长。
  const server = serve(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    // Inside the `try`: a listening server nobody closes is a test process that never exits, and the whole point of
    // these two lines is that they are the ones that fail.
    assert.ok(server.keepAliveTimeout > 30_000, `keepAliveTimeout 只有 ${server.keepAliveTimeout} 毫秒`);
    assert.ok(
      server.headersTimeout > server.keepAliveTimeout,
      `headersTimeout（${server.headersTimeout}）不比 keepAliveTimeout（${server.keepAliveTimeout}）长，先到的那个说了算`,
    );
    const socket = connect(port, "127.0.0.1");
    let said = "";
    socket.on("data", (chunk) => (said += chunk));
    // A connection the far end has already ended: the write below lands on nothing and must not end this test process.
    socket.on("error", () => {});
    const crlf = String.fromCharCode(13, 10);
    const ask = () =>
      socket.write(`GET /healthz HTTP/1.1${crlf}Host: local${crlf}Connection: keep-alive${crlf}${crlf}`);
    const answers = async (how_many: number) => {
      for (let waited = 0; waited < 100 && said.split("HTTP/1.1").length - 1 < how_many; waited++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return said.split("HTTP/1.1").length - 1;
    };
    await once(socket, "connect");
    ask();
    assert.equal(await answers(1), 1, said);
    // 把这个进程卡住，和那一遍进程表卡住它的方式一模一样：同步，谁都插不进来。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6_000);
    // 让积压的计时器先跑完：要钉的是「该关它的那个计时器没有响」，而不是赶在它前面写进去。
    await new Promise((resolve) => setImmediate(resolve));
    // 本地这一头看不出来：实测 keepAliveTimeout=5000 时 socket.destroyed 仍然是 false，是下一个请求没人答——
    // 对面看到的就是 ECONNRESET。所以钉的是「下一个请求答得上来」，不是这一头的 destroyed 标记。
    ask();
    assert.equal(await answers(2), 2, `卡过之后那条连接答不了了：${said}`);
    socket.destroy();

    // 而这是缓解，不是根除：卡过 keepAliveTimeout 那么长，ECONNRESET 就会回来，因为原因一点没变——堵在这个
    // 进程里的是同步活儿。这一点要写在那个数字旁边，否则下一个读到它的人会以为这事已经没了（phase3-verification-round3.md #3）。
    const source = readFileSync(join(import.meta.dirname, "..", "host", "http.ts"), "utf8");
    assert.match(source, /does not take the cause away/, "host/http.ts 没写明这只是缓解");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
