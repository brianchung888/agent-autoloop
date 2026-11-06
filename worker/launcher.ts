// What stands in for the shell where there isn't one to stand in. The worker starts this, detached, with the three files a
// turn leaves behind and the agent's command line; it points the agent's output at those files, waits for it, and
// publishes the exit code under a name that only ever appears whole. It does nothing else: no shell, no quoting, no PATH
// of its own — the command line arrives already split, so nothing in it is ever read as syntax.
//
// Used only where the worker has no `/bin/sh` to do this. Everywhere else the shell still does it, exactly as before.
//
// It is reached as a subcommand of this program, not as a file to run:
//
//   agent-autoloop internal:launch <stdout 文件> <stderr 文件> <exit 文件> -- <程序> [参数…]
//
// A packaged build is one executable with no `.ts` files in it to name, and this used to be named as one
// (worker/worker.ts: LAUNCHER). A subcommand is the same words in both modes — `host/self.ts: selfExecutable()` puts
// whatever has to come first in front of it. The file still runs directly as well, which is how
// tests/platform-launch.test.ts starts it: that is the same code either way.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";

/** Wraps one agent: `<stdout 文件> <stderr 文件> <exit 文件> -- <程序> [参数…]`. Ends this process, either way. */
export function launch(words: string[]): void {
  const [out, err, exitFile, dashes, ...argv] = words;
  if (!out || !err || !exitFile || dashes !== "--" || !argv.length) {
    process.stderr.write("用法：agent-autoloop internal:launch <stdout 文件> <stderr 文件> <exit 文件> -- <命令行>\n");
    process.exit(2);
  }

  /** The exit file appears whole or not at all: whoever reads it never sees half a number. */
  function publish(code: number) {
    try {
      writeFileSync(`${exitFile}.tmp`, `${code}\n`, { mode: 0o600 });
      renameSync(`${exitFile}.tmp`, exitFile);
    } catch {}
  }

  // What the shell's `umask 077` did for the files the agent writes. Windows has no umask and ignores this.
  process.umask?.(0o077);

  let stdout: number;
  let stderr: number;
  try {
    stdout = openSync(out, "a");
    stderr = openSync(err, "a");
  } catch (error) {
    try {
      writeFileSync(err, `启动不了：写不了输出文件（${error}）\n`, { flag: "a" });
    } catch {}
    // 127 is what a shell leaves when it couldn't run the command at all.
    publish(127);
    process.exit(0);
  }

  let published = false;
  const once = (code: number) => {
    if (published) return;
    published = true;
    closeSync(stdout);
    closeSync(stderr);
    publish(code);
    process.exit(0);
  };
  const whyNot = (error: unknown) => {
    try {
      writeFileSync(err, `启动不了：${error}\n`, { flag: "a" });
    } catch {}
    once(127);
  };

  const [program, ...args] = argv;
  let child: ChildProcess;
  try {
    child = spawn(program!, args, { stdio: ["ignore", stdout, stderr], windowsHide: true });
  } catch (error) {
    // Windows refuses a .cmd or .bat outright, and says so by throwing from spawn itself: no `error` event follows, so
    // this is the only place it can be answered. Without it the wrapper dies here, the exit file never appears, and the
    // worker waits out the whole timeout for a run that never started.
    whyNot(error);
    // whyNot has already left the process; saying so here is what makes `child` a process from this point on.
    process.exit(0);
  }
  child.on("error", whyNot);
  // A process ended by a signal has no code of its own; a shell would report 128 plus the signal's number.
  // Nothing after this: the handlers above are what end this process.
  child.on("exit", (code, signal) => once(code ?? (signal ? 143 : 1)));
}

if (import.meta.main) launch(process.argv.slice(2));
