// Looking at a launched run and stopping it, on this machine, with real processes. Nothing here stands in for anything:
// the point of worker/process.ts is what the operating system actually answers, and a stand-in would answer for it.
//
// Failure cases: a process that is going is called gone, so a run is given up on while its agent works; a process that is
// gone is called going, so a turn waits for the timeout; something that could not be looked at is called gone, and the
// worker hands in `cancelled` with the tree still running (docs/protocol.md: 确认组内没有活进程后才交 cancelled); a tree
// outlives the stop it was asked for; a number that is nobody's is taken for somebody.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { alive, running, terminate, treeAlive } from "../worker/process.ts";

const WINDOWS = process.platform === "win32";
/** Long enough that nothing here finishes by itself; the test ends it. */
const SLEEP = "setTimeout(() => {}, 600000)";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits up to five seconds for something to become true, so nothing here depends on how fast this machine is. */
async function until(what: string, ready: () => boolean | null) {
  for (let tries = 0; tries < 250; tries++) {
    if (ready() === true) return;
    await pause(20);
  }
  assert.fail(what);
}

/** A process of its own group (POSIX) or its own tree root (Windows), with one child under it. */
function started(code: string) {
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

test("a live process is alive, and the number of a gone one is not", async (t) => {
  const child = started(SLEEP);
  t.after(() => terminate(child.pid, true));
  await until("it started", () => running(child.pid!));
  assert.equal(running(child.pid!), true);
  // `marker` is what POSIX reads out of the command line; on Windows the launcher's own image is what is matched.
  assert.equal(alive(child.pid, WINDOWS ? "" : "-e"), true);

  const gone = started("0");
  await new Promise((resolve) => gone.once("exit", resolve));
  // Windows keeps a number for a moment after the process that held it has gone.
  await until("the number stopped being a process", () => running(gone.pid!) === false || null);
  assert.equal(running(gone.pid!), false);
});

test("nothing is a process, and neither is nothing at all", () => {
  assert.equal(running(0), false);
  assert.equal(running(-1), false);
  assert.equal(running(1.5), false);
  assert.equal(alive(undefined, "x"), false);
  assert.equal(treeAlive(undefined), false);
});

test("a tree is alive while anything in it is, and the answer is never a guess", async (t) => {
  // The parent waits on a child of its own, so the tree outlives neither of them on its own.
  const child = started(
    `require("node:child_process").spawn(process.execPath,["-e","${SLEEP}"],{stdio:"ignore"});${SLEEP}`,
  );
  t.after(() => terminate(child.pid, true));
  await until("the tree started", () => treeAlive(child.pid));
  const seen = treeAlive(child.pid);
  assert.equal(seen, true, "a tree with two live processes in it");
});

test("asked to stop, a whole tree goes", async (t) => {
  const child = started(
    `require("node:child_process").spawn(process.execPath,["-e","${SLEEP}"],{stdio:"ignore"});${SLEEP}`,
  );
  t.after(() => terminate(child.pid, true));
  await until("the tree started", () => treeAlive(child.pid));
  // Windows posts a message a program without a window never reads, so only the forced kill ends such a tree.
  terminate(child.pid, WINDOWS);
  await until("the tree went", () => treeAlive(child.pid) === false || null);
  assert.equal(treeAlive(child.pid), false, "nothing in the group is left, which is what lets a run be `cancelled`");
});

test("stopping nothing is not an error", () => {
  assert.doesNotThrow(() => terminate(undefined, false));
  assert.doesNotThrow(() => terminate(undefined, true));
  // A number nobody holds: whatever the platform says, it must not throw into the worker's loop.
  assert.doesNotThrow(() => terminate(0x7ffffff0, true));
});
