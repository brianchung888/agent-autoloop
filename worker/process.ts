// Looking at a launched run and stopping it, on whichever platform this is. Three answers everywhere, never two: a run is
// going, it is gone, or it could not be looked at — the last is not the second, and the worker hands in `cancelled` only
// for the second (docs/protocol.md: 确认组内没有活进程后才交 cancelled).
//
// A POSIX run gets a process group of its own, so `ps` can be asked about the group and one signal reaches all of it.
// Windows has neither: `tasklist` says only whether a number is a process, and `taskkill /T` walks the tree in the kernel
// but posts a window message that a program without a window ignores, so only the forced kill ends such a tree. What
// Windows does keep is the parent each process was started by, for ever, even after that parent is gone: the tree can be
// walked from the whole table of processes, and a table that can't be read means the answer is "could not look".
import { execFileSync } from "node:child_process";
import path from "node:path";

const WINDOWS = process.platform === "win32";
/** What started the run is this program's own runtime, so a number now held by anything else is not the run. */
const LAUNCHER_IMAGE = path.basename(process.execPath);
/** One line per process: its number and its parent's. Nothing else is read, so the query stays cheap to parse. */
const PROCESS_TABLE_QUERY =
  "Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId |" +
  ' ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';

/**
 * tasklist leaves with 0 whether or not anything matched, and says that it found nothing in the console's own language.
 * What it found is in the CSV rows, and only a row starts with a quote: nothing else here reads its words.
 */
function tasklistRows(filters: string[]): string[][] | null {
  try {
    const printed = execFileSync("tasklist", ["/NH", "/FO", "CSV", ...filters.flatMap((filter) => ["/FI", filter])], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return printed
      .split(/\r?\n/)
      .filter((line) => line.startsWith('"'))
      .map((line) => line.split('","').map((field) => field.replace(/^"|"$/g, "")));
  } catch {
    return null;
  }
}

/** Every live process and the parent each was started by. */
type Table = { live: Set<number>; children: Map<number, number[]> };

/**
 * The whole table is one process to ask for and the best part of a second to wait for, and the worker asks about every
 * run it holds within the same tick — while the hub, which shares this process, waits. So it is asked for once and
 * kept for a moment: long enough that a tick pays for one query however many runs are in it, short enough that a loop
 * waiting for something to stop still sees it stop. A tick says outright when what was kept is from before it
 * (forgetProcesses), so every answer inside a tick is one picture of the machine rather than several.
 */
const FRESH = 1000;
let kept: { at: number; table: Table | null } | null = null;

function processTable(): Table | null {
  if (kept && Date.now() - kept.at < FRESH) return kept.table;
  // Timed from when the answer arrived, not from when it was asked for: the asking is the slow part, and starting the
  // clock before it would throw the answer away before anyone in the same tick could use it.
  const table = readProcessTable();
  kept = { at: Date.now(), table };
  return table;
}

/** Said at the start of a tick: whatever is kept is from before it, and this tick asks again. */
export function forgetProcesses() {
  kept = null;
}

/** Every live process and the parent each was started by, or null when the table could not be read. */
function readProcessTable(): Table | null {
  try {
    const printed = execFileSync(
      "powershell",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROCESS_TABLE_QUERY],
      { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    const live = new Set<number>();
    const children = new Map<number, number[]>();
    for (const line of printed.split(/\r?\n/)) {
      const [child, parent] = line.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
      live.add(child);
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }
    // An empty table is not an answer: this very process is in it, so nothing at all means the query said nothing.
    return live.size ? { live, children } : null;
  } catch {
    return null;
  }
}

/** Whether the run's own process is still going: false when it is gone, null when we could not look. */
export function alive(pid: number | undefined, marker: string): boolean | null {
  if (!pid) return false;
  if (WINDOWS) {
    const rows = tasklistRows([`PID eq ${pid}`, `IMAGENAME eq ${LAUNCHER_IMAGE}`]);
    if (rows === null) return null;
    return rows.some((row) => Number(row[1]) === pid);
  }
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return command.includes(marker);
  } catch (error) {
    // A process that is gone makes ps exit with status 1; anything else (EPERM, EACCES, a spawn
    // failure) means we could not look, which is not the same as it being gone.
    const status = (error as { status?: number | null }).status;
    if (status === 1) return false;
    return null;
  }
}

/** Whether anything in the run's group is still going, null when we could not look. */
export function treeAlive(pid: number | undefined): boolean | null {
  // The wrapper can die before a child; zombies have already stopped and only their parent can reap them.
  if (!pid) return false;
  if (WINDOWS) {
    // Asking about one number costs a tenth of what the whole table costs, and while the run's own process is there
    // the answer is already yes. Only once it has gone does anything under it have to be looked for.
    if (running(pid) === true) return true;
    const table = processTable();
    // Without the whole table the tree is only partly known, and a part of it is not an answer about all of it.
    if (!table) return null;
    const seen = new Set<number>();
    const pending = [pid];
    while (pending.length) {
      const next = pending.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (table.live.has(next)) return true;
      for (const child of table.children.get(next) ?? []) pending.push(child);
    }
    return false;
  }
  try {
    return execFileSync("ps", ["-ax", "-o", "pgid=", "-o", "stat="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .some((line) => {
        const [group, state] = line.trim().split(/\s+/);
        return Number(group) === pid && !state.startsWith("Z");
      });
  } catch {
    // ps itself may be missing or blocked in a sandbox. This group was started here, so it can be asked about
    // directly: no such group is gone, anything else means it couldn't be looked at.
    try {
      process.kill(-pid, 0);
      return true;
    } catch (failure) {
      return (failure as NodeJS.ErrnoException).code === "ESRCH" ? false : null;
    }
  }
}

/** Asks the run and everything under it to stop. `hard` leaves it no say; on Windows nothing else reliably does. */
export function terminate(pid: number | undefined, hard: boolean) {
  if (!pid) return;
  try {
    if (WINDOWS) {
      execFileSync("taskkill", ["/PID", String(pid), "/T", ...(hard ? ["/F"] : [])], {
        timeout: 15_000,
        stdio: "ignore",
      });
    } else process.kill(-pid, hard ? "SIGKILL" : "SIGTERM");
  } catch {}
}

/** Whether a number is a live process at all, whatever it is. For a lock, where a file beside it says whose it is. */
export function running(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (WINDOWS) {
    const rows = tasklistRows([`PID eq ${pid}`]);
    if (rows === null) return null;
    return rows.some((row) => Number(row[1]) === pid);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (failure) {
    const code = (failure as NodeJS.ErrnoException).code;
    // EPERM is someone else's process, which is still a process.
    if (code === "ESRCH") return false;
    return code === "EPERM" ? true : null;
  }
}
