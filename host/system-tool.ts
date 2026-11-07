// The Windows programs this one runs, named by their full path rather than by their bare name.
//
// Everything here is started with `execFileSync` / `spawnSync`, so no shell ever reads any of it — but a bare name is
// still looked for along `PATH`, and `PATH` is not this program's. A machine whose `PATH` has no `System32` in it is
// not a broken machine: a scheduled task is handed the environment host/service-win.ts wrote for it, a service manager
// hands over whatever it was configured with, and a person who trimmed their own `PATH` did nothing wrong. What used
// to happen then was not an error anybody saw. `bornAt` caught its own failure and answered `null`
// (worker/process.ts), and `null` is「看不清」rather than「不在」: the single-instance lock then held a claim nothing
// could ever be compared against, so Task Scheduler could not bring the hub back, and `update` and `uninstall` could
// not tell whether a hub was running (phase3-verification-round4.md 1). The same `PATH` takes `schtasks` away from
// installing the task at all, `icacls` away from locking the data folder, and `taskkill` away from stopping a run.
//
// Windows keeps all five where `SystemRoot` says, and that variable is set by the system itself on every Windows there
// is. So that is where they are looked for. Where one is not there — a stripped-down image, a `SystemRoot` pointing
// somewhere else — the bare name is what comes back, which is exactly what this program did before and leaves `PATH`
// the last thing tried rather than the first. Nothing here is cached: these are read immediately before starting a
// process that takes milliseconds at best, and a cache would make the answer depend on when it was first asked.
import { existsSync } from "node:fs";
import path from "node:path";

/** Where each lives under `System32`. PowerShell is the one that is not loose in the folder. */
const UNDER_SYSTEM32 = {
  powershell: path.join("WindowsPowerShell", "v1.0", "powershell.exe"),
  tasklist: "tasklist.exe",
  taskkill: "taskkill.exe",
  schtasks: "schtasks.exe",
  icacls: "icacls.exe",
} as const;

export type SystemTool = keyof typeof UNDER_SYSTEM32;

/**
 * `System32` of the Windows that is running, or null where this machine says nothing about where that is. `windir` is
 * read as well as `SystemRoot` because both are set and either one being the only one left is possible; neither being
 * set is answered with null rather than with a guess at `C:\Windows`, so that the bare name is tried instead.
 */
export function system32(): string | null {
  const root = process.env.SystemRoot?.trim() || process.env.windir?.trim();
  return root ? path.join(root, "System32") : null;
}

/**
 * What to hand `execFileSync` for one of these. On anything but Windows the name itself: none of the five is a Windows
 * program there, and the one caller that is not inside a `process.platform === "win32"` branch is asking about a
 * machine where `PATH` is the right answer.
 */
export function systemTool(name: SystemTool): string {
  if (process.platform !== "win32") return name;
  const folder = system32();
  if (!folder) return name;
  const full = path.join(folder, UNDER_SYSTEM32[name]);
  return existsSync(full) ? full : name;
}
