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
  /** Say a `content-encoding` on an unpacked body. `identity` is the one a far end may spell out for no reason. */
  encoding?: string;
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
      const encoded = release.encoding ? { "content-encoding": release.encoding } : {};
      if (release.truncate) {
        // More promised than sent, and then the connection goes: the shape a download that broke arrives in.
        res.writeHead(200, { ...encoded, "content-length": String(Buffer.byteLength(body) + 1000) });
        res.write(body);
        return void res.destroy();
      }
      res.writeHead(200, { ...encoded, "content-length": String(Buffer.byteLength(body)) });
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

test("content-encoding: identity 不算打过包，长度还得比", async () => {
  // `identity` 是 HTTP 自己用来说「什么都没做」的词。别家不写，写了的那一家不应该因此让长度那一关关掉——
  // 关掉之后一份真的断了的下载就只能落到校验和那一关，说成「和发布的不是一份文件」（phase3-verification-round4.md 5）。
  await published({ encoding: "identity", truncate: true });
  const it = copy();
  await assert.rejects(() => updateBinary(it.hooks()), /下载.*断了/s);
  assert.equal(it.says(), "手上这一个");
  assert.equal(existsSync(stagedName(it.executable)), false);
  assert.equal(it.stopped.length, 0);
});

test("content-encoding: identity 的一份完整下载还是正常换上去", async () => {
  await published({ encoding: "IDENTITY" });
  const it = copy();
  assert.equal((await updateBinary(it.hooks())).changed, true);
  assert.equal(it.says(), "新的那一个");
});

test("没装常驻、中台却在跑的那台机器，得被告诉中台被停过", async () => {
  // phase3-verification-round3.md I：换文件前中台被停了一次，而没有常驻可以把它带回来。这是唯一一件这条命令
  // 收不回来的事（cli/self-update.ts 的开头就这么写），所以它必须进话里。
  await published();
  const it = copy();
  const done = await updateBinary(it.hooks({ service: () => false, upRunning: () => true }));
  assert.equal(done.changed, true);
  assert.equal(done.restarted, false);
  assert.equal(done.wasUp, true, "停过这件事没有带回来");
  assert.equal(it.stopped.length, 1);
  assert.equal(it.restarted.length, 0);

  // 而本来没在跑的那台，这句话不应该出现。
  const quiet = copy();
  const idle = await updateBinary(quiet.hooks({ service: () => false, upRunning: () => false }));
  assert.equal(idle.wasUp, false);
  assert.equal(quiet.stopped.length, 0);

  // 这两句话在 cli/main.ts 里：那边真的按 wasUp 分开说，否则上面这个字没人读。
  const main = readFileSync(join(import.meta.dirname, "..", "cli", "main.ts"), "utf8");
  assert.match(main, /done\.wasUp/, "cli/main.ts 没读 wasUp：中台被停过这件事还是没人说");
});

test("`.sha256` 里读的是哪一行：锚在行上、大小写不论、文件名必核", () => {
  const hex = "a".repeat(64);
  // 平常那一行：`sha256sum` 与 `shasum -a 256` 写的样子，包括按二进位读时那个 `*`。
  assert.equal(sumIn(`${hex}  ${NAME}\n`, NAME), hex);
  assert.equal(sumIn(`${hex} *${NAME}\n`, NAME), hex);
  // 大写的校验和读得出来，而且转成小写——比对的那一边是 `createHash().digest("hex")`，它永远是小写。
  assert.equal(sumIn(`${hex.toUpperCase()}  ${NAME}\n`, NAME), hex);
  // BSD / `shasum --tag` 那一种写法：以前整行被当成「没有文件名」，于是文件名一眼都没核过。
  assert.equal(sumIn(`SHA256 (${NAME}) = ${hex}\n`, NAME), hex);
  assert.throws(() => sumIn(`SHA256 (agent-autoloop-linux-x64) = ${hex}\n`, NAME), /不是/);
  // 带路径的名字按 basename 比，这是 `sha256sum build/x` 写出来的样子。
  assert.equal(sumIn(`${hex}  build/${NAME}\n`, NAME), hex);

  // 别的平台那一份，还是被拒掉而不是拿来比。
  assert.throws(() => sumIn(`${hex}  agent-autoloop-linux-x64\n`, "agent-autoloop-windows-x64.exe"), /不是/);
  assert.throws(() => sumIn("no digest here", NAME), /读不出校验和/);
  // 没有文件名的裸校验和不算一行：没有名字就没有东西可核，而核是这里必做的事。
  assert.throws(() => sumIn(`${hex}\n`, NAME), /读不出校验和/);
  // sha512 那一行不再被惄成 64 个字：锚在行上之前，它的前 64 个字会被当成 sha256 拿去比，结果是一句
  // 「对不上」——说的是让人别用这个文件，而真正的毛病是发布端附错了一个 `.sha512`。
  assert.throws(() => sumIn(`${"b".repeat(128)}  ${NAME}\n`, NAME), /读不出校验和/);
  // 多行的一份（一个 Release 把三个平台写在一起）：按名字挑自己这一行。
  const many = `${"c".repeat(64)}  agent-autoloop-linux-x64\n${hex}  ${NAME}\n`;
  assert.equal(sumIn(many, NAME), hex);
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

test("the first rename failing leaves nothing behind and says it as a sentence", async () => {
  // EBUSY on the running executable is the one of the two renames Windows really does refuse — something has it open
  // in a way that forbids a rename. It used to be thrown outside the `try`, so the 96 MB that had just been verified
  // stayed beside the program as a `.new` nobody would ever take away, and what the person read was a bare errno
  // (phase3-verification-round3.md A).
  await published();
  const it = copy();
  const swap = (executable: string) =>
    swapSelf(executable, {
      rename: () => {
        throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
      },
    });
  await assert.rejects(() => updateBinary(it.hooks({ swap })), /什么都没动.*已经删掉.*中台已经被停过一次/s);
  assert.equal(it.says(), "手上这一个");
  // Nothing of the 96 MB is left, and nothing was moved aside either: what is beside it is what was there before.
  assert.equal(existsSync(stagedName(it.executable)), false);
  assert.equal(existsSync(replacedName(it.executable)), false);
  assert.deepEqual(it.beside(), [`agent-autoloop${process.platform === "win32" ? ".exe" : ""}`]);
  assert.equal(it.restarted.length, 1);
});

/** An executable, a staged download beside it, and whatever `.old` this case is about. For swapSelf on its own. */
function staged(leftover?: string) {
  const dir = temp();
  const executable = join(dir, process.platform === "win32" ? "agent-autoloop.exe" : "agent-autoloop");
  writeFileSync(executable, "手上这一个");
  writeFileSync(stagedName(executable), "新的那一个");
  if (leftover !== undefined) writeFileSync(replacedName(executable), leftover);
  return { dir, executable };
}

test("第一次 rename 就失败的时候，上一次更新留下的 .old 也还在：「什么都没动」得是真的", () => {
  // 选那个名字的时候曾经先 rmSync 上一份 `.old`，而那是在第一次 rename 之前——恰恰就是 Windows 真会拒的
  // 那一次。于是一份失败的换文件说着「什么都没动」，却已经把上一次留下的那份拿走了（phase3-verification-round4.md 2）。
  const it = staged("上一次那一个");
  assert.throws(
    () =>
      swapSelf(it.executable, {
        rename: () => {
          throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
        },
      }),
    /什么都没动/,
  );
  // 这才是「什么都没动」：上一份还在，而且还是那些字。
  assert.equal(readFileSync(replacedName(it.executable), "utf8"), "上一次那一个");
  // 而 96 MB 那一份还是没留下（r3-A），手上这一个也没动。
  assert.equal(existsSync(stagedName(it.executable)), false);
  assert.equal(readFileSync(it.executable, "utf8"), "手上这一个");
});

test("换成了之后才把上一份 .old 清掉，而这一次移开的那一份换了个名字活着", () => {
  const it = staged("上一次那一个");
  const { replaced } = swapSelf(it.executable);
  assert.equal(readFileSync(it.executable, "utf8"), "新的那一个");
  // `.old` 被占着，所以这一次移开的那一份拿的是带时间的名字。
  assert.match(String(replaced), /\.old-\d+$/);
  assert.equal(readFileSync(String(replaced), "utf8"), "手上这一个");
  // 而上一份已经没了：清它这件事换成了之后才做，做了就做干净。
  assert.equal(existsSync(replacedName(it.executable)), false);
  assert.equal(existsSync(stagedName(it.executable)), false);
});

test(".old 本来就是空的时候，移开的那一份就叫 .old，没有多出来的清扫", () => {
  const it = staged();
  const { replaced } = swapSelf(it.executable);
  assert.equal(replaced, replacedName(it.executable));
  assert.equal(readFileSync(String(replaced), "utf8"), "手上这一个");
  assert.equal(readFileSync(it.executable, "utf8"), "新的那一个");
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

test("BUILT \u8ddf release.yml \u7684 matrix \u662f\u540c\u4e00\u5f20\u8868\uff1a\u4e24\u8fb9\u5404\u6539\u4e00\u534a\u5c31\u662f\u4e0b\u8f7d\u4e0d\u5230", () => {
  // assetName() \u8bf4\u7684\u662f\u300c\u8fd9\u53f0\u7535\u8111\u8be5\u53bb\u62ff\u54ea\u4e00\u4e2a\u6587\u4ef6\u300d\uff0c\u800c\u771f\u6b63\u6302\u4e0a\u53bb\u7684\u540d\u5b57\u662f .github/workflows/release.yml \u51b3\u5b9a\u7684\u3002
  // \u4e24\u8fb9\u4ece\u6ca1\u6709\u4efb\u4f55\u4e1c\u897f\u8fde\u7740\uff1a\u6539\u4e00\u8fb9\u4e0d\u6539\u53e6\u4e00\u8fb9\uff0c\u7ed3\u679c\u662f\u6574\u4e2a\u5e73\u53f0\u7684 update \u6c38\u8fdc\u8bf4\u300c\u8fd9\u4e00\u7248\u6ca1\u6709\u9644\u300d\uff0c\u800c release.yml
  // \u4ece\u672a\u8dd1\u8fc7\uff08phase3-verification-round3.md J\uff09\u3002\u8fd9\u6761\u6d4b\u8bd5\u628a\u5b83\u4eec\u8fde\u8d77\u6765\u3002
  const yml = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "release.yml"), "utf8");
  const include = /matrix:\n\s*include:\n((?:[^\S\n]*- os: .+\n[^\S\n]*name: .+\n)+)/.exec(yml);
  assert.ok(
    include,
    "release.yml \u91cc\u8bfb\u4e0d\u51fa matrix.include\uff1a\u8fd9\u6761\u6d4b\u8bd5\u6ca1\u5728\u770b\u4ec0\u4e48",
  );
  const matrix = [...include[1].matchAll(/- os: (\S+)\n\s*name: (\S+)/g)].map(([, os, name]) => ({ os, name }));
  assert.equal(
    matrix.length,
    3,
    `matrix \u91cc\u662f ${matrix.length} \u4e2a\u5e73\u53f0\uff0cBUILT \u91cc\u662f 3 \u4e2a`,
  );

  // \u540d\u5b57\u662f\u600e\u4e48\u62fc\u7684\uff0c\u4e5f\u8bfb release.yml \u81ea\u5df1\u90a3\u4e00\u6b65\uff0c\u800c\u4e0d\u662f\u5728\u8fd9\u91cc\u518d\u62c4\u4e00\u904d\u3002
  assert.match(yml, /suffix="\.exe"/, "Windows \u90a3\u4e00\u4efd\u4e0d\u518d\u662f \.exe \u7ed3\u5c3e\u4e86");
  assert.match(
    yml,
    /named="agent-autoloop-\$\{\{ matrix\.name \}\}\$suffix"/,
    "\u6302\u4e0a\u53bb\u7684\u540d\u5b57\u6362\u4e86\u62fc\u6cd5",
  );
  const attached = matrix.map(({ os, name }) => `agent-autoloop-${name}${os.startsWith("windows") ? ".exe" : ""}`);
  // \u8fd9\u4e09\u4e2a\u5e73\u53f0\u5c31\u662f BUILT \u91cc\u7684\u4e09\u4e2a\u952e\uff0c\u6309 assetName() \u95ee\u51fa\u6765\u3002
  const wanted = [assetName("win32", "x64"), assetName("darwin", "arm64"), assetName("linux", "x64")];
  assert.deepEqual(attached.sort(), wanted.sort());
  // \u65c1\u8fb9\u90a3\u4efd `.sha256` \u4e5f\u662f\u540c\u4e00\u4e2a\u540d\u5b57\u52a0\u540e\u7f00\uff0c\u56e0\u4e3a newestRelease() \u5c31\u662f\u8fd9\u4e48\u627e\u5b83\u7684\u3002
  assert.match(
    yml,
    /"\$named" > "\$named\.sha256"/,
    "`.sha256` \u4e0d\u518d\u662f\u300c\u540c\u4e00\u4e2a\u540d\u5b57\u52a0 .sha256\u300d\u4e86",
  );
});

test("a platform the Release has no binary for is told outright", () => {
  assert.throws(() => assetName("sunos", "mips"), /sunos-mips.*源码/s);
  assert.equal(assetName("win32", "x64"), "agent-autoloop-windows-x64.exe");
  assert.equal(assetName("darwin", "arm64"), "agent-autoloop-macos-arm64");
  assert.equal(assetName("linux", "x64"), "agent-autoloop-linux-x64");
});
