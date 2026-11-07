// Putting a new executable where the running one is. Only a packaged build has anything to replace — in source mode a
// checkout is what gets updated (cli/update.ts) and nothing here is reached.
//
// Windows will not let anything write over an executable that is running: the PoC measured it outright (
// phase3-poc-report.md 六 — `copyFileSync` onto the exe with the hub up is EBUSY and nothing else). What it does allow
// is that file being renamed, even while a process is running it. So the new one is staged beside the old one, the
// running one is renamed out of the way, the new one takes its name, and what was moved aside goes the next time this
// program starts, by which time nothing holds it. The scheduled task names the path, not the file, so it needs no
// change (host/service-win.ts).
//
// POSIX would need none of that — a rename over a running executable is allowed there and the old inode lives until
// the last process using it exits — but it goes through the same two steps anyway, so that one order of operations is
// the one that gets tested. 未在 macOS / Linux 上验证过：本轮只有 Windows 的机器。
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Where a downloaded executable waits until it is verified: beside the one it replaces, so the rename stays a rename. */
export const stagedName = (executable: string) => `${executable}.new`;
/** What the running one is renamed to so that its name is free. Taken away at the next start, not here. */
export const replacedName = (executable: string) => `${executable}.old`;

/**
 * A name nothing holds. `.old` is the one to use and almost always free; one left from an update whose next start has
 * not happened yet may still be held by a process that is running it, and renaming onto a held file fails on Windows
 * the same way writing to it does. So a moment is added rather than the swap being given up on.
 */
function freeOldName(executable: string) {
  const old = replacedName(executable);
  try {
    rmSync(old, { force: true });
  } catch {}
  return existsSync(old) ? `${old}-${Date.now()}` : old;
}

/**
 * The staged file takes the running one's name. What comes back is where the one that was running went, for the
 * caller to say so — and `null` where nothing had to be moved aside.
 *
 * Nothing is half done: a rename that fails after the running one has been moved aside puts it back and takes the
 * staged file away, so what is on the disk afterwards is either all of the new one or all of the old one. `rename` is
 * a parameter because that second failure cannot be produced on purpose on Windows — renaming a running executable is
 * exactly what the platform allows, and is why this works at all — so the way back is tested by failing it here.
 */
export function swapSelf(executable: string, { rename = renameSync } = {}) {
  const staged = stagedName(executable);
  if (!existsSync(staged)) throw new Error(`没有要换上去的文件：${staged} 不在`);
  const old = freeOldName(executable);
  const running = existsSync(executable);
  if (running) {
    try {
      rename(executable, old);
    } catch (error) {
      // The first rename, which is the one Windows really does refuse: something holding the executable open in a way
      // that forbids a rename (a virus scanner reading it, a debugger attached). Nothing has moved yet, so there is
      // nothing to put back — but the staged download has to go, or 96 MB sits beside the program for ever and the
      // next update's `rmSync` is the only thing that ever takes it away. And it is said as a sentence: a bare errno
      // thrown from here reached the person as `EBUSY: resource busy or locked, rename ...` and nothing else
      // (phase3-verification-round3.md A).
      try {
        rmSync(staged, { force: true });
      } catch {}
      throw new Error(
        `没能把手上这个 ${basename(executable)} 换开，什么都没动，下载到的那份已经删掉（${(error as Error).message}）：` +
          `这个文件被别的程序打开着（杀毒软件在读、调试器挂着）就是这样，过一阵再来一次`,
      );
    }
  }
  try {
    rename(staged, executable);
  } catch (error) {
    // Back as it was, and the half-finished download gone: a `.new` left behind would be taken for a verified one.
    if (running) {
      try {
        rename(old, executable);
      } catch (putBack) {
        throw new Error(
          `换文件失败了，而且没能把旧的放回去：现在 ${executable} 不在，旧的在 ${old}。` +
            `把它改回原名就能用（${(error as Error).message}；放回时 ${(putBack as Error).message}）`,
        );
      }
    }
    try {
      rmSync(staged, { force: true });
    } catch {}
    throw new Error(`换文件失败了，已经回到原样（${(error as Error).message}）`);
  }
  return { replaced: running ? old : null };
}

/**
 * What the last update moved aside, where nothing holds it any more. Called as this program starts (host/up.ts) and
 * before an update begins, and it never throws: a leftover file is a file, and failing to start over one would be
 * worse than the 96 MB it takes up.
 */
export function tidyReplaced(executable: string) {
  const old = basename(replacedName(executable));
  const folder = dirname(executable);
  let gone = 0;
  let names: string[] = [];
  try {
    names = readdirSync(folder);
  } catch {
    return 0;
  }
  for (const name of names) {
    // `.old` and the dated ones beside it, and nothing else: `.old` is this program's own suffix and no file of
    // anybody's is taken away on a guess.
    if (name !== old && !name.startsWith(`${old}-`)) continue;
    try {
      rmSync(join(folder, name), { force: true });
      if (!existsSync(join(folder, name))) gone += 1;
    } catch {}
  }
  return gone;
}
