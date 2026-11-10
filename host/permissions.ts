// Keeping this install's files to the person whose they are. On POSIX that is the mode they are made with, and nothing
// here changes it. Windows ignores a mode — chmod there moves one read-only bit and nothing else — so the same thing has
// to be said in the terms that file system has: an access list with inheritance turned off, granting this user alone —
// and "alone" has to be made true rather than assumed, because turning inheritance off leaves whatever the folder was
// granted in its own right exactly where it was.
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
import { t } from "./i18n.ts";
import { systemTool } from "./system-tool.ts";

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

/** icacls, with every part its own argument: nothing is built into a line for a shell to read. */
function icacls(target: string, ...rest: string[]) {
  return spawnSync(systemTool("icacls"), [target, ...rest], {
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

/** The first line of what it said about why it would not, for a person who has to act on it. */
const complaint = (done: ReturnType<typeof icacls>) =>
  `${done.stderr ?? ""}${done.stdout ?? ""}`.trim().split(/\r?\n/)[0] ?? "";

/**
 * Whether an entry is this user's own. icacls answers with the name the machine knows it by — `MACHINE\someone`,
 * `A-DOMAIN\someone` — where USERNAME is the bare half of it, so the comparison is on that half as well as the whole.
 * Case is not a thing Windows accounts differ by.
 */
function isUser(name: string, who: string) {
  const bare = name.slice(name.lastIndexOf("\\") + 1);
  return bare.toLowerCase() === who.toLowerCase() || name.toLowerCase() === who.toLowerCase();
}

/**
 * Who the access list grants anything to, as icacls prints it: the path and then one `name:(flags)` per entry, the
 * first of them on the path's own line. The names come back as icacls wrote them and go back in the same way, as their
 * own argument — this is the file system's answer about itself, not something assembled here.
 */
function granted(target: string) {
  const asked = icacls(target);
  if (asked.error || asked.status !== 0) return null;
  const names: string[] = [];
  for (const line of (asked.stdout ?? "").split(/\r?\n/)) {
    const entry = line.startsWith(target) ? line.slice(target.length) : line;
    const colon = entry.indexOf(":");
    if (colon < 0) continue;
    const name = entry.slice(0, colon).trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * `/inheritance:r /grant:r` is not by itself enough, and the reason is worth writing down: `/inheritance:r` removes
 * what was inherited, and `/grant:r` replaces the entry of the user it names — neither touches an entry some other
 * principal holds on the folder itself. Under a person's own profile there are none, which is why this went unseen; on
 * a folder that got its list from the creating token instead of its parent (a CI runner's TEMP, an administrator
 * account) SYSTEM and Administrators are there in their own right, and `/inheritance:r` leaves them exactly where they
 * were. So they are asked about and removed by name.
 */
function dropEveryoneElse(target: string, who: string) {
  const names = granted(target);
  if (names === null) return t("permissions.icaclsUnreadable", { target });
  const others = names.filter((name) => !isUser(name, who));
  if (others.length === 0) return null;
  const done = icacls(target, "/remove", ...others);
  if (done.error) return t("permissions.icaclsBroken", { why: done.error.message });
  if (done.status !== 0) {
    const why = complaint(done);
    return `${t("permissions.othersLeft", { target, others: others.join("、") })}${why ? `：${why}` : ""}`;
  }
  return null;
}

/**
 * `/inheritance:r` drops what the folder above granted, `/grant:r` replaces this user's own entry rather than adding to
 * it, and (OI)(CI) is what makes the files and folders written inside it inherit the same. Then whatever else still
 * holds an entry of its own is taken off, so that what is left is this user and nobody else.
 */
function lockOnWindows(target: string, folder: boolean) {
  const who = process.env.USERNAME;
  if (!who) return t("permissions.noUser");
  const grant = folder ? `${who}:(OI)(CI)F` : `${who}:F`;
  const done = icacls(target, "/inheritance:r", "/grant:r", grant);
  if (done.error) return t("permissions.icaclsBroken", { why: done.error.message });
  if (done.status !== 0) {
    const why = complaint(done);
    return `${t("permissions.icaclsRefused", { target })}${why ? `：${why}` : ""}`;
  }
  return dropEveryoneElse(target, who);
}

/**
 * What this run found, for `doctor` to read back: the first thing refused in it, or nothing when every folder took it.
 * The fact that it was tried at all is the mark being there — a missing one means nobody has tried.
 *
 * This run, and not every run before it. A refusal kept for ever would go on saying a machine cannot do something long
 * after it can (a home moved off a share, a copy made on a local disk), with nothing a person could do to clear it.
 * What is kept within the run is every folder it asked about, so one refusal among several is still the answer.
 */
function remember() {
  const trouble = [...said.values()].find((why) => why !== null) ?? null;
  const mark: Mark = { at: new Date().toISOString(), trouble };
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
  said.set(dir, lockOnWindows(dir, true));
  remember();
}

/** The same for one file that is already there. Inside a folder that took it, this is only belt and braces. */
export function secureFile(file: string) {
  if (!windows() || !existsSync(file)) return;
  if (said.has(file)) return;
  said.set(file, lockOnWindows(file, false));
  remember();
}

/**
 * What this machine does not give the files, in words a person can act on, or nothing when it gives what POSIX does.
 * Read from what was written down, not asked again: what the answer was at the time is the thing worth reporting.
 */
export function permissionTrouble() {
  if (!windows()) return null;
  const mark = readMark();
  if (!mark) return t("permissions.neverLocked");
  if (!mark.trouble) return null;
  return t("permissions.trouble", { trouble: mark.trouble, home: HOME });
}
