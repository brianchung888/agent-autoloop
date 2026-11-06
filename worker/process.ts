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
import { readFileSync } from "node:fs";
import path from "node:path";

const WINDOWS = process.platform === "win32";
/** What started the run is this program's own runtime, so a number now held by anything else is not the run. */
const LAUNCHER_IMAGE = path.basename(process.execPath);
/**
 * One line per process: its number, its parent's, and the moment it was created. Nothing else is read, so the query
 * stays cheap to parse — and the third field costs nothing over the first two, which is what makes telling one holder
 * of a number from the next affordable at all.
 */
const PROCESS_TABLE_QUERY =
  "Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate |" +
  ' ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.Ticks)" }';

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

/** Every live process, the parent each was started by, and the moment each was created. */
type Table = { live: Set<number>; children: Map<number, number[]>; born: Map<number, string> };

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
    const born = new Map<number, string>();
    for (const line of printed.split(/\r?\n/)) {
      const [first, second, third] = line.trim().split(/\s+/);
      const child = Number(first);
      const parent = Number(second);
      if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
      live.add(child);
      children.set(parent, [...(children.get(parent) ?? []), child]);
      // A few of the system's own processes have no creation date to give. None of them was launched by this program.
      if (third && /^\d+$/.test(third)) born.set(child, third);
    }
    // An empty table is not an answer: this very process is in it, so nothing at all means the query said nothing.
    return live.size ? { live, children, born } : null;
  } catch {
    return null;
  }
}

/** What the worker wrote down about one launch, where no command line can be read back off the process. */
export type Launch = { pid?: number; startedAt?: number; marker?: string; born?: string };

/** The moment the process at this number was created, as this machine counts it, for writing down beside a launch. */
export function bornAt(pid: number | undefined): string | null {
  if (!pid || !WINDOWS) return null;
  // Only ever asked about a process that has just this moment started, which is in no table from before it: what was
  // kept would answer "nothing by that number", and a launch with nothing written down can never be told apart later.
  forgetProcesses();
  return processTable()?.born.get(pid) ?? null;
}

/**
 * Numbers already shown to be held by the process their record was written for. A number cannot be given to anything
 * else while the process holding it is alive, so this is asked once per number and not every tick: what it saves is a
 * second of the hub's own time, every tick, for as long as a run goes on.
 */
const confirmed = new Set<number>();

/**
 * Whether the number in a launch record is held by the process that record was written for. Windows gives a number
 * back once its process is gone, and `tasklist` would then say yes about whatever took it — so what the record says
 * about the moment of creation is compared with what the machine says now. Where that cannot be compared (an older
 * record, a table that would not be read) the answer stays yes: this is only ever asked about a number that is a live
 * process of this program's own runtime, and calling such a run gone would throw away work that is going on.
 */
function sameAsRecorded(pid: number, record: string | undefined) {
  if (!record || confirmed.has(pid)) return true;
  const born = processTable()?.born.get(pid);
  if (born === undefined) return true;
  if (born !== record) return false;
  confirmed.add(pid);
  return true;
}

/** What the worker wrote down at launch, or nothing where there is nothing to read. */
function launchRecord(file: string | undefined): Launch | null {
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Launch;
  } catch {
    return null;
  }
}

/**
 * Whether the run's own process is still going: false when it is gone, null when we could not look. `record` is the
 * file the launch was written down in (worker/worker.ts: launch-N.json), which is what Windows has instead of a
 * command line to read back.
 */
export function alive(pid: number | undefined, marker: string, record?: string): boolean | null {
  if (!pid) return false;
  if (WINDOWS) {
    const rows = tasklistRows([`PID eq ${pid}`, `IMAGENAME eq ${LAUNCHER_IMAGE}`]);
    if (rows === null) return null;
    if (!rows.some((row) => Number(row[1]) === pid)) return false;
    const written = launchRecord(record);
    // A record that names another number is not about this run at all, so it says nothing either way.
    if (written && written.pid !== undefined && written.pid !== pid) return true;
    return sameAsRecorded(pid, written?.born);
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
