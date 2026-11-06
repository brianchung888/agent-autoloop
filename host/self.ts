// How to start this program again, as a command line. One spelling, in one place, because four things need it to be
// the same one: what keeps it running (host/service.ts), what the worker wraps a turn in (worker/worker.ts), a plugin
// that runs a job of its own in a child process (plugins/delivery, plugins/acp), and what `init` tells a person to type
// (cli/main.ts: howToRun).
//
// Source mode is what it has always been: this runtime, the warning turned off, and the entry script's path. A packaged
// build is one executable and nothing beside it — the executable is the whole command line, and nothing may name a
// `.ts` file, because in such a build there are no `.ts` files to name. Everything a `.ts` file used to be named for is
// a subcommand of this program instead (`internal:launch`, `internal:plugin`), which is a thing one executable can do.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { packaged } from "./assets.ts";
import { stablePath } from "./node-path.ts";

/** The entry script, where there is one. Shared so that no second spelling of this path can drift from the first. */
export const PROGRAM = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");

/**
 * Whether this is running from the source tree.
 *
 * The build is asked first, and it is the build that decides: `node:sea` says outright whether this is a packaged
 * build, and nothing about what happens to be lying next to the executable may override that. The PoC measured what
 * the other order costs (phase3-poc-report.md 三.1 步骤 5): in a packaged build `import.meta.dirname` becomes the
 * executable's own folder, so a binary copied into a source tree found `bin/agent-autoloop.ts` and took itself for a
 * source install — after which it tried to run `.ts` files that it has no way to run, and said none of the things it
 * is meant to say about that.
 *
 * Then the file system, and only then: a source tree with no entry script in it has nothing to name either, and this is
 * asked each time because a test may put a tree somewhere else.
 */
export const fromSource = () => packaged() === null && existsSync(PROGRAM);

/**
 * This program, as the first words of a command line. What follows is a subcommand like any other — which is what lets
 * a plugin start a job of its own without naming a file: `[...selfExecutable(), "internal:plugin", "<名字>", …]`.
 */
export function selfExecutable(): string[] {
  const executable = stablePath(process.execPath);
  return fromSource() ? [executable, "--disable-warning=ExperimentalWarning", PROGRAM] : [executable];
}

/**
 * What this install is known by wherever one word is wanted rather than a command line: a registered task's own record
 * of whose it is (host/service-win.ts: installMark), the service file an `uninstall` has to tell from somebody else's,
 * the shim on PATH. The entry script in source mode, the executable itself in a packaged build — the one thing that is
 * this install and not another.
 */
export const selfProgram = () => (fromSource() ? PROGRAM : stablePath(process.execPath));
