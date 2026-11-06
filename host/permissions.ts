// Keeping this install's files to the person whose they are. On POSIX that is the mode they are made with, and nothing
// here changes it. Windows ignores a mode — chmod there moves one read-only bit and nothing else — so the same thing has
// to be said in the terms that file system has: an access list with inheritance turned off, granting this user alone.
//
// It is said once, on the folders, not on every file: a list that children inherit covers what is written inside them
// afterwards, and asking the system about every written file would cost a process each time.
//
// What cannot be done is not an error. A share, a FAT volume, a folder someone else owns: any of them can refuse, and
// refusing is not a reason to stop — it is a reason to say so. So the outcome is written down beside the files it was
// about, and `doctor` reads it back and tells the person what they do and do not have.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "./home.ts";

const windows = () => process.platform === "win32";
/** Beside the files it is about, so another process — `doctor` — can read what was managed. */
const markFile = () => path.join(HOME, "permissions.json");

type Mark = {
  /** When it was last said. */
  at: string;
  /** Nothing when every folder took it; otherwise the first refusal, in words a person can act on. */
  trouble: string | null;
};

/** One process per folder is cheap; one per folder per call is not. */
const said = new Map<string, string | null>();

/**
 * icacls, with every part its own argument: nothing is built into a line for a shell to read. `/inheritance:r` drops
 * what the folder above granted, `/grant:r` replaces this user's own entry rather than adding to it, and (OI)(CI) is
 * what makes the files and folders written inside it inherit the same.
 */
function lockOnWindows(target: string, folder: boolean) {
  const who = process.env.USERNAME;
  if (!who) return "不知道当前用户是谁（USERNAME 没有设）";
  const grant = folder ? `${who}:(OI)(CI)F` : `${who}:F`;
  const done = spawnSync("icacls", [target, "/inheritance:r", "/grant:r", grant], {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (done.error) return `icacls 运行不了：${done.error.message}`;
  if (done.status === 0) return null;
  const why = `${done.stderr ?? ""}${done.stdout ?? ""}`.trim().split(/\r?\n/)[0] ?? "";
  return `icacls 没能锁定 ${target}${why ? `：${why}` : ""}`;
}

/** Keeps the first refusal, and the fact that it was tried at all: a missing mark means nobody has tried. */
function remember(trouble: string | null) {
  const before = readMark();
  const mark: Mark = { at: new Date().toISOString(), trouble: before?.trouble ?? trouble };
  try {
    writeFileSync(`${markFile()}.tmp`, `${JSON.stringify(mark, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${markFile()}.tmp`, markFile());
  } catch {}
}

function readMark(): Mark | null {
  try {
    const mark = JSON.parse(readFileSync(markFile(), "utf8")) as Mark;
    return typeof mark?.at === "string" ? mark : null;
  } catch {
    return null;
  }
}

/** A folder only this person may read, made if it isn't there. The mode is what POSIX goes by, as it always was. */
export function secureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!windows()) return;
  if (said.has(dir)) return;
  const trouble = lockOnWindows(dir, true);
  said.set(dir, trouble);
  remember(trouble);
}

/** The same for one file that is already there. Inside a folder that took it, this is only belt and braces. */
export function secureFile(file: string) {
  if (!windows() || !existsSync(file)) return;
  if (said.has(file)) return;
  const trouble = lockOnWindows(file, false);
  said.set(file, trouble);
  remember(trouble);
}

/**
 * What this machine does not give the files, in words a person can act on, or nothing when it gives what POSIX does.
 * Read from what was written down, not asked again: what the answer was at the time is the thing worth reporting.
 */
export function permissionTrouble() {
  if (!windows()) return null;
  const mark = readMark();
  if (!mark) return "还没有锁过文件权限：运行一次 agent-autoloop init 或 up";
  if (!mark.trouble) return null;
  return `${mark.trouble}。同一台电脑上的其他用户可能读得到 ${HOME} 里的东西`;
}
