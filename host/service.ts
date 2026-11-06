// Keeping it running: launchd on a Mac, systemd on Linux, a scheduled task on Windows. All three start it without an
// administrator and bring it back when it stops; only how long that takes differs, and host/service-win.ts says why.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "./home.ts";
import { secureDir } from "./permissions.ts";
import { stablePath } from "./node-path.ts";
import { alive, bornAt, running } from "../worker/process.ts";
import { installTask, removeTask, taskAtLogon, taskEnabled } from "./service-win.ts";

/** Asked each time, not once: a test may be standing in for another platform by the time it is. */
const windows = () => process.platform === "win32";

// The one spelling of this path, so that a service, a wrapper and a plugin cannot drift apart (host/self.ts).
import { fromSource, PROGRAM, selfExecutable, selfProgram } from "./self.ts";
/** Another install on this machine (another AGENT_AUTOLOOP_HOME) has a service of its own. */
const label = () =>
  HOME === path.join(homedir(), ".agent-autoloop")
    ? "agent-autoloop"
    : `agent-autoloop-${createHash("sha256").update(HOME).digest("hex").slice(0, 8)}`;
const plistFile = () => path.join(homedir(), "Library/LaunchAgents", `${label()}.plist`);
const unitFile = () => path.join(homedir(), ".config/systemd/user", `${label()}.service`);
const xml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export type UnitOptions = {
  home: string;
  executable: string;
  /**
   * The entry script to run, or `""` where there is none to run: in a packaged build the executable is the whole
   * command line, and a service definition naming a `.ts` file would name a file that is not on the disk.
   */
  program: string;
};

/** What the service starts, as words: this runtime and the entry script, or just the executable. Then `up`. */
const started = (options: Pick<UnitOptions, "executable" | "program">) =>
  options.program
    ? [options.executable, "--disable-warning=ExperimentalWarning", options.program]
    : [options.executable];

const systemdItem = (text: string, escapeDollar = false) => {
  if (/[\u0000-\u001f\u007f]/u.test(text)) throw new Error("systemd unit 的值不能包含控制字符");
  let escaped = text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  if (escapeDollar) escaped = escaped.replaceAll("$", () => "$$");
  return `"${escaped}"`;
};

export function plist() {
  const logs = path.join(HOME, "logs");
  const systemPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const executable = stablePath(process.execPath);
  const searchPath = [path.dirname(executable), ...systemPaths].join(":");
  const program = [...selfExecutable(), "up"];
  const programArguments = program.map((part) => `<string>${xml(part)}</string>`).join("");
  const homeEntry = `<key>AGENT_AUTOLOOP_HOME</key><string>${xml(HOME)}</string>`;
  const pathEntry = `<key>PATH</key><string>${xml(searchPath)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label()}</string>
  <key>ProgramArguments</key><array>${programArguments}</array>
  <key>EnvironmentVariables</key><dict>${homeEntry}${pathEntry}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(logs)}/up.log</string>
  <key>StandardErrorPath</key><string>${xml(logs)}/up.log</string>
</dict></plist>
`;
}

export function unit(options: UnitOptions = { home: HOME, executable: process.execPath, program: entryScript() }) {
  const environment = systemdItem(`AGENT_AUTOLOOP_HOME=${options.home}`);
  const command = [...started(options), "up"].map((part) => systemdItem(part, true)).join(" ");
  return `[Unit]
Description=Agent 自动化中台

[Service]
Environment=${environment}
ExecStart=${command}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/** Only the launchd branch asks for this: getuid is a POSIX call, and on a platform without one it isn't there. */
const domain = () => `gui/${process.getuid?.() ?? -1}`;
const launchdHasIt = () =>
  spawnSync("launchctl", ["print", `${domain()}/${label()}`], { stdio: "ignore" }).status === 0;
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The entry script where this build has one, and nothing where the executable is the whole program (host/self.ts). */
const entryScript = () => (fromSource() ? PROGRAM : "");

/** What the service starts, whichever platform describes it: this node, this install's program, `up`. */
const taskOptions = () => ({
  label: label(),
  home: HOME,
  executable: stablePath(process.execPath),
  program: entryScript(),
});

export function installService() {
  secureDir(path.join(HOME, "logs"));
  if (windows()) return installTask(taskOptions());
  if (process.platform === "darwin") {
    mkdirSync(path.dirname(plistFile()), { recursive: true });
    writeFileSync(plistFile(), plist());
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    // bootout returns before the old one is gone; loading before that fails and leaves none.
    for (let tries = 0; tries < 100 && launchdHasIt(); tries++) pause(100);
    execFileSync("launchctl", ["bootstrap", domain(), plistFile()]);
  } else {
    mkdirSync(path.dirname(unitFile()), { recursive: true });
    writeFileSync(unitFile(), unit());
    execFileSync("systemctl", ["--user", "daemon-reload"]);
    execFileSync("systemctl", ["--user", "enable", "--now", label()]);
    execFileSync("systemctl", ["--user", "restart", label()]);
  }
}

export function removeService() {
  // The task is its own record, so what it was registered with is read back from it rather than from a file beside it.
  if (windows()) return removeTask(label(), HOME, selfProgram());
  const file = process.platform === "darwin" ? plistFile() : unitFile();
  if (!existsSync(file)) return;
  const service = readFileSync(file, "utf8");
  // What says the file is this install's and not somebody else's: the one word that is this install (host/self.ts).
  // In source mode that is the entry script, as it has always been; in a packaged build it is the executable itself.
  const mine = selfProgram();
  const ownsService =
    process.platform === "darwin"
      ? service.includes(xml(mine))
      : service.includes(systemdItem(mine, true)) || service.includes(mine);
  if (!ownsService) return;
  if (process.platform === "darwin") {
    spawnSync("launchctl", ["bootout", `${domain()}/${label()}`], { stdio: "ignore" });
    rmSync(plistFile(), { force: true });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", label()], { stdio: "ignore" });
    rmSync(unitFile(), { force: true });
  }
}

const pidFile = () => path.join(HOME, "up.pid");
/** Written beside up.pid by the `up` that left its number there, and taken away when it lets go. */
const tokenFile = () => path.join(HOME, "up.token");

/** What `ps` says the process at this number is running, where there is a `ps` to ask. */
function commandOf(pid: number) {
  if (windows()) return "";
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/**
 * Who holds the lock: the number of the `up` that holds it, `null` when nobody does, and `"unknown"` when it could not
 * be looked at. Three answers, because a lock may never be taken on a guess — in either direction.
 *
 * Two things have to hold. The number is a live process, and it was left by an `up` of this install, which is what the
 * token in up.pid and the one beside it say together: a number alone is worth little, being pid 1 every time in a
 * container and a matter of luck after a restart.
 *
 * Where a `ps` can say what the number is running, not being able to look still counts as nothing running: the command
 * line settles the question outright once it can be read, and a lock nobody can be shown to hold would stop `up` from
 * ever starting again. On Windows there is no command line to read back, and taking "could not look" for "nobody's" is
 * what lets `tasklist` failing for a moment put two hubs on one database — so there the answer is `"unknown"`, and `up`
 * would rather come back five minutes later (the task's trigger comes round again, and IgnoreNew drops the repeat).
 * What makes that affordable there is the third thing asked: the moment the number came into being, which says outright
 * whether the file was left by the process that still holds it, so "could not look" stays the rare answer it should be.
 */
export function runningUp(): number | null | "unknown" {
  const claim = readClaim();
  if (claim === null) return null;
  const token = readToken();
  if (windows()) {
    // Nothing can be read back off a Windows process to say what it is running, so cheaper things are asked instead.
    // The number has to be held by this program's own runtime — a stopped `up` whose number was taken over by
    // explorer.exe is the number of something else now, and treating it as a lock is how a hub never starts again. And
    // the number has to come with the token this install left beside it, written in the same breath.
    const image = alive(claim.pid, "");
    if (image === null) return "unknown";
    if (image === false) return null;
    if (claim.token === null || claim.token !== token) return null;
    // And the number has to have come into being when the claim says it did. `uninstall --yes` leaves both files
    // behind by itself (the forced stop never reaches the release), and everything above matches such a leftover as
    // soon as any node of this machine's is given that number: the lock then sticks for as long as that one runs.
    //
    // A claim that went down without that moment (the machine would not say, host/service.ts: claimUp logs it) cannot
    // be matched against anything, and the number alone is what `tasklist` says yes about for whatever took it. Not
    // knowing is not the same as the lock being free: taking it for free is how two hubs end up on one database.
    if (claim.born === null) return "unknown";
    const born = bornAt(claim.pid);
    if (born === null) return running(claim.pid) === false ? null : "unknown";
    return born === claim.born ? claim.pid : null;
  }
  if (running(claim.pid) !== true) return null;
  // Where there is a `ps` the command line is what settles it, and it is asked for whatever the file says. The token
  // matches the file this install left behind for ever, so a number given away after a SIGKILL matches it too; the one
  // thing that says the process holding that number now is an `up` at all is what it is running. Both, then — the
  // token for "this install's", the command line for "an `up`" — which is what this lock meant before a token existed.
  const looksLikeUp = () => /agent-autoloop(\.ts)? up\b/.test(commandOf(claim.pid));
  if (token === null) return looksLikeUp() ? claim.pid : null;
  return (claim.token === null || claim.token === token) && looksLikeUp() ? claim.pid : null;
}

/** What up.pid says, whichever version wrote it: the shape below, or a bare number from one that wrote only that. */
function readClaim(): { pid: number; token: string | null; born: string | null } | null {
  let written: string;
  try {
    written = readFileSync(pidFile(), "utf8").trim();
  } catch {
    return null;
  }
  let pid = Number(written);
  let token: string | null = null;
  let born: string | null = null;
  if (!Number.isInteger(pid)) {
    try {
      const claim = JSON.parse(written) as { pid?: unknown; token?: unknown; born?: unknown };
      pid = Number(claim.pid);
      token = typeof claim.token === "string" && claim.token ? claim.token : null;
      born = typeof claim.born === "string" && /^\d+$/.test(claim.born) ? claim.born : null;
    } catch {
      return null;
    }
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, token, born };
}

const readToken = () => {
  try {
    return readFileSync(tokenFile(), "utf8").trim() || null;
  } catch {
    return null;
  }
};

/**
 * This process takes the install's one place to run. Whatever anybody left here is replaced rather than read twice:
 * `up` has already been told the lock is free by the time it asks for it, and a file that outlived its process may not
 * stand for one. The number is still there to be read by a person, beside the token that says whose it is.
 */
export function claimUp() {
  const token = randomUUID();
  // `born` is what the machine says about the moment this number came into being, and only Windows has anything to
  // say: it is what tells this lock from a file left behind by an `up` whose number something else holds by now.
  const born = bornAt(process.pid);
  // Without it the lock cannot be told from a file left behind, and `up` would rather wait five minutes than start a
  // second hub: whoever reads the log should know which of the two they are about to get.
  if (born === null && windows())
    console.error("问不出本进程的创建时刻：up.pid 少了这一项，下一次 up 会说看不清这把锁，而不是把它当空的。");
  const claim = { pid: process.pid, token, born, startedAt: new Date().toISOString() };
  writeFileSync(tokenFile(), `${token}\n`, { mode: 0o600 });
  writeFileSync(pidFile(), `${JSON.stringify(claim)}\n`);
  return () => {
    for (const file of [tokenFile(), pidFile()]) {
      try {
        rmSync(file, { force: true });
      } catch {}
    }
  };
}

/**
 * Asking `up` to stop, in a way that reaches it on any platform. A file is the whole of it: Windows delivers no SIGTERM
 * to a program, so a `process.kill` there ends it outright and the hub never gets to close what it had open.
 *
 * `up` takes this file away itself as it starts, so one left behind cannot stop the next one.
 */
export const stopFile = () => path.join(HOME, "stop");

/** Stopping a service returns before its process is gone, and one started by hand has no service to stop it. */
export function stopUp() {
  const pid = runningUp();
  // Nothing to stop, or nothing that can be shown to be there: ending a number that cannot be shown to be this
  // install's `up` would be somebody else's process ended for them.
  if (typeof pid !== "number") return;
  try {
    writeFileSync(stopFile(), `${new Date().toISOString()}\n`);
  } catch {}
  // On POSIX the signal stays what does it, with the file beside it; there is nothing to send on Windows.
  if (!windows()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  // On Windows what is waited on is only whether that number is a process at all: a number cannot be given away while
  // the process holding it is alive, and asking the whole question fifty times over asks the machine fifty times.
  const gone = windows() ? () => running(pid) === false : () => runningUp() === null;
  for (let tries = 0; tries < 50 && !gone(); tries++) pause(100);
  // It was asked, and five seconds later it is still there. On Windows nothing but ending it outright does, and only
  // this process: the agents under it are detached on purpose, and the worker finds them again when it is back. The
  // whole question is asked once more first — ending a number that has become somebody else's is not stopping `up`.
  if (windows() && runningUp() === pid) {
    try {
      process.kill(pid);
    } catch {}
    for (let tries = 0; tries < 50 && !gone(); tries++) pause(100);
  }
  // Whether or not it read it, it is no longer being asked.
  rmSync(stopFile(), { force: true });
}

/** The service this program installs and can restart. */
export function serviceRunning() {
  if (windows()) return taskEnabled(label());
  if (process.platform === "darwin") return existsSync(plistFile()) && launchdHasIt();
  return spawnSync("systemctl", ["--user", "is-active", "--quiet", label()], { stdio: "ignore" }).status === 0;
}

/** The name of a system-level unit running this, as a server run by root might have. It's its owner's to restart. */
export function systemUnit() {
  // Windows has no second manager above this one: a task is a task, and there is nobody else's to leave alone.
  if (windows() || process.platform === "darwin") return null;
  return spawnSync("systemctl", ["is-active", "--quiet", label()], { stdio: "ignore" }).status === 0 ? label() : null;
}

/**
 * What this platform's way of keeping it running does not promise, in words a person can act on, or nothing when it
 * promises what launchd and systemd do. Only Windows has something to say: a scheduled task is a moment coming round
 * again, not a manager watching a process.
 */
export function serviceNote() {
  if (!windows()) return null;
  return taskAtLogon(label())
    ? "Windows 上靠计划任务常驻：停了之后最多等 5 分钟才会自己回来。"
    : "Windows 上靠计划任务常驻，而这台电脑不让登录时就启动（通常是加了域）：登录后和停了之后都最多等 5 分钟。";
}

/** New code counts once what's running starts again. What can't be restarted from here is said back, for the owner. */
export function restartService() {
  if (serviceRunning()) return void installService();
  const name = systemUnit();
  return name ? `这台电脑用的是系统级服务，运行 systemctl restart ${name} 才会用上新版。` : undefined;
}
