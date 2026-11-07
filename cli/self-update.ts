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
import { t } from "../host/i18n.ts";
import { stablePath } from "../host/node-path.ts";
import { stagedName, swapSelf, tidyReplaced } from "../host/self-replace.ts";
import { restartService, runningUp, serviceRunning, stopUp } from "../host/service.ts";
import { releaseOf } from "../host/version.ts";

/** The one repository whose Releases this follows, spelled as cli/update.ts spells the same decision for a checkout. */
const PUBLISHED = "brianchung888/agent-autoloop";
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
  throw new Error(t("cli.selfUpdate.noBuild", { platform, arch, built: Object.keys(BUILT).join("、") }));
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
    throw new Error(t("cli.selfUpdate.rateLimited", { status: response.status, page: RELEASES_PAGE }));
  }
  if (!response.ok)
    throw new Error(t("cli.selfUpdate.httpError", { what, status: response.status, page: RELEASES_PAGE }));
  return response;
}

/** Asking the Release API: not getting there at all is the network, and there is nothing to do but wait or go by hand. */
async function asks(url: string, what: string, timeout = LOOKUP_TIMEOUT) {
  try {
    return await ask(url, what, timeout);
  } catch (error) {
    if (error instanceof TypeError || (error as Error)?.name === "TimeoutError") {
      throw new Error(t("cli.selfUpdate.unreachable", { what, why: because(error), page: RELEASES_PAGE }));
    }
    throw error;
  }
}

type Asset = { name?: unknown; browser_download_url?: unknown };

/** The newest Release: which tag it is, and where this platform's two files are. */
async function newestRelease(name = assetName()) {
  const response = await asks(`${api()}/releases/latest`, t("cli.selfUpdate.whatLatest"));
  const release = (await response.json()) as { tag_name?: unknown; assets?: unknown };
  const tag = typeof release.tag_name === "string" && release.tag_name ? release.tag_name : null;
  if (!tag) throw new Error(t("cli.selfUpdate.noTag", { page: RELEASES_PAGE }));
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
    const missing = [!file && name, !sum && `${name}.sha256`].filter(Boolean).join(` ${t("cli.selfUpdate.and")} `);
    throw new Error(
      t("cli.selfUpdate.missingAssets", {
        tag,
        missing,
        attached: assets.map((asset) => asset.name).join("、") || t("cli.selfUpdate.nothing"),
        page: RELEASES_PAGE,
      }),
    );
  }
  return { tag, file, sum };
}

/**
 * The digest out of a `.sha256`, read a line at a time and anchored to the line. Two spellings are understood, which
 * are the two the tools that write these produce: `sha256sum` and `shasum -a 256` write the hex, then whitespace (with
 * a `*` where the file was read as binary), then the name; `shasum --tag` and the BSD tools write `SHA256 (name) =
 * hex`. The hex is read either case.
 *
 * The name is always checked, and a line without one is not a line this reads. What is being guarded against is
 * quietly comparing the wrong number (phase3-verification-round3.md K): unanchored, the first 64 characters of a
 * `sha512` line matched and were taken for a sha256, so a `.sha512` served under the wrong name would have failed as
 * «对不上» rather than as what it was; a name only checked where one was found let the BSD spelling through with no
 * check at all; and a digest written in capitals read as no digest.
 */
export function sumIn(text: string, name: string) {
  const others: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const plain = /^[ \t]*([0-9a-fA-F]{64})[ \t]+\*?(\S.*?)[ \t]*$/.exec(line);
    const tagged = /^[ \t]*SHA256[ \t]*\(([^)]*\S)\)[ \t]*=[ \t]*([0-9a-fA-F]{64})[ \t]*$/i.exec(line);
    const found = plain ? { sum: plain[1], file: plain[2] } : tagged ? { sum: tagged[2], file: tagged[1] } : null;
    if (!found) continue;
    if (basename(found.file) === name) return found.sum.toLowerCase();
    others.push(found.file);
  }
  if (others.length) throw new Error(t("cli.selfUpdate.sumNameMismatch", { said: others.join("、"), wanted: name }));
  throw new Error(t("cli.selfUpdate.noSumInFile", { text: JSON.stringify(text.slice(0, 200)) }));
}

/**
 * The file, onto the disk, with its digest taken as it goes. Streamed rather than held: the thing being downloaded is
 * most of a hundred megabytes and this process is also the hub on a machine where the hub is the thing being updated.
 *
 * A body that stops early is told apart from one that finished: `content-length` is what the far end said it would
 * send, and a count that falls short of it is a broken download and not a different file. A download that stops early
 * without having said how long it would be fails the digest below instead, which is the same answer by another road.
 *
 * Unless the body arrived compressed, and then those are two different counts of two different things. `fetch` asks
 * for gzip of its own accord and hands back what it unpacked, while `content-length` stays the length of what was
 * packed — so comparing them says «断了» on every single download of an asset a CDN chose to compress, and an
 * update that can never go through is worse than one that cannot tell a short read from a whole file
 * (phase3-verification-round3.md H). Where there is a `content-encoding` the length is not compared, and a body that
 * stopped early goes to the digest, which is where one that never said its length goes too.
 */
async function downloadTo(url: string, file: string, name = basename(file)) {
  /** A download that did not finish, whichever of the three ways it failed to. Nothing half-written is left behind. */
  const broke = (why: string) => {
    rmSync(file, { force: true });
    return new Error(t("cli.selfUpdate.downloadBroke", { name, why, page: RELEASES_PAGE }));
  };
  let response: Response;
  try {
    response = await ask(url, t("cli.selfUpdate.whatDownload", { name }), DOWNLOAD_TIMEOUT);
  } catch (error) {
    // A body that stops partway through can fail here rather than below: the far end said how long it would be and
    // then went, which the runtime reports as the request itself having failed and not as a short read.
    if (error instanceof TypeError || (error as Error)?.name === "TimeoutError") throw broke(because(error));
    throw error;
  }
  if (!response.body) throw broke(t("cli.selfUpdate.emptyBody"));
  const packed = response.headers.get("content-encoding");
  const said = packed ? NaN : Number(response.headers.get("content-length"));
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
  // Two different things, said as two. A backstop rather than the first line of defence: HTTP framing catches most
  // short bodies before this, as a request that failed (above). Long is what a compressed body used to be reported
  // as «说好 40 个字节，只到了 96000000 个», which is not what happened — and the encoding is accounted for above now.
  // Both sentences are kept anyway: a mismatch described backwards is worse than one line that is rarely read.
  if (Number.isInteger(said) && said > 0 && got !== said) {
    throw broke(t(got < said ? "cli.selfUpdate.shortRead" : "cli.selfUpdate.longRead", { said, got }));
  }
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
  /**
   * Whether the hub was up when this began, and so whether it was stopped for the swap. Without it the one case
   * nobody is told about is a machine with no service and a hub someone started by hand: it was stopped, it is not
   * coming back on its own, and what was printed was 「再 agent-autoloop up 就用上新版了」 as though nothing had been
   * running (phase3-verification-round3.md I).
   */
  wasUp?: boolean;
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
  const published = sumIn(
    await (await asks(newest.sum, t("cli.selfUpdate.whatDownload", { name: `${name}.sha256` }))).text(),
    name,
  );
  const { sum } = await downloadTo(newest.file, staged, name);
  if (sum !== published) {
    rmSync(staged, { force: true });
    throw new Error(t("cli.selfUpdate.sumMismatch", { name, published, got: sum, page: RELEASES_PAGE }));
  }
  // A downloaded file is not executable on POSIX until it is said to be, and the service would start nothing.
  if (process.platform !== "win32") {
    try {
      chmodSync(staged, 0o755);
    } catch (error) {
      rmSync(staged, { force: true });
      throw new Error(t("cli.selfUpdate.notExecutable", { staged, why: (error as Error).message }));
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
    const hub = !hadUp
      ? ""
      : again
        ? t("cli.selfUpdate.hubStoppedAgain", { again })
        : hadService
          ? t("cli.selfUpdate.hubStoppedRestarted")
          : t("cli.selfUpdate.hubStoppedNeedsUp");
    throw new Error(t("cli.selfUpdate.swapFailed", { why: (error as Error).message, hub }));
  }
  const told = hadService ? restart() : undefined;
  return { changed: true, to: newest.tag, replaced, told, restarted: hadService && !told, wasUp: hadUp };
}
