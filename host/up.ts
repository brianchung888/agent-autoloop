// Everything this machine does, in one process: the hub, the worker and its channels, whichever config.json says. They
// speak the same protocol to each other here as they would across the world. A stop leaves agents running: they're
// detached, and the worker finds them again when it's back.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync, watch } from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { loadChannel } from "./channels.ts";
import { parseListen, readConfig, type ChannelConfig } from "./config.ts";
import { HOME } from "./home.ts";
import { t } from "./i18n.ts";
import { secureDir } from "./permissions.ts";
import { fromSource, selfProgram } from "./self.ts";
import { tidyReplaced } from "./self-replace.ts";
import { claimUp, runningUp, stopFile } from "./service.ts";
import { commitOf } from "./version.ts";
import { hubClient } from "../protocol/client.ts";
import { createWorker } from "../worker/worker.ts";

/**
 * Where what it says goes. launchd points this at a file and systemd at its journal; a scheduled task points it nowhere,
 * so on Windows it is written down here instead — the same lines, in the same file launchd would have used.
 */
const LOG_FILE = process.platform === "win32" ? path.join(HOME, "logs", "up.log") : null;
/** Where it stops growing. launchd and systemd roll their own; what writes this file has to keep it to a size. */
const LOG_LIMIT = 8 * 1024 * 1024;
/** How often it is worth asking how big it is: a hub that never stops would fill a disk one line at a time. */
const LOOK_EVERY = 200;

/**
 * One generation back and no more: a hub that has been up for months has nothing to say about last month, and what is
 * being guarded against is a file nobody ever clears. A rename takes the place of whatever is already there.
 */
export function rollLog(file: string, limit = LOG_LIMIT) {
  try {
    if (statSync(file).size <= limit) return false;
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

let lines = 0;
/** One line into the file, where there is one to write to. Never throws: a log that cannot be written is not the job. */
function write(said: string) {
  if (!LOG_FILE) return;
  try {
    appendFileSync(LOG_FILE, `${said}\n`);
    if (++lines % LOOK_EVERY === 0) rollLog(LOG_FILE);
  } catch {}
}

const log = (who: string) => (line: string) => {
  const said = `${new Date().toISOString()} [${who}] ${line}`;
  console.log(said);
  write(said);
};

/**
 * What the hub says with `console.error`, into the same file. A scheduled task points stderr nowhere, so the one
 * sentence that says why a webhook was refused — which names the plugin's entry and the folder its plugin.json would
 * go in — went nowhere at all, while the 404 it answered with told whoever sent it to go and read the hub's log
 * (phase3-verification-round3.md F). A tick that could not run is the same story.
 *
 * Wired here, once, rather than a sink handed down to every place that has something to say: `console.error` is what
 * those places already write to, and the hub, the worker and the channels are this one process. The real stderr still
 * gets it — under launchd and systemd that is where it is read, and this file is only written on Windows.
 */
function alsoWrite(errors: Console) {
  const was = errors.error.bind(errors);
  errors.error = (...said: unknown[]) => {
    was(...said);
    write(`${new Date().toISOString()} [stderr] ${format(...said)}`);
  };
}

/** Only one of these per install: a second would take work beside the first. */
function lock() {
  const running = runningUp();
  // Not being able to look is not the same as nothing being there. Two hubs on one SQLite file is worse than a hub
  // that comes back five minutes later, and the task's repeating trigger is what brings it back.
  if (running === "unknown") {
    throw new Error(t("up.lockUnclear", { file: path.join(HOME, "up.pid") }));
  }
  // Its own number is what was left behind: pid 1 every time in a container, and a matter of luck after a restart.
  if (running !== null && running !== process.pid) throw new Error(t("up.alreadyRunning", { pid: running }));
  // What anyone left behind is replaced here, which is what keeps a number nobody holds any more from standing for one.
  return claimUp();
}

/**
 * The other way to be asked to stop: a file, which reaches this program wherever it runs. A signal does not — Windows
 * delivers none, and what is sent there instead ends the process where it stands, with nothing closed and up.pid left
 * behind. Whatever was left from before is taken away first: that was somebody else's asking, already answered.
 */
function watchStop(finish: () => void) {
  const file = stopFile();
  rmSync(file, { force: true });
  const asked = () => {
    if (existsSync(file)) finish();
  };
  try {
    const watcher = watch(HOME, (_, name) => {
      if (name === path.basename(file)) asked();
    });
    watcher.on("error", () => watcher.close());
    watcher.unref();
  } catch {}
  // Watching a folder is not promised everywhere (a network drive, a container's mount), so it is also looked for.
  setInterval(asked, 1000).unref();
}

/** secrets.env: what an adapter needs to check a webhook, kept out of rules.json. */
function loadSecrets() {
  const file = path.join(HOME, "secrets.env");
  if (existsSync(file)) process.loadEnvFile(file);
}

/** What runs beside the hub is started again however it stops, after a pause: one that returned at once would hog it. */
async function keepRunning(say: (line: string) => void, run: () => Promise<unknown>, signal: AbortSignal) {
  while (!signal.aborted) {
    try {
      await run();
      if (signal.aborted) return;
      say("stopped; starting again in 30 seconds");
    } catch (error) {
      say(`stopped: ${error}; starting again in 30 seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

function keepChannelRunning(id: string, { use, key, ...options }: ChannelConfig, url: string, signal: AbortSignal) {
  const say = log(id);
  return keepRunning(
    say,
    async () => {
      const start = await loadChannel(use ?? id);
      await start({ hub: hubClient(url, key), options, log: say, signal });
    },
    signal,
  );
}

export async function up() {
  const config = readConfig();
  // The executable an update moved aside (cli/self-update.ts). Here because this is the start it was waiting for: by
  // now nothing is running it, and Windows lets it be deleted. Source mode has no executable of its own to have moved.
  if (!fromSource()) tidyReplaced(selfProgram());
  secureDir(HOME);
  if (LOG_FILE) {
    secureDir(path.dirname(LOG_FILE));
    alsoWrite(console);
  }
  const unlock = lock();
  // Plugins run in this process, and an `error` event or a promise nobody handled is theirs to answer for, not the hub's.
  // Everything that matters is in transactions, so the rest can carry on.
  const stray = log("up");
  process.on("uncaughtException", (error) => stray(`stray error: ${error?.stack ?? error}`));
  process.on("unhandledRejection", (error) => stray(`stray error: ${(error as Error)?.stack ?? error}`));
  // Except losing where the log goes: writing that down fails the same way, for ever. It stops, and a service brings it back.
  for (const output of [process.stdout, process.stderr]) output.on("error", () => process.exit(1));
  const stop = new AbortController();
  const jobs: Promise<unknown>[] = [];
  let close = () => {};
  if (config.hub) {
    loadSecrets();
    const { host, port } = parseListen(config.hub.listen);
    process.env.AGENT_AUTOLOOP_PUBLIC_URL = config.hub.publicUrl ?? `http://${config.hub.listen}`;
    const { serve } = await import("./http.ts");
    const say = log("hub");
    if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
      say(t("up.notLoopback", { host }));
    }
    const server = serve(port, host, { commit: commitOf() });
    server.on("listening", () => say(`listening on ${config.hub!.listen}`));
    server.on("error", (error) => {
      say(`can't listen: ${error}`);
      process.exit(1);
    });
    close = () => {
      server.close();
      server.closeAllConnections();
    };
  }
  if (config.worker) {
    const { key, name, capacity, unreachable } = config.worker;
    const say = log("worker");
    const worker = createWorker({ hub: hubClient(config.url, key), name, capacity, unreachable, log: say });
    jobs.push(keepRunning(say, () => worker.run(stop.signal), stop.signal));
  }
  for (const [id, channel] of Object.entries(config.channels ?? {})) {
    jobs.push(keepChannelRunning(id, channel, config.url, stop.signal));
  }
  const finish = () => {
    stop.abort();
    close();
    unlock();
    process.exit(0);
  };
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
  watchStop(finish);
  await Promise.all(jobs);
}
