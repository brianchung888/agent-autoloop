// Node's HTTP server and nothing more: each request becomes a web Request for the kernel, each answer goes back out.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { t } from "./i18n.ts";
import { makeHandler } from "./server.ts";

/**
 * How long an idle connection is kept. Node's own answer is five seconds, and five seconds is the wrong answer for
 * this server, because this server shares its process with the worker (host/up.ts: the hub, the worker and the
 * channels are one process). The worker walks the whole process table now and then on Windows, which is a second or
 * two of synchronous work and was measured at up to 6.8 s of it under load — and while it runs, nothing here can
 * answer, nor close a connection on time, nor notice that it did.
 *
 * What that produced is what the sampling experiment measured (phase3-verification-round2.md #3): with the walk going
 * every tick, the worker's own calls to the hub failed with ECONNRESET 13 times in ten minutes, against 0 with the
 * walk off. Both ends are right and the connection still dies: the client has written a request onto a connection it
 * was told would live five seconds, and this end, catching up after the block, finds it idle past five seconds and
 * destroys it. The client cannot tell that from the hub having gone, so it waits and comes round again, and the hub
 * says it could not be reached in its own log.
 *
 * So the number is longer than anything can block this process for, and longer than any gap a client of this hub
 * leaves between two calls on one connection — the worker's 30-second pause after it could not be reached, and the
 * long poll's 30-second wait. A connection held a minute longer costs this server nothing: it serves a worker, a
 * handful of channels and a command line, all on this machine.
 *
 * `headersTimeout` goes with it. It is what limits the time from a request's first byte to its last header, and Node
 * will destroy a connection on whichever of the two comes first — leaving it at its own 60 seconds would put back a
 * shorter limit than the one being raised here.
 */
const KEEP_ALIVE = 70_000;
const HEADERS = 75_000;

export function serve(port: number, host = "127.0.0.1", { commit = "dev" }: { commit?: string } = {}) {
  const runtime = makeHandler(commit);
  const server = createServer(async (req, res) => {
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    try {
      const body = !["GET", "HEAD"].includes(req.method!) && {
        body: Readable.toWeb(req) as ReadableStream,
        duplex: "half",
      };
      const headers = req.headers as HeadersInit;
      const request = new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        signal: gone.signal,
        ...body,
      });
      const answer = await runtime.handle(request);
      // The rest of an unread body would be taken for the next request on this connection.
      if (!req.complete) res.setHeader("connection", "close");
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      if (!answer.body) return void res.end();
      Readable.fromWeb(answer.body as any)
        .on("error", () => res.destroy())
        .pipe(res);
    } catch (error) {
      console.error(error);
      if (res.headersSent) return void res.end();
      res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: t("http.serverError") }));
    }
  });
  server.keepAliveTimeout = KEEP_ALIVE;
  server.headersTimeout = HEADERS;
  server.on("close", runtime.close);
  server.listen({ port, host, backlog: 2048 });
  return server;
}
