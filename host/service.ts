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
import { alive, running } from "../worker/process.ts";
import { installTask, removeTask, taskAtLogon, taskEnabled } from "./service-win.ts";

/** Asked each time, not once: a test may be standing in for another platform by the time it is. */
const windows = () => process.platform === "win32";

const PROGRAM = path.join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
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
  program: string;
};

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
  const program = [executable, "--disable-warning=ExperimentalWarning", PROGRAM, "up"];
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

export function unit(options: UnitOptions = { home: HOME, executable: process.execPath, program: PROGRAM }) {
  const environment = systemdItem(`AGENT_AUTOLOOP_HOME=${options.home}`);
  const command = [options.executable, "--disable-warning=ExperimentalWarning", options.program, "up"]
    .map((part) => systemdItem(part, true))
    .join(" ");
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

/** What the service starts, whichever platform describes it: this node, this install's program, `up`. */
const taskOptions = () => ({
  label: label(),
  home: HOME,
  executable: stablePath(process.execPath),
  program: PROGRAM,
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
  if (windows()) return removeTask(label(), HOME, PROGRAM);
  const file = process.platform === "darwin" ? plistFile() : unitFile();
  if (!existsSync(file)) return;
  const service = readFileSync(file, "utf8");
  const ownsService =
    process.platform === "darwin"
      ? service.includes(xml(PROGRAM))
      : service.includes(systemdItem(PROGRAM, true)) || service.includes(PROGRAM);
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
 * The process that left its number in up.pid, if it still is that process: the number may be someone else's by now.
 *
 * Two things have to hold. The number is a live process — asked the same three ways a run is, and anything but a plain
 * yes counts as nothing running, because what this answers is a lock and a lock may never be taken on a guess. And the
 * number was left by an `up` of this install, which is what the token in up.pid and the one beside it say together: a
 * number alone is worth little, being pid 1 every time in a container and a matter of luck after a restart.
 *
 * Whichever of the two cannot be confirmed, the lock is free. That is the only safe way round: a lock nobody can be
 * shown to hold stops `up` from ever starting again, and `up` is what a scheduled task or a service brings back.
 *
 * What is left unanswered: a number recycled between an `up` being killed outright and this being asked, by something
 * that is also this program's runtime. The token is a file, not a hold on the process, so it cannot tell that apart —
 * `up` replacing both files as it starts is what keeps that window short.
 */
export function runningUp() {
  const claim = readClaim();
  if (claim === null) return null;
  if (running(claim.pid) !== true) return null;
  const token = readToken();
  if (windows()) {
    // Nothing can be read back off a Windows process to say what it is running, so two cheaper things are asked
    // instead. The number has to be held by this program's own runtime — a stopped `up` whose number was taken over by
    // explorer.exe is the number of something else now, and treating it as a lock is how a hub never starts again. And
    // the number has to come with the token this install left beside it, written in the same breath.
    if (alive(claim.pid, "") !== true) return null;
    return claim.token !== null && claim.token === token ? claim.pid : null;
  }
  // Where there is a `ps` the command line is read for a file left by a version that wrote no token at all.
  if (token === null) return /agent-autoloop(\.ts)? up\b/.test(commandOf(claim.pid)) ? claim.pid : null;
  return claim.token === null || claim.token === token ? claim.pid : null;
}

/** What up.pid says, whichever version wrote it: the shape below, or a bare number from one that wrote only that. */
function readClaim(): { pid: number; token: string | null } | null {
  let written: string;
  try {
    written = readFileSync(pidFile(), "utf8").trim();
  } catch {
    return null;
  }
  let pid = Number(written);
  let token: string | null = null;
  if (!Number.isInteger(pid)) {
    try {
      const claim = JSON.parse(written) as { pid?: unknown; token?: unknown };
      pid = Number(claim.pid);
      token = typeof claim.token === "string" && claim.token ? claim.token : null;
    } catch {
      return null;
    }
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, token };
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
  const claim = { pid: process.pid, token, startedAt: new Date().toISOString() };
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
  if (pid === null) return;
  try {
    writeFileSync(stopFile(), `${new Date().toISOString()}\n`);
  } catch {}
  // On POSIX the signal stays what does it, with the file beside it; there is nothing to send on Windows.
  if (!windows()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (let tries = 0; tries < 50 && runningUp() !== null; tries++) pause(100);
  // It was asked, and five seconds later it is still there. On Windows nothing but ending it outright does, and only
  // this process: the agents under it are detached on purpose, and the worker finds them again when it is back.
  if (windows() && runningUp() !== null) {
    try {
      process.kill(pid);
    } catch {}
    for (let tries = 0; tries < 50 && runningUp() !== null; tries++) pause(100);
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
