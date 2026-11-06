// Each test file runs in its own process with its own home and the fixture rules; modules are imported after this sets
// the environment they read.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after, test as runTest } from "node:test";

/**
 * The `test` of a file that cannot run on the named platforms at all, so that every case in it says it is skipped and why,
 * rather than failing for a reason that has nothing to do with what it is about.
 *
 * Most of this suite writes its stand-ins as `#!/bin/sh` scripts — a fake Agent, a fake `ps`, a fake `launchctl` — and
 * asks POSIX questions about what they did: a process group, a mode, a symlink's target. None of that can be made to
 * mean the same thing on Windows, and rewriting eighty-odd files to be platform-neutral would cost more than everything
 * else Windows support took. So what Windows adds has tests of its own, written for it (tests/platform-*.test.ts), and
 * the rest say here, in the skip itself, why they are not running. A skip nobody can read is how a suite quietly becomes
 * nothing: scripts/ci-scope.sh says what each platform's job runs, and the Windows job prints both numbers.
 */
export function skipOn(platforms: NodeJS.Platform[], why: string): typeof runTest {
  return skipUnless(!platforms.includes(process.platform), why);
}

/**
 * Whether a POSIX shell is on PATH. A few tests here are about shell scripts this project ships
 * (`scripts/ci-scope.sh`, `examples/*.sh`) and about the `curl` lines its READMEs tell people to run: those run
 * wherever `sh` does, which on Windows is Git Bash and not PowerShell. Asked by running it, once, rather than guessed
 * at from the platform — a skip that says "Windows" would hide the Git Bash job that does run them.
 */
let shell: boolean | undefined;
export function shellOnPath() {
  if (shell === undefined) {
    const ran = spawnSync("sh", ["-c", "exit 0"], { stdio: "ignore" });
    shell = !ran.error && ran.status === 0;
  }
  return shell;
}

/** The `test` of a file, or of one case, that cannot run unless something is here, so that it says what is missing. */
export function skipUnless(able: boolean, why: string): typeof runTest {
  if (able) return runTest;
  const skipping = (name: unknown, second?: unknown, third?: unknown) => {
    const options = typeof second === "object" && second !== null ? second : {};
    const body = typeof second === "function" ? second : third;
    return (runTest as (...args: unknown[]) => unknown)(name, { ...options, skip: why }, body);
  };
  // `test.skip`, `test.only` and `test.todo` are functions in their own right, and handing back copies of the real
  // ones would make a file that says it cannot run here run after all, one spelling at a time. Each of them is the
  // same wrapper: there is nothing to say about a case on a platform the whole file cannot run on.
  return Object.assign(skipping, runTest, {
    skip: skipping,
    only: skipping,
    todo: skipping,
  }) as unknown as typeof runTest;
}

/** The prefix every home this file makes is named with, and the one thing the sweep below is allowed to go by. */
const MINE = "agent-autoloop-";
/** Old enough that no run going on now can be in it: the whole suite is nine minutes, and the longest file is two. */
const STALE = 2 * 60 * 60 * 1000;

/**
 * What earlier runs left in the system's temporary place. Windows refuses to remove a folder anything still holds open,
 * and a detached child may for a moment longer — so a home now and then survives the hook below, and a machine that
 * runs this suite every day ends up with hundreds of them. Nothing here is about tidying up, which is why it is
 * best-effort and silent; what it is about is that leaving rubbish behind is not a thing a test suite may do.
 *
 * Only folders named the way this file names them, and only ones nothing has touched for two hours: a run going on
 * right now, on another file of this suite or in another terminal, is minutes old and is never one of these. What one
 * run leaves behind it therefore still leaves behind — the hold on the folder outlives the process asking for it — but
 * it is gone by the next day instead of staying for ever.
 */
function sweep() {
  try {
    for (const item of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!item.isDirectory() || !item.name.startsWith(MINE)) continue;
      const folder = join(tmpdir(), item.name);
      try {
        if (Date.now() - statSync(folder).mtimeMs < STALE) continue;
        rmSync(folder, { recursive: true, force: true, maxRetries: 2 });
      } catch {}
    }
  } catch {}
}

export function setup(name: string, rules = "rules.fixture.json") {
  sweep();
  const directory = mkdtempSync(join(tmpdir(), `${MINE}${name}-`));
  process.env.AGENT_AUTOLOOP_HOME = directory;
  // A path from the root is given as it is; a bare name is one of the fixtures beside this file. On Windows a path
  // from the root does not begin with a separator at all, so what makes it one is asked rather than guessed.
  process.env.AGENT_AUTOLOOP_RULES = isAbsolute(rules) ? rules : join(import.meta.dirname, rules);
  process.env.AGENT_AUTOLOOP_PUBLIC_URL = "https://hub.test";
  after(() => {
    try {
      // Windows refuses to remove a folder anything still holds open, and a detached child may for a moment longer —
      // so it is asked for again, with a wait between, instead of once. `maxRetries` waits for this and nothing else.
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      // And where it still will not go, the sweep at the next run's start gets it: tidying up is not what any of these
      // tests are about, and the folder is in the system's own temporary place.
      if (process.platform !== "win32") throw error;
    }
  });
  return directory;
}

/** A moment in a test's own time, minutes after a fixed start: 10:00 in Asia/Shanghai. */
export const at = (minutes: number) => Date.parse("2026-10-18T02:00:00.000Z") + minutes * 60_000;

/**
 * A stand-in ACP agent in a file of its own, to run for real. It answers as an agent should unless `script` says otherwise,
 * by replacing `on[method]`, with `send`, `update`, `say` and `ask` to talk with. A stubborn one has to end by itself too:
 * a test that fails leaves nothing running.
 */
export function acpAgent(dir: string, name: string, script = "") {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(
    file,
    `
import { appendFileSync, closeSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
const send = (x) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\\n');
const update = (update) => send({ method: 'session/update', params: { sessionId: 'agent-session', update } });
const say = (text, messageId) => update({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } });
const options = [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }];
const waiting = new Map();
const ask = (toolCall) => new Promise((resolve) => {
  const id = 1000 + waiting.size;
  waiting.set(id, resolve);
  send({ id, method: 'session/request_permission', params: { sessionId: 'agent-session', toolCall, options } });
});
const on = {
  initialize: (m) => send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }),
  'session/new': (m) => send({ id: m.id, result: { sessionId: 'agent-session' } }),
  'session/load': (m) => send({ id: m.id, result: {} }),
  'session/prompt': (m) => { say('做完了'); send({ id: m.id, result: { stopReason: 'end_turn' } }); },
};
${script}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method) on[m.method]?.(m);
  else waiting.get(m.id)?.(m.result);
});
`,
  );
  return file;
}
