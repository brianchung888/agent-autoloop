// Keeping it running on Windows. There is no user-level service manager here that needs no administrator, so what keeps
// it going is a scheduled task of this person's own: started at logon, started again when it isn't there, and never
// twice at once. A task is made from XML, and that XML says the whole of it — so the task is written the way the plist
// and the systemd unit are: a file this program generates, and reads back from the registered task to tell its own from
// anybody else's.
//
// Nothing here builds a command line for a shell. A task carries no environment, so the home this install uses is handed
// to node in an env file instead of being set by one; the program and its arguments go into the XML as they are, and a
// Windows path can hold no quote, so quoting each path is unambiguous.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type TaskOptions = {
  label: string;
  home: string;
  executable: string;
  program: string;
  /** When the repeating trigger starts counting. Any moment already past starts it now. */
  startBoundary?: string;
  /** Also start it the moment this person logs on. Registering such a trigger is not everyone's to do. */
  atLogon?: boolean;
};

/** How often the trigger comes round again, and so the longest a stopped hub stays stopped. */
const EVERY = "PT5M";
/** Task Scheduler wants local time without a zone, which is what a trigger already means. */
const localTime = (at: Date) =>
  new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().replace(/\.\d+Z$/, "");

export const taskFile = (home: string) => path.join(home, "service.xml");
export const envFile = (home: string) => path.join(home, "service.env");

const xml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

/** A path is one argument whatever is in it. A quote cannot be in a Windows path, so quoting it needs no escaping. */
function argument(value: string) {
  const bad = (at: string) => at === '"' || at.codePointAt(0)! < 0x20 || at.codePointAt(0) === 0x7f;
  if ([...value].some(bad)) throw new Error("Windows 上的路径不能包含引号或控制字符");
  return `"${value}"`;
}

/** The home this install uses, for `node --env-file`: it is read as a value, never as something a shell would run. */
export function environment(home: string) {
  if (/[\r\n]/.test(home)) throw new Error("AGENT_AUTOLOOP_HOME 不能包含换行");
  return `AGENT_AUTOLOOP_HOME="${home}"\n`;
}

/**
 * The task as Task Scheduler reads it. `IgnoreNew` is what makes the trigger coming round again harmless: while one is
 * running the next is dropped, which is the same answer up.pid gives, one step earlier. `ExecutionTimeLimit` of PT0S is
 * no limit — this is meant to stay up.
 */
export function taskXml(options: TaskOptions) {
  const args = [`--env-file=${envFile(options.home)}`, "--disable-warning=ExperimentalWarning", options.program, "up"];
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Agent 自动化中台（${xml(options.label)}）</Description>
    <URI>\\${xml(options.label)}</URI>
  </RegistrationInfo>
  <Triggers>${options.atLogon ? "\n    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>" : ""}
    <TimeTrigger>
      <StartBoundary>${xml(options.startBoundary ?? localTime(new Date()))}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>${EVERY}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(options.executable)}</Command>
      <Arguments>${xml(args.map(argument).join(" "))}</Arguments>
      <WorkingDirectory>${xml(options.home)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks reads an XML file only as UTF-16 with a mark at its start. */
function writeTaskFile(file: string, contents: string) {
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(contents, "utf16le")]));
}

/**
 * Registers the task, and starts it: the trigger is a moment, and the next one is five minutes off.
 *
 * A trigger that waits for a logon belongs to whoever may answer for every logon, which on a machine joined to a domain
 * is not its user — there, registering one is refused outright. So it is asked for, and when it is refused the repeating
 * trigger alone is registered: that is what brings the hub back either way, and all that is lost is the first five
 * minutes after a logon.
 */
export function installTask(options: TaskOptions) {
  writeFileSync(envFile(options.home), environment(options.home), { mode: 0o600 });
  const file = taskFile(options.home);
  // /F replaces the one that is there, which is how an update takes effect. No /RU: without it the task belongs to
  // whoever registers it, and asking for a person on the command line makes schtasks ask for their password.
  const register = ["/Create", "/TN", options.label, "/XML", file, "/F"];
  writeTaskFile(file, taskXml({ ...options, atLogon: true }));
  if (spawnSync("schtasks", register, { stdio: "ignore", timeout: 60_000 }).status !== 0) {
    writeTaskFile(file, taskXml({ ...options, atLogon: false }));
    execFileSync("schtasks", register, { stdio: "ignore", timeout: 60_000 });
  }
  spawnSync("schtasks", ["/Run", "/TN", options.label], { stdio: "ignore", timeout: 60_000 });
}

/** Whether the registered task also starts at logon, or only waits for the repeat. For saying so in `doctor`. */
export function taskAtLogon(label: string) {
  return registeredXml(label)?.includes("<LogonTrigger>") === true;
}

/**
 * The XML of the registered task, or null when there is no such task.
 *
 * It arrives in whatever code page the console is in, and that is not something to guess at: on a Chinese Windows a
 * path or a description comes back as something else entirely. So the bytes are taken as they are — every ASCII byte
 * is itself in all of these code pages, which is all the tag names and all the words this file goes on to look for.
 * Anything with a character outside ASCII in it is read from the file this install wrote, never from here.
 */
export function registeredXml(label: string) {
  const asked = spawnSync("schtasks", ["/Query", "/TN", label, "/XML", "ONE"], {
    encoding: "latin1",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return asked.status === 0 && asked.stdout.includes("<Task") ? asked.stdout : null;
}

/**
 * Whether the task that is registered is the one this install wrote, rather than another install's by that name.
 *
 * What says so is the file the task was registered from, which is this install's own and in a known encoding — the
 * same way the launchd and systemd branches read the plist and the unit beside them. Reading the path back out of the
 * registered task cannot say it: through the console's code page an install under 我的文件 comes back mangled, nothing
 * matches, and `uninstall` then leaves a scheduled task behind for good. Where that file has gone the registered XML
 * is still asked, which is an answer for every install whose path is plain ASCII.
 */
export function taskOwned(label: string, home: string, program: string) {
  if (registeredXml(label) === null) return false;
  try {
    if (readFileSync(taskFile(home), "utf16le").includes(program)) return true;
  } catch {}
  return registeredXml(label)?.includes(program) === true;
}

export function removeTask(label: string, home: string, program: string) {
  if (!taskOwned(label, home, program)) return;
  spawnSync("schtasks", ["/End", "/TN", label], { stdio: "ignore", timeout: 60_000 });
  spawnSync("schtasks", ["/Delete", "/TN", label, "/F"], { stdio: "ignore", timeout: 60_000 });
  for (const file of [taskFile(home), envFile(home)]) rmSync(file, { force: true });
}

/** The task is there and turned on: Task Scheduler will bring the hub back, whether or not it is up this moment. */
export function taskEnabled(label: string) {
  const registered = registeredXml(label);
  if (registered === null) return false;
  // `Enabled` is said of the trigger as well, so only the one among the task's own settings is read.
  const settings = /<Settings>([\s\S]*?)<\/Settings>/.exec(registered)?.[1] ?? "";
  return !settings.includes("<Enabled>false</Enabled>");
}
