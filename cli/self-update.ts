// `agent-autoloop update` in a packaged build: there is no checkout to pull, so what it does instead is fetch the
// executable the newest Release carries for this platform, check it against the `.sha256` beside it, and put it where
// this one is (host/self-replace.ts). 计划 plan-c 第五章 5.4 的 3.7。
//
// Three things are deliberate.
//
// The sum is the whole of the trust. The file is 96 MB of someone else's bytes arriving over the network, and the one
// thing that says it is the file the Release published is the digest published beside it — so it is checked before
// anything is renamed, and a mismatch means nothing on this disk moves. (Not a reproducible build: INSTALL.md says
// why a locally rebuilt binary has a different sum, which is why the Release's own `.sha256` is what is compared.)
//
// Nothing is replaced while the hub is running on Windows, even though renaming a running executable is allowed there.
// The hub is stopped the one way that reaches it on every platform — the stop file (host/service.ts: stopUp) — because
// a hub that keeps running out of the old file would go on holding the database while the new one is started.
//
// It is all or nothing. A failed download, a sum that does not match, a rename that does not go through: each leaves
// the executable that is there now exactly where it is, and says what happened in a sentence with something to do in
// it. The one thing it cannot undo is the hub having been stopped, so it says whether it started again.
import { chmodSync, createWriteStream, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { stablePath } from "../host/node-path.ts";
import { stagedName, swapSelf, tidyReplaced } from "../host/self-replace.ts";
import { restartService, runningUp, serviceRunning, stopUp } from "../host/service.ts";
import { releaseOf } from "../host/version.ts";

/** The one repository whose Releases this follows, spelled as cli/update.ts spells the same decision for a checkout. */
const PUBLISHED = "KKKKhazix/agent-autoloop";
/** Where a person goes when this cannot: the only address in any message here that a browser can be pointed at. */
export const RELEASES_PAGE = `https://github.com/${PUBLISHED}/releases`;
/**
 * The API this asks. Overridable so that the whole of it — the lookup, the download, a truncated body, a sum that does
 * not match — can be tested against a `node:http` server on this machine rather than against GitHub
 * (tests/update-binary.test.ts). Documented in INSTALL.md with the rest of them.
 */
const api = () =>
  (process.env.AGENT_AUTOLOOP_RELEASES || `https://api.github.com/repos/${PUBLISHED}`).replace(/\/$/, "");

/** Long enough for 96 MB on a slow line, short enough that a hung connection is not forever. */
const LOOKUP_TIMEOUT = 30_000;
const DOWNLOAD_TIMEOUT = 20 * 60_000;

/**
 * What the Release calls this platform's executable — the names .github/workflows/release.yml attaches, which is the
 * one place they are decided. A platform that is not built for is said outright: a download that silently got
 * somebody else's architecture is worse than being told to install from source.
 */
const BUILT: Record<string, string> = {
  "win32-x64": "agent-autoloop-windows-x64.exe",
  "darwin-arm64": "agent-autoloop-macos-arm64",
  "linux-x64": "agent-autoloop-linux-x64",
};

export function assetName(platform: string = process.platform, arch: string = process.arch) {
  const name = BUILT[`${platform}-${arch}`];
  if (name) return name;
  throw new Error(
    `Release 里没有 ${platform}-${arch} 的单文件版（只建 ${Object.keys(BUILT).join("、")}）。` +
      `这个平台要从源码装，见 INSTALL.md 的「安装」一节。`,
  );
}

/** What went wrong underneath, where `fetch` only says «fetch failed». */
const because = (error: unknown) => {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return cause ? `${error}（${code ? `${code}: ` : ""}${cause}）` : String(error);
};

/**
 * The request, with what the far end answered with said in words that have something to do in them. A connection that
 * never got there is the caller's to word — being unable to reach the page at all and a download that stopped partway
 * through are the same errno and two different things to do about it, and only the caller knows which it was asking
 * for. Everything about the answer itself is the same either way and is said here.
 */
async function ask(url: string, what: string, timeout: number) {
  const response = await fetch(url, {
    headers: { "user-agent": "agent-autoloop", accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(timeout),
  });
  // Unauthenticated calls are counted per address, and a machine behind one address can run out of them.
  if (response.status === 403 || response.status === 429) {
    throw new Error(
      `发布页暂时不让问了（HTTP ${response.status}，没登录的调用是按出口地址限次的）：` +
        `过一阵再来，或者手动下载 ${RELEASES_PAGE}`,
    );
  }
  if (!response.ok) throw new Error(`没能${what}：发布页返回 HTTP ${response.status}（手动下载：${RELEASES_PAGE}）`);
  return response;
}

/** Asking the Release API: not getting there at all is the network, and there is nothing to do but wait or go by hand. */
async function asks(url: string, what: string, timeout = LOOKUP_TIMEOUT) {
  try {
    return await ask(url, what, timeout);
  } catch (error) {
    if (error instanceof TypeError || (error as Error)?.name === "TimeoutError") {
      throw new Error(`连不上发布页，没能${what}（${because(error)}）：等网络好了再来，或者手动下载 ${RELEASES_PAGE}`);
    }
    throw error;
  }
}

type Asset = { name?: unknown; browser_download_url?: unknown };

/** The newest Release: which tag it is, and where this platform's two files are. */
async function newestRelease(name = assetName()) {
  const response = await asks(`${api()}/releases/latest`, "问出最新发布的版本");
  const release = (await response.json()) as { tag_name?: unknown; assets?: unknown };
  const tag = typeof release.tag_name === "string" && release.tag_name ? release.tag_name : null;
  if (!tag) throw new Error(`发布页答的东西里没有 tag_name，看不出最新是哪一版（手动下载：${RELEASES_PAGE}）`);
  const assets = Array.isArray(release.assets) ? (release.assets as Asset[]) : [];
  const urlOf = (wanted: string) => {
    const found = assets.find((asset) => asset.name === wanted);
    const url = found?.browser_download_url;
    if (typeof url !== "string" || !url) return null;
    return url;
  };
  const file = urlOf(name);
  const sum = urlOf(`${name}.sha256`);
  if (!file || !sum) {
    const missing = [!file && name, !sum && `${name}.sha256`].filter(Boolean).join(" 和 ");
    throw new Error(
      `${tag} 这一版没有附 ${missing}，这台电脑要的就是它（附了：${assets.map((asset) => asset.name).join("、") || "没有"}）。` +
        `换一版或者手动下载 ${RELEASES_PAGE}`,
    );
  }
  return { tag, file, sum };
}

/**
 * The digest out of a `.sha256`, which is what `sha256sum` and `shasum -a 256` write: the hex, two spaces, the name.
 * The name is checked where there is one — a `.sha256` for the wrong platform's file would otherwise be compared
 * against this platform's download and simply not match, which says nothing about which of the two is wrong.
 */
export function sumIn(text: string, name: string) {
  const found = /([0-9a-f]{64})(?:[ \t]+\*?(\S+))?/.exec(text);
  if (!found) throw new Error(`.sha256 里读不出校验和：${JSON.stringify(text.slice(0, 200))}`);
  if (found[2] && basename(found[2]) !== name) throw new Error(`.sha256 说的是 ${found[2]}，不是这台电脑要的 ${name}`);
  return found[1];
}

/**
 * The file, onto the disk, with its digest taken as it goes. Streamed rather than held: the thing being downloaded is
 * most of a hundred megabytes and this process is also the hub on a machine where the hub is the thing being updated.
 *
 * A body that stops early is told apart from one that finished: `content-length` is what the far end said it would
 * send, and a count that falls short of it is a broken download and not a different file. A download that stops early
 * without having said how long it would be fails the digest below instead, which is the same answer by another road.
 */
async function downloadTo(url: string, file: string, name = basename(file)) {
  /** A download that did not finish, whichever of the three ways it failed to. Nothing half-written is left behind. */
  const broke = (why: string) => {
    rmSync(file, { force: true });
    return new Error(`下载 ${name} 断了（${why}）：重来一次，或者手动下载 ${RELEASES_PAGE}`);
  };
  let response: Response;
  try {
    response = await ask(url, `下载 ${name}`, DOWNLOAD_TIMEOUT);
  } catch (error) {
    // A body that stops partway through can fail here rather than below: the far end said how long it would be and
    // then went, which the runtime reports as the request itself having failed and not as a short read.
    if (error instanceof TypeError || (error as Error)?.name === "TimeoutError") throw broke(because(error));
    throw error;
  }
  if (!response.body) throw broke("答复里没有内容");
  const said = Number(response.headers.get("content-length"));
  const digest = createHash("sha256");
  let got = 0;
  const bytes = Readable.fromWeb(response.body as never);
  bytes.on("data", (chunk: Buffer) => {
    digest.update(chunk);
    got += chunk.length;
  });
  try {
    await pipeline(bytes, createWriteStream(file));
  } catch (error) {
    throw broke(because(error));
  }
  if (Number.isInteger(said) && said > 0 && got !== said) throw broke(`说好 ${said} 个字节，只到了 ${got} 个`);
  return { sum: digest.digest("hex"), bytes: got };
}

export type Replaced = {
  changed: boolean;
  /** The release it is now at. */
  to: string;
  /** Where the one that was running went, for the next start to take away. */
  replaced?: string | null;
  /** What could not be restarted from here, in words for whoever owns it. */
  told?: string;
  /** Whether it was this program that had been keeping the hub up, and so whether it is back. */
  restarted?: boolean;
};

/**
 * The whole of it. The pieces that reach the machine are parameters so that a test can stand in for them: this is the
 * one command whose job is to stop the hub and overwrite the program, and a test of it that used the real ones would
 * be a test that stops the hub this machine is actually running.
 */
export async function updateBinary({
  executable = stablePath(process.execPath),
  stop = stopUp,
  restart = restartService,
  service = serviceRunning,
  upRunning = () => typeof runningUp() === "number",
  have = () => releaseOf(),
  swap = swapSelf,
}: {
  executable?: string;
  stop?: () => void;
  restart?: () => string | undefined;
  service?: () => boolean;
  upRunning?: () => boolean;
  have?: () => string | null;
  swap?: (executable: string) => { replaced: string | null };
} = {}): Promise<Replaced> {
  // Last time's, if the start that should have taken it away never happened. Before the download, so that the 96 MB
  // this is about to write has somewhere to be.
  tidyReplaced(executable);
  const name = assetName();
  const newest = await newestRelease(name);
  const at = have();
  // Only a tag can say «already newest». A build off an untagged commit knows no version of its own (host/version.ts),
  // and claiming it is up to date because it cannot compare would be the one wrong answer here.
  if (at && at === newest.tag) return { changed: false, to: newest.tag };

  const staged = stagedName(executable);
  rmSync(staged, { force: true });
  const published = sumIn(await (await asks(newest.sum, `下载 ${name}.sha256`)).text(), name);
  const { sum } = await downloadTo(newest.file, staged, name);
  if (sum !== published) {
    rmSync(staged, { force: true });
    throw new Error(
      `下载下来的 ${name} 和 Release 上的 .sha256 对不上，已经删掉，什么都没换：` +
        `说好 ${published}，拿到 ${sum}。别自己找来的那一份去对——Release 上的 .sha256 才是凭据（INSTALL.md 讲了为什么自己重建的不一样）。` +
        `重下一次还是对不上就先别用，到 ${RELEASES_PAGE} 看看。`,
    );
  }
  // A downloaded file is not executable on POSIX until it is said to be, and the service would start nothing.
  if (process.platform !== "win32") {
    try {
      chmodSync(staged, 0o755);
    } catch (error) {
      rmSync(staged, { force: true });
      throw new Error(`没能把 ${staged} 设成可执行（${(error as Error).message}）：什么都没换。`);
    }
  }

  // From here the hub is stopped, so everything says what state it left things in.
  const hadService = service();
  const hadUp = upRunning();
  if (hadUp) stop();
  let replaced: string | null;
  try {
    ({ replaced } = swap(executable));
  } catch (error) {
    const again = hadService ? restart() : undefined;
    throw new Error(
      `${(error as Error).message}。手上这一版还在用；` +
        (hadUp
          ? `中台已经被停过一次${again ? `（${again}）` : hadService ? "，已经重新启动" : "，要再 agent-autoloop up"}。`
          : ""),
    );
  }
  const told = hadService ? restart() : undefined;
  return { changed: true, to: newest.tag, replaced, told, restarted: hadService && !told };
}
