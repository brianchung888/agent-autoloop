// How to start this program again, as a command line. One spelling, in one place, because three things need it to be
// the same one: what keeps it running (host/service.ts), what the worker wraps a turn in (worker/worker.ts: LAUNCHER),
// and a plugin that runs a job of its own in a child process.
//
// Source mode is what it has always been: this runtime, the warning turned off, and the entry script's path. A build
// with no entry script on disk is a packaged one — the executable is the whole command line, and nothing may name a
// `.ts` file, because in such a build there are no `.ts` files to name.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stablePath } from "./node-path.ts";

/** The entry script, where there is one. Shared so that no second spelling of this path can drift from the first. */
export const PROGRAM = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");

/** Whether this is running from the source tree. Asked each time: a test may put the tree somewhere else. */
export const fromSource = () => existsSync(PROGRAM);

/**
 * This program, as the first words of a command line. What follows is a subcommand like any other — which is what lets
 * a plugin start a job of its own without naming a file: `[...selfExecutable(), "internal:plugin", "<名字>", …]`.
 */
export function selfExecutable(): string[] {
  const executable = stablePath(process.execPath);
  return fromSource() ? [executable, "--disable-warning=ExperimentalWarning", PROGRAM] : [executable];
}
