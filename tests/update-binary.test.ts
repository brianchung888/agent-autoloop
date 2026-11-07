// `update` in a packaged build (计划 plan-c 3.7). Failure cases: a file that is not the one the Release published is
// put where the program is, because the sum was never compared or was compared against one found elsewhere; a download
// that stopped halfway is taken for a whole file; a replacement that fails halfway leaves the machine with no
// executable at all; the hub is stopped for an update that then does not happen; «已经是最新的» is said by a build
// that cannot tell which version it is; the executable the last update moved aside is never taken away, and 96 MB sits
// there for ever; the platform this is running on has no binary in the Release and the one for another is downloaded.
//
// No network: a `node:http` server here stands in for the Release API and for the two downloads, which is what
// AGENT_AUTOLOOP_RELEASES is for. Nothing here touches a real install — the three things that reach this machine
// (stopping the hub, the service, which release this is) are handed in.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { replacedName, stagedName, swapSelf, tidyReplaced } from "../host/self-replace.ts";
import { assetName, sumIn, updateBinary } from "../cli/self-update.ts";

const dirs: string[] = [];
const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENT_AUTOLOOP_RELEASES;
});

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-update-"));
  dirs.push(dir);
  return dir;
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** This platform's name in a Release, which is also what the test's own server has to be asked for. */
const NAME = assetName();

type Release = {
  /** What the new executable says. */
  body?: string;
  /** What the `.sha256` beside it says; by default the sum of `body`, as the Release's own would. */
  sum?: string;
  tag?: string;
  /** Leave this platform's executable, or its sum, off the Release. */
  without?: string[];
  /** Say more bytes are coming than are sent, and then stop: a download that broke. */
  truncate?: boolean;
  /** Serve the executable gzipped, which is what a CDN in front of a Release may do of its own accord. */
  gzip?: boolean;
  /** Answer the lookup with this status instead. */
  status?: number;
};

/** The Release API and the two files it points at, on a port of this machine's. Returns how many downloads it served. */
async function published(release: Release = {}) {
  const body = release.body ?? "新的那一个";
  const served: string[] = [];
  let base = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    served.push(url.pathname);
    if (url.pathname === "/releases/latest") {
      if (release.status) return void res.writeHead(release.status).end("{}");
      const assets = [NAME, `${NAME}.sha256`]
        .filter((name) => !release.without?.includes(name))
        .map((name) => ({ name, browser_download_url: `${base}/assets/${name}` }));
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ tag_name: release.tag ?? "v9.9.9", assets }));
    }
    if (url.pathname === `/assets/${NAME}.sha256`) {
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end(`${release.sum ?? sha256(body)}  ${NAME}\n`);
    }
    if (url.pathname === `/assets/${NAME}`) {
      if (release.gzip) {
        // `content-length` is the length of the packed body, and `fetch` hands the caller the unpacked one: the two
        // numbers are about two different things, which is the whole of phase3-verification-round3.md H.
        const packed = gzipSync(Buffer.from(body));
        res.writeHead(200, { "content-encoding": "gzip", "content-length": String(packed.length) });
        return void res.end(packed);
      }
      if (release.truncate) {
        // More promised than sent, and then the connection goes: the shape a download that broke arrives in.
        res.writeHead(200, { "content-length": String(Buffer.byteLength(body) + 1000) });
        res.write(body);
        return void res.destroy();
      }
      res.writeHead(200, { "content-length": String(Buffer.byteLength(body)) });
      return void res.end(body);
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  base = `http://127.0.0.1:${port}`;
  process.env.AGENT_AUTOLOOP_RELEASES = base;
  return { served, body };
}

/** An install of one file: the executable, with what it says in it. Nothing of this machine's is reached. */
function copy(says = "手上这一个") {
  const dir = temp();
  const executable = join(dir, process.platform === "win32" ? "agent-autoloop.exe" : "agent-autoloop");
  writeFileSync(executable, says);
  const stopped: number[] = [];
  const restarted: number[] = [];
  return {
    dir,
    executable,
    stopped,
    restarted,
    says: () => readFileSync(executable, "utf8"),
    beside: () => readdirSync(dir).sort(),
    /** The three things that would reach a real machine, counted instead of done. */
    hooks: (over: Partial<Parameters<typeof updateBinary>[0]> = {}) => ({
      executable,
      stop: () => void stopped.push(Date.now()),
      restart: () => void restarted.push(Date.now()) as undefined,
      service: () => true,
      upRunning: () => true,
      have: () => "v1.0.0",
      ...over,
    }),
  };
}

test("it downloads this platform's binary, checks the sum, and puts it where the running one was", async () => {
  const { served } = await published();
  const it = copy();
  const done = await updateBinary(it.hooks());
  assert.deepEqual(
    { changed: done.changed, to: done.to, restarted: done.restarted },
    {
      changed: true,
      to: "v9.9.9",
      restarted: true,
    },
  );
  assert.equal(it.says(), "新的那一个");
  // The one that was running is beside it under `.old`, and the staged download is gone.
  assert.equal(readFileSync(replacedName(it.executable), "utf8"), "手上这一个");
  assert.equal(existsSync(stagedName(it.executable)), false);
  assert.equal(done.replaced, replacedName(it.executable));
  // Stopped once, before the swap, and started again after it.
  assert.equal(it.stopped.length, 1);
  assert.equal(it.restarted.length, 1);
  assert.deepEqual(served.sort(), [`/assets/${NAME}`, `/assets/${NAME}.sha256`, "/releases/latest"]);
});

test("the one that was moved aside goes at the next start, and nothing else beside it does", async () => {
  await published();
  const it = copy();
  await updateBinary(it.hooks());
  // Something of somebody's with a name of its own: it is not this program's to take away.
  writeFileSync(join(it.dir, "notes.txt"), "mine");
  writeFileSync(`${it.executable}.old-1700000000000`, "一个更早的");
  assert.equal(tidyReplaced(it.executable), 2);
  assert.deepEqual(it.beside(), [`agent-autoloop${process.platform === "win32" ? ".exe" : ""}`, "notes.txt"]);
});

test("a build that is already at the newest release downloads nothing and does not stop the hub", async () => {
  const { served } = await published({ tag: "v1.0.0" });
  const it = copy();
  assert.deepEqual(await updateBinary(it.hooks()), { changed: false, to: "v1.0.0" });
  assert.equal(it.says(), "手上这一个");
  assert.deepEqual(served, ["/releases/latest"]);
  assert.equal(it.stopped.length, 0);
});

test("a build that cannot say which release it is downloads rather than claiming to be up to date", async () => {
  await published();
  const it = copy();
  const done = await updateBinary(it.hooks({ have: () => null }));
  assert.equal(done.changed, true);
  assert.equal(it.says(), "新的那一个");
});

test("a sum that doesn't match replaces nothing, takes the download away, and never stops the hub", async () => {
  await published({ sum: "0".repeat(64) });
  const it = copy();
  await assert.rejects(() => updateBinary(it.hooks()), /对不上.*什么都没换/s);
  assert.equal(it.says(), "手上这一个");
  assert.equal(existsSync(stagedName(it.executable)), false);
  assert.equal(it.stopped.length, 0);
});

test("a download that stops halfway is told from a different file, and nothing is replaced", async () => {
  await published({ truncate: true });
  const it = copy();
  await assert.rejects(() => updateBinary(it.hooks()), /下载.*断了/s);
  assert.equal(it.says(), "手上这一个");
  assert.equal(existsSync(stagedName(it.executable)), false);
  assert.equal(it.stopped.length, 0);
});

test("an asset that arrives gzipped is not read as a download that broke", async () => {
  // What a CDN in front of a Release does on its own, and what `fetch` does on its own: the request goes out asking
  // for gzip, the body comes back packed with `content-length` saying how long the packed body is, and the runtime
  // unpacks it before anything here sees a byte. Comparing that length against what was counted said «断了» every
  // single time, so `update` could never go through at all — phase3-verification-round3.md H.
  const { served } = await published({ gzip: true });
  const it = copy();
  const done = await updateBinary(it.hooks());
  assert.equal(done.changed, true);
  // The whole file, and the sum of the whole file: what is on the disk is the unpacked bytes the `.sha256` is of.
  assert.equal(it.says(), "新的那一个");
  assert.deepEqual(served.sort(), [`/assets/${NAME}`, `/assets/${NAME}.sha256`, "/releases/latest"]);
});

test("a `.sha256` for another platform's file is refused rather than compared", () => {
  assert.throws(() => sumIn(`${"a".repeat(64)}  agent-autoloop-linux-x64\n`, "agent-autoloop-windows-x64.exe"), /不是/);
  assert.equal(sumIn(`${"a".repeat(64)}  ${NAME}\n`, NAME), "a".repeat(64));
  assert.throws(() => sumIn("no digest here", NAME), /读不出校验和/);
});

test("a rename that fails puts the running one back, and says so with the hub's state in it", async () => {
  await published();
  const it = copy();
  let renames = 0;
  // The way back cannot be reached by any real failure on Windows — renaming a running executable is what the platform
  // allows, and is the whole reason this design works — so the second rename is failed here instead.
  const swap = (executable: string) =>
    swapSelf(executable, {
      rename: (from, to) => {
        if (++renames === 2) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        return renameSync(from, to);
      },
    });
  await assert.rejects(() => updateBinary(it.hooks({ swap })), /回到原样.*中台已经被停过一次/s);
  assert.equal(it.says(), "手上这一个");
  assert.equal(existsSync(stagedName(it.executable)), false);
  // It was stopped before the swap was tried, so it is started again before the sentence is thrown.
  assert.equal(it.stopped.length, 1);
  assert.equal(it.restarted.length, 1);
});

test("a Release without this platform's two files says which one is missing and where to look", async () => {
  await published({ without: [`${NAME}.sha256`] });
  const it = copy();
  await assert.rejects(() => updateBinary(it.hooks()), new RegExp(`${NAME}\\.sha256.*releases`, "s"));
  assert.equal(it.says(), "手上这一个");
});

test("being rate limited is said as rate limiting, with the page to go to by hand", async () => {
  await published({ status: 403 });
  const it = copy();
  await assert.rejects(() => updateBinary(it.hooks()), /不让问了.*releases/s);
  assert.equal(it.stopped.length, 0);
});

test("a platform the Release has no binary for is told outright", () => {
  assert.throws(() => assetName("sunos", "mips"), /sunos-mips.*源码/s);
  assert.equal(assetName("win32", "x64"), "agent-autoloop-windows-x64.exe");
  assert.equal(assetName("darwin", "arm64"), "agent-autoloop-macos-arm64");
  assert.equal(assetName("linux", "x64"), "agent-autoloop-linux-x64");
});
