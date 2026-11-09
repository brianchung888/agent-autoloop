// Failure modes: workspace context includes private entry data, aliases another turn, or cleanup follows a hostile path.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { copyContext, removeContext } from "../worker/context.ts";
const scratch = mkdtempSync(join(tmpdir(), "autoloop-context-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }));
const context = {
  events: [],
  answers: [],
  timers: [],
  waiting: [],
  open: [],
  decided: [],
  token: "private-entry-token",
};
test("context copy contains only current context, remains a separate file, and removes only its own directory", () => {
  const cwd = join(scratch, "workspace");
  mkdirSync(cwd);
  const a = copyContext(cwd, context),
    b = copyContext(cwd, { ...context, events: [] });
  assert.notEqual(a.folder, b.folder);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(a.file, "utf8"))), [
    "events",
    "answers",
    "timers",
    "waiting",
    "open",
    "decided",
  ]);
  assert.ok(!readFileSync(a.file, "utf8").includes("private-entry-token"));
  if (process.platform !== "win32") assert.equal(statSync(a.file).mode & 0o777, 0o600);
  removeContext(a);
  assert.ok(!existsSync(a.folder));
  assert.ok(existsSync(b.file));
  removeContext(b);
  assert.deepEqual(readdirSync(cwd), []);
});
test("context cleanup rejects paths outside the recorded workspace or replaced with reparse links", () => {
  const cwd = join(scratch, "links");
  mkdirSync(cwd);
  const copy = copyContext(cwd, context);
  assert.throws(() => removeContext({ ...copy, root: scratch }), /Invalid/);
  const target = join(scratch, "must-survive");
  mkdirSync(target);
  removeContext(copy);
  symlinkSync(target, copy.folder, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => removeContext(copy), /redirected/);
  assert.ok(existsSync(target));
  rmSync(copy.folder);
});

test("Git metadata copies keep normal and linked worktrees clean without editing ignore files", () => {
  const repo = join(scratch, "repo"),
    worktree = join(scratch, "worktree"),
    hooks = join(scratch, "empty-hooks");
  mkdirSync(hooks);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", repo);
  git(
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  git("-C", repo, "worktree", "add", "--detach", worktree);
  for (const cwd of [repo, worktree]) {
    const copy = copyContext(cwd, context);
    assert.ok(copy.root.includes(".git"));
    assert.equal(git("-C", cwd, "status", "--short"), "");
    removeContext(copy);
    assert.equal(git("-C", cwd, "status", "--short"), "");
  }
});
