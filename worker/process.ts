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
import { readFileSync, writeFileSync } from "node:fs";
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
 * The moment one process was created, and nothing else. The number is handed in as an environment value and cast by
 * the query, so this text is a constant: nothing of a caller's ever becomes part of what runs.
 */
const ONE_PROCESS_QUERY =
  'Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $([int]$env:AGENT_AUTOLOOP_PID)"' +
  " -Property CreationDate | ForEach-Object { $_.CreationDate.Ticks }";

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
 * (forgetProcesses), so every answer inside a tick is one picture of the machine rather than several — and what is kept
 * has to outlast a tick that launches something, because asking the machine when that process came into being takes a
 * second of its own and a picture thrown away in the middle of a tick is a second query for the same tick.
 */
const FRESH = 3000;
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

/**
 * What the worker wrote down about one launch, where no command line can be read back off the process.
 *
 * `tree` is added to afterwards, by whoever walks the run's tree: every descendant that walk reached, against the
 * moment that descendant came into being. A level of the tree that is gone by the time the table is read can never be
 * walked through again — Windows keeps its number on whatever hung off it, and that number is by then either nobody's
 * or somebody else's — so a level seen once is written down while it can still be seen, and what hangs off it stays
 * reachable after it goes.
 */
export type Launch = {
  pid?: number;
  startedAt?: number;
  marker?: string;
  born?: string;
  /** `<进程号>` → the moment it came into being, as this machine counts it. */
  tree?: Record<string, string>;
};

/**
 * How many descendants are written down. A run's tree is small; this is only here so that a program starting one
 * process after another cannot grow the file without end. Past it nothing more is added — what is already written is
 * what can still be found, and dropping those to make room would lose the levels that are hardest to reach again.
 */
const REMEMBER_TREE = 256;

/**
 * The moment the process at this number was created, as this machine counts it, for writing down beside a launch.
 *
 * Asked about one number and no other. Listing the whole table for it costs the best part of three seconds and would
 * have to throw away what this tick had already kept — a launch is about a process that started this very moment, and
 * no table from before it knows the number at all — so the same tick would end up listing the machine twice.
 */
export function bornAt(pid: number | undefined): string | null {
  if (!pid || !WINDOWS || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const printed = execFileSync(
      "powershell",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ONE_PROCESS_QUERY],
      {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "ignore"],
        // The number goes in as a value, never into the text of the query: what runs is the constant above, and what
        // it reads is cast to an integer by the query itself.
        env: { ...process.env, AGENT_AUTOLOOP_PID: String(pid) },
      },
    );
    const born = printed.trim();
    if (!/^\d+$/.test(born)) return null;
    // What this tick had already asked for knows nothing about a number that did not exist when it was asked: the one
    // thing just learnt is put into it, so the picture stays usable instead of having to be taken again.
    if (kept?.table) {
      kept.table.live.add(pid);
      kept.table.born.set(pid, born);
    }
    return born;
  } catch {
    return null;
  }
}

/**
 * Numbers already shown to be held by the process their record was written for. A number cannot be given to anything
 * else while the process holding it is alive, so this is asked once per number and not every tick: what it saves is a
 * second of the hub's own time, every tick, for as long as a run goes on.
 */
const confirmed = new Map<number, string>();
/**
 * How many are remembered. A number is kept for as long as the worker runs, and a hub that stays up for months launches
 * more runs than there are numbers worth holding on to: past this the lot is dropped and asked again as it is needed.
 */
const REMEMBER = 512;

/**
 * Whether the number in a launch record is held by the process that record was written for. Windows gives a number
 * back once its process is gone, and `tasklist` would then say yes about whatever took it — so what the record says
 * about the moment of creation is compared with what the machine says now. Where that cannot be compared (an older
 * record, a table that would not be read) the answer stays yes: this is only ever asked about a number that is a live
 * process of this program's own runtime, and calling such a run gone would throw away work that is going on.
 */
function sameAsRecorded(pid: number, record: string | undefined) {
  if (!record) return true;
  // What was shown is remembered against the moment it was shown for, not against the number alone: the same number
  // comes round again, and a yes about the process that held it then is no answer about whatever holds it now.
  if (confirmed.get(pid) === record) return true;
  // What was kept may have been taken before this process existed, and this is only ever asked about a number that is
  // a live process this moment: a picture without it in it was taken too early, and the one thing it would answer —
  // "nothing by that number" — is the one answer that must not be given here. So such a picture is thrown away once.
  const early = kept && Date.now() - kept.at < FRESH ? kept : null;
  let born = processTable()?.born.get(pid);
  if (born === undefined && early) {
    forgetProcesses();
    born = processTable()?.born.get(pid);
  }
  if (born === undefined) return true;
  if (born !== record) return false;
  if (confirmed.size >= REMEMBER) confirmed.clear();
  confirmed.set(pid, record);
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

/** The moment a process came into being, as something to compare with: a tick count is too big for a plain number. */
function ticks(value: string | undefined | null): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return BigInt(value);
}

/**
 * What is left of a run's tree on Windows: `true` while the run's own process is there and is still the one that was
 * launched, otherwise the live processes under its number that can be this run's, and `null` where we could not look.
 * `record` is the file the launch was written down in, the same one `alive` reads.
 *
 * Both of the questions Windows has about a stopped run are this one. Whether anything is still going (`treeAlive`) is
 * whether this comes back empty; what a forced stop has left to kill (`terminate`) is the numbers themselves, which is
 * the only way to reach them once the root is gone — `taskkill /T` walks down from a number, and that number is now
 * either nobody's or somebody else's.
 */
function orphans(pid: number, record?: string, sampling = false): true | number[] | null {
  const written = launchRecord(record);
  // A record that names another number is not about this run at all, so it says nothing about what to accept below.
  const about = !written || written.pid === undefined || written.pid === pid;
  const recorded = about ? written?.born : undefined;
  const seedsFromRecord = about ? knownTree(written) : [];
  const self = running(pid);
  if (self === null) return null;
  // Asking about one number costs a tenth of what the whole table costs, and while the run's own process is there —
  // and is still the one that was launched — the answer is already yes. Only once it has gone, or once the number
  // has become somebody else's, does anything under it have to be looked for.
  const mine = self === true ? sameAsRecorded(pid, recorded) : true;
  // The run's own process is there and is still the one that was launched, so there is nothing to answer by walking:
  // whatever the walk reached, the answer is `true`. A sampling walk goes on anyway (`sampleTree` below), because what
  // it is for is what the walk writes down and not what it answers.
  const whole = self === true && mine;
  if (whole && !sampling) return true;
  const table = processTable();
  // Without the whole table the tree is only partly known, and a part of it is not an answer about all of it. A
  // sampling walk has an answer already and only loses what it came for.
  if (!table) return whole ? true : null;
  // Windows keeps the number of the parent a process was started by for ever — after that parent is gone, and after
  // its number has been given to something else. So the parent numbers alone say that anything whose long-dead
  // parent happened to hold this number is still in this run's tree, and a stopped run then never ends. What settles
  // it is the moment each came into being: nothing started by this run can be older than the run itself.
  //
  // The walk goes all the way down, not one level. A child that is there is not the whole of what there is to find:
  // the run's own launcher can be gone with a child of its own gone too and that child's children still running, and
  // one level finds nothing then — the run is `cancelled` with its work still going. Walking down names every live
  // descendant the picture reaches, so the forced stop has each number of its own to kill rather than trusting
  // `taskkill /T` to walk a tree that may lose a branch between being looked at and being killed.
  //
  // A level that is itself already gone by the time the table is read cannot be walked through: what hung off it
  // carries that number as its parent for ever, and the number is now either nobody's or somebody else's. Nothing the
  // machine can be asked now says it was ever this run's — so what this walk reaches is written down as it goes
  // (`tree` in the launch record, below), and those numbers are walked under again next time. A level seen once stays
  // a way in after it goes, and what hangs off it is still this run's to find and to kill.
  //
  // What that leaves is one window: a level that was never seen at all — gone before the first table this run's tree
  // was walked under was read. A run whose own process is still there used to be the whole of that window, since
  // nothing walked a tree whose root was alive and was still the one that was launched: a root and the level under it
  // going between two ticks meant the level under that was never claimed, and a run told to stop reported `cancelled`
  // with its work still going. That is what `sampleTree` closes — a run that is going has its tree walked now and
  // then, so every level that lasted a sampling period was seen once and is a way in afterwards. What is left is a
  // level that came and went inside one such period together with its parent. What hung off it is not claimed:
  // nothing on the machine, and nothing written down, says it was ever this run's, and a stranger's tree force-killed
  // every tick would be the worse of the two mistakes. docs/protocol.md says so too.
  const since = ticks(recorded);
  // The number is a live process and is no longer this run's: whatever holds it now came into being after the run
  // did, so nothing this run left behind can be as young as that. Its moment is the upper bound, and without a
  // bound at both ends the new holder's own children are indistinguishable from this run's leftovers — which is
  // how a stopped run would never be `cancelled` and an unrelated tree would be force-killed on every tick.
  const until = mine ? null : ticks(table.born.get(pid));
  if (!mine && (since === null || until === null)) return [];
  const found: number[] = [];
  const seen = new Set<number>();
  // The queue grows while it is walked: a number pushed on it is one to look under in turn, and `seen` is what keeps a
  // number out of it twice — Windows can hand a parent number back to one of that parent's own descendants.
  //
  // `until` travels with each number rather than being one bound for the whole walk: it is the moment whoever holds
  // that number now came into being, and only where the number is somebody else's by now is there one at all. A child
  // of such a number born after that moment is the new holder's own. One level down there is no bound — the parent is
  // by then known to be this run's, and what it started may well be younger than whoever picked a number up.
  const queue: { pid: number; until: bigint | null }[] = [];
  const look = (number: number, bound: bigint | null) => {
    if (seen.has(number)) return;
    seen.add(number);
    queue.push({ pid: number, until: bound });
  };
  look(pid, until);
  // Every level this run's tree was walked under before, each with the moment it came into being. Still held by that
  // same process, it is a live descendant and so one of the numbers to kill; gone, it is only a way in to what hung
  // off it; held by something else by now, that something's own children are bounded out as above.
  for (const [number, was] of seedsFromRecord) {
    if (number === pid || seen.has(number)) continue;
    const now = table.born.get(number);
    if (table.live.has(number) && now !== undefined && now !== was) {
      // The number has become somebody else's. Without a moment to bound them by, its children cannot be told from
      // this run's leftovers at all, so none of them is claimed.
      const taken = ticks(now);
      if (taken !== null) look(number, taken);
      continue;
    }
    if (table.live.has(number) && now === was) found.push(number);
    look(number, null);
  }
  for (let at = 0; at < queue.length; at++) {
    const { pid: parent, until: bound } = queue[at]!;
    for (const child of table.children.get(parent) ?? []) {
      if (seen.has(child)) continue;
      const born = ticks(table.born.get(child));
      // Where the moment cannot be compared the child counts: only a few of the system's own processes have none to
      // give, and a record without one is from a launch that this version did not write the moment down for.
      if (since !== null && born !== null && born < since) {
        seen.add(child);
        continue;
      }
      // Under a number somebody else holds, a child whose moment cannot be read says nothing either way.
      if (bound !== null && (born === null || born >= bound)) {
        seen.add(child);
        continue;
      }
      look(child, null);
      found.push(child);
    }
  }
  // Written down before anything is done about them: the next walk gets in this way again even once this level is gone.
  if (record !== undefined && about) remember(record, written, found, table);
  return whole ? true : found;
}

/** The levels a record says were walked under before: `<进程号>` against the moment it came into being, as numbers. */
function knownTree(written: Launch | null): [number, string][] {
  const tree = written?.tree;
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) return [];
  const seeds: [number, string][] = [];
  for (const [key, born] of Object.entries(tree)) {
    const number = Number(key);
    if (Number.isInteger(number) && number > 0 && typeof born === "string" && /^\d+$/.test(born))
      seeds.push([number, born]);
  }
  return seeds;
}

/**
 * Puts what the walk reached into the launch record, so that a level gone by the next walk is still a way in to what
 * hangs off it. Only what the machine says a moment for is written: a number without one cannot be told from the next
 * holder of that number, and a way in that may lead into a stranger's tree is worse than none.
 *
 * Never throws and never fails a run: this is how well a stopped run can be reached, not whether it stops.
 */
function remember(record: string, written: Launch | null, found: number[], table: Table) {
  const tree: Record<string, string> = { ...(written?.tree ?? {}) };
  let added = false;
  for (const child of found) {
    const born = table.born.get(child);
    if (!born || tree[String(child)] === born) continue;
    if (Object.keys(tree).length >= REMEMBER_TREE && tree[String(child)] === undefined) continue;
    tree[String(child)] = born;
    added = true;
  }
  if (!added) return;
  try {
    writeFileSync(record, `${JSON.stringify({ ...(written ?? {}), tree })}\n`, { mode: 0o600 });
  } catch {}
}

/**
 * What the walk above found, for a test to read: which numbers a stopped run has left is the behaviour — `treeAlive`
 * only says whether there are any and `terminate` only kills them — so something has to be able to say which.
 */
export const leftBehind = (pid: number, record?: string): true | number[] | null => orphans(pid, record);

/**
 * How often a run that is still going has its tree walked. The whole process table is the best part of a second of
 * this process's own time, and the worker shares it with the hub, so this is that second once every thirty with a run
 * in hand — against the window above, which without it is every level of every run that ends together with its
 * parent. A test cannot wait thirty seconds, so the period can be said in the environment.
 */
const SAMPLE_EVERY = 30_000;
function sampleEvery() {
  const given = Number(process.env.AGENT_AUTOLOOP_TREE_SAMPLE);
  return Number.isInteger(given) && given >= 0 ? given : SAMPLE_EVERY;
}

/** When each run's tree was last walked while it was going, by the file its launch was written down in. */
const sampled = new Map<string, number>();
function dueToSample(record: string) {
  const last = sampled.get(record);
  const moment = Date.now();
  if (last !== undefined && moment - last < sampleEvery()) return false;
  if (sampled.size >= REMEMBER) sampled.clear();
  sampled.set(record, moment);
  return true;
}

/**
 * Walks the tree of a run that is going, now and then, for what the walk writes down: a level seen once stays a way
 * in to what hangs off it after it is gone (`orphans`, `remember`), and a level nobody ever saw takes what hangs off
 * it with it — a run told to stop then reports `cancelled` with its work still going.
 *
 * Windows only. A POSIX run is a process group, which reaches every level of itself whatever has died in between, and
 * nothing here would tell it anything it does not already know.
 *
 * Nothing is answered: whether the run is going is `alive`'s question and is asked every tick. This is the tick in
 * thirty seconds that pays for the picture, and on every other one it returns without asking the machine anything.
 */
export function sampleTree(pid: number | undefined, record?: string) {
  if (!WINDOWS || !pid || record === undefined) return;
  if (!dueToSample(record)) return;
  orphans(pid, record, true);
  // Timed from when the walk was done rather than from when it was asked for, as the kept table is (processTable):
  // the walk is the best part of a second of its own, and a clock started before it would make a period shorter than
  // the walk no period at all.
  sampled.set(record, Date.now());
}

/**
 * Whether anything in the run's group is still going, null when we could not look. `record` is the file the launch was
 * written down in, the same one `alive` reads: on Windows it is what tells this run's tree from a stale mention of its
 * number, and without it the walk below can only be as sure as a parent number alone makes it.
 */
export function treeAlive(pid: number | undefined, record?: string): boolean | null {
  // The wrapper can die before a child; zombies have already stopped and only their parent can reap them.
  if (!pid) return false;
  if (WINDOWS) {
    const left = orphans(pid, record);
    return left === null ? null : left === true ? true : left.length > 0;
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

/**
 * Asks the run and everything under it to stop. `hard` leaves it no say; on Windows nothing else reliably does.
 *
 * `record` is the file the launch was written down in, the same one `alive` reads. Windows gives a number back once
 * its process is gone, and `taskkill /T /F` on a number that has become somebody else's takes down a tree that was
 * never this run's. So before the forced kill the number is asked about once more: shown to be another process's, it
 * is left alone. A record that cannot be read, or one from a version that wrote no moment down, kills as it always
 * did — and the polite stop is not worth a question, since nothing it reaches is left without a say.
 *
 * The number being nobody's is not the run being over, though: the launcher can die with a grandchild of its own still
 * running, and walking down from that number would reach either nothing or a stranger. What is left is then killed one
 * number at a time — the same numbers `treeAlive` counts as this run's, so a run that is still going is one this stop
 * can still reach, and `cancelled` is not a thing the worker waits for for ever.
 */
export function terminate(pid: number | undefined, hard: boolean, record?: string) {
  if (!pid) return;
  if (WINDOWS && hard && record !== undefined && alive(pid, "", record) === false) {
    const left = orphans(pid, record);
    if (left !== null && left !== true) for (const child of left) kill(child, true);
    return;
  }
  kill(pid, hard);
}

/** The platform's own way of stopping a number and everything under it. Never throws into the worker's loop. */
function kill(pid: number, hard: boolean) {
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
