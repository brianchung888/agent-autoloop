// What stands in for the shell where there isn't one to stand in. The worker starts this, detached, with the three files a
// turn leaves behind and the agent's command line; it points the agent's output at those files, waits for it, and
// publishes the exit code under a name that only ever appears whole. It does nothing else: no shell, no quoting, no PATH
// of its own — the command line arrives already split, so nothing in it is ever read as syntax.
//
// Used only where the worker has no `/bin/sh` to do this. Everywhere else the shell still does it, exactly as before.
//
//   node launcher.ts <stdout 文件> <stderr 文件> <exit 文件> -- <程序> [参数…]
import { spawn } from "node:child_process";
import { closeSync, openSync, renameSync, writeFileSync } from "node:fs";

const [out, err, exitFile, dashes, ...argv] = process.argv.slice(2);
if (!out || !err || !exitFile || dashes !== "--" || !argv.length) {
  process.stderr.write("用法：launcher.ts <stdout 文件> <stderr 文件> <exit 文件> -- <命令行>\n");
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

const [program, ...args] = argv;
const child = spawn(program!, args, { stdio: ["ignore", stdout, stderr], windowsHide: true });
let published = false;
const once = (code: number) => {
  if (published) return;
  published = true;
  closeSync(stdout);
  closeSync(stderr);
  publish(code);
  process.exit(0);
};
child.on("error", (error) => {
  try {
    writeFileSync(err, `启动不了：${error}\n`, { flag: "a" });
  } catch {}
  once(127);
});
// A process ended by a signal has no code of its own; a shell would report 128 plus the signal's number.
child.on("exit", (code, signal) => once(code ?? (signal ? 143 : 1)));
