// Failure modes: internal Windows process probes/termination or an ACP agent allocate a visible console;
// hiding those children breaks process identity, termination, ACP replies or restored sessions.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bridge } from "../plugins/acp/bridge.ts";
import { bornAt, forgetProcesses, running, terminate, treeAlive } from "../worker/process.ts";
import { acpAgent } from "./helpers.ts";

test(
  "Windows internal probes and termination keep their consoles hidden while doing real work",
  {
    skip: process.platform !== "win32",
    timeout: 60_000,
  },
  async (t) => {
    const seen: { file: string; options: any }[] = [];
    const original = childProcess.execFileSync;
    const spy = t.mock.method(childProcess, "execFileSync", (file: string, args: readonly string[], options: any) => {
      seen.push({ file, options });
      return original(file, args, options);
    });
    syncBuiltinESMExports();
    t.after(() => {
      spy.mock.restore();
      syncBuiltinESMExports();
    });
    const child = childProcess.spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    t.after(() => child.kill());
    await once(child, "spawn");
    assert.equal(running(child.pid!), true);
    assert.match(String(bornAt(child.pid)), /^\d+$/);
    forgetProcesses();
    assert.equal(treeAlive(0x7ffffff0), false);
    const exited = once(child, "exit");
    terminate(child.pid, true);
    await exited;
    assert.equal(running(child.pid!), false);
    for (const tool of ["tasklist", "powershell", "taskkill"]) {
      const calls = seen.filter(({ file }) => file.toLowerCase().includes(tool));
      assert.ok(calls.length, `${tool} really ran`);
      assert.ok(
        calls.every(({ options }) => options.windowsHide === true),
        `${tool} must not create a console`,
      );
    }
  },
);

test("hidden ACP children still return replies from new and restored sessions", { timeout: 20_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-hidden-acp-"));
  // The bridge asks its agent to stop but does not wait for it, and a Windows folder a live process has as its
  // working directory cannot be removed at all. So the children are waited for first, then the folder goes.
  t.after(async () => {
    await Promise.all(started);
    rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const fake = acpAgent(home, "hidden");
  const seen: any[] = [];
  const started: Promise<unknown>[] = [];
  const original = childProcess.spawn;
  const spy = t.mock.method(childProcess, "spawn", (program: string, args: readonly string[], options: any) => {
    seen.push(options);
    const child = original(program, args, options);
    // Listened for now, while the child is being made: an exit that happens before the hook below is awaited is
    // one the hook would otherwise wait for for ever.
    started.push(once(child, "exit"));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    spy.mock.restore();
    syncBuiltinESMExports();
  });
  const receipts: any[] = [];
  t.mock.method(console, "log", (line: string) => receipts.push(JSON.parse(line)));
  for (const resume of [null, "agent-session"]) {
    await bridge({
      command: [process.execPath, fake],
      cwd: home,
      prompt: "fake only",
      access: "read",
      resume,
    } as never);
    const answer = receipts.at(-1);
    assert.equal(answer.finished, true);
    assert.equal(answer.session, "agent-session");
    assert.ok(answer.text);
  }
  assert.equal(seen.length, 2);
  assert.ok(
    seen.every((options) => options.windowsHide === true),
    "ACP subprocesses must not create consoles",
  );
});
