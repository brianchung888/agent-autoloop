// `agent-autoloop --version`: what someone pastes into a bug report. Failure cases: it needs an install to answer; code past a
// release still calls itself that release, as a number kept in a file does; a try-out tag beats the release on the same commit;
// a tag that isn't a version is taken for one; a commit whose ref has been packed away (what a clone comes to after a gc) reads
// as unknown, or a copy unpacked inside some other repository reads as that repository's commit or release.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { commitOf, releaseOf, versionLine, versionName } from "../host/version.ts";

const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-version-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("it prints this commit's release and the commit, with nothing installed", () => {
  const empty = join(dir, "nothing-installed");
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_AUTOLOOP_HOME: empty };
  delete env.AGENT_AUTOLOOP_COMMIT;
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(root, "bin", "agent-autoloop.ts"), "--version"],
    { env, encoding: "utf8" },
  );
  assert.equal(done.status, 0, done.stderr);
  const commit = git(root, "rev-parse", "HEAD").slice(0, 12);
  assert.equal(done.stdout.trim(), `agent-autoloop ${releaseOf(root) ?? "未发布"}（提交 ${commit}）`);
  assert.ok(!existsSync(empty), "asking the version sets nothing up");
});

test("the version is the tag on this commit, and only while it's on that commit", () => {
  const before = process.env.AGENT_AUTOLOOP_COMMIT;
  delete process.env.AGENT_AUTOLOOP_COMMIT;
  const repo = join(dir, "tagged");
  mkdirSync(join(repo, "vendored"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "x");
  const head = git(repo, "rev-parse", "HEAD").slice(0, 12);
  assert.equal(releaseOf(repo), null);
  assert.equal(versionLine(repo), `agent-autoloop 未发布（提交 ${head}）`);
  assert.equal(versionName(repo), head, "what other programs are told still says which code this is");

  git(repo, "tag", "pre-public-delete-20261203");
  git(repo, "tag", "vendor-drop");
  assert.equal(releaseOf(repo), null, "a tag that isn't a version");
  git(repo, "tag", "v1.2.0-rc.1");
  assert.equal(releaseOf(repo), "v1.2.0-rc.1");
  git(repo, "tag", "v1.2.0");
  git(repo, "tag", "v1.2.0-rc.2");
  assert.equal(releaseOf(repo), "v1.2.0", "the release, not the try-outs that became it");
  assert.equal(versionLine(repo), `agent-autoloop v1.2.0（提交 ${head}）`);
  assert.equal(versionName(repo), "v1.2.0");
  assert.equal(releaseOf(join(repo, "vendored")), null, "a copy inside a repository isn't that repository's release");

  git(repo, "commit", "-q", "--allow-empty", "-m", "past it");
  assert.equal(releaseOf(repo), null, "past a release it isn't that release");
  assert.equal(releaseOf(join(dir, "no-such-folder")), null);
  if (before !== undefined) process.env.AGENT_AUTOLOOP_COMMIT = before;
});

test("a commit reads the same whether its ref is a file or packed away, and a deployment's word counts", () => {
  const before = process.env.AGENT_AUTOLOOP_COMMIT;
  delete process.env.AGENT_AUTOLOOP_COMMIT;
  const clone = join(dir, "clone");
  mkdirSync(clone);
  git(clone, "init", "-q", "-b", "main");
  writeFileSync(join(clone, "file"), "x");
  git(clone, "add", "file");
  git(clone, "commit", "-qm", "x");
  const head = git(clone, "rev-parse", "HEAD");
  assert.equal(commitOf(clone), head);
  git(clone, "pack-refs", "--all");
  assert.ok(!existsSync(join(clone, ".git", "refs", "heads", "main")));
  assert.equal(commitOf(clone), head);

  mkdirSync(join(clone, "vendored"));
  assert.equal(commitOf(join(clone, "vendored")), "dev", "a copy inside a repository isn't at its commit");
  assert.equal(commitOf(join(dir, "no-such-folder")), "dev");

  process.env.AGENT_AUTOLOOP_COMMIT = "deployed";
  assert.equal(commitOf(clone), "deployed");
  if (before === undefined) delete process.env.AGENT_AUTOLOOP_COMMIT;
  else process.env.AGENT_AUTOLOOP_COMMIT = before;
});

test("建置期说的那一句话算数：打包版没有 .git 可问，版本是被写进去的", () => {
  // 打包的时候这两个值被替换成字面量，所以答案跟着二进位走，而不是跟着谁的环境走。源码模式下它们是空的，
  // 由 checkout 回答——上面那几条讲的就是那条路。
  const was = { commit: process.env.AGENT_AUTOLOOP_COMMIT, release: process.env.AGENT_AUTOLOOP_RELEASE };
  const nowhere = join(dir, "not-a-checkout");
  mkdirSync(nowhere, { recursive: true });
  try {
    delete process.env.AGENT_AUTOLOOP_COMMIT;
    delete process.env.AGENT_AUTOLOOP_RELEASE;
    assert.equal(commitOf(nowhere), "dev", "没有 .git 又没人告诉它，就老实说不知道");
    assert.equal(releaseOf(nowhere), null);

    process.env.AGENT_AUTOLOOP_COMMIT = "0123456789abcdef0123";
    process.env.AGENT_AUTOLOOP_RELEASE = "v9.9.9";
    assert.equal(releaseOf(nowhere), "v9.9.9");
    assert.equal(versionName(nowhere), "v9.9.9");
    assert.equal(versionLine(nowhere), "agent-autoloop v9.9.9（提交 0123456789ab）");
    // 空字符串是「这次建置不知道」，不是一个版本号：PoC 里 doctor 印出的那个 dev 就是这种情况。
    process.env.AGENT_AUTOLOOP_RELEASE = "";
    assert.equal(releaseOf(nowhere), null);
    assert.equal(versionLine(nowhere), "agent-autoloop 未发布（提交 0123456789ab）");
  } finally {
    for (const [name, value] of [
      ["AGENT_AUTOLOOP_COMMIT", was.commit],
      ["AGENT_AUTOLOOP_RELEASE", was.release],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("打包版不去问旁边那个 .git：先问这是哪一种建置，再决定要不要问 git", () => {
  // 二进位被复制进一棵 checkout 里时，ROOT（import.meta.dirname 的上一层）就落在那棵 checkout 里，于是
  // --version 会报出别人的提交号。bug report 里报错号比报 dev 更糟。这一条钉住那道先问的顺序：真正的
  // 二进位行为由自检里的「打包版 --version」与 tests/sea-format.test.ts 覆盖，这里没有 SEA 可以假装。
  const text = readFileSync(join(root, "host", "version.ts"), "utf8");
  assert.match(text, /from "\.\/assets\.ts"/, "host/version.ts 没有问过这是哪一种建置");
  for (const which of ["commitOf", "releaseOf"]) {
    const body = text.slice(text.indexOf(`export function ${which}(`));
    const asked = body.indexOf("packaged()");
    const git = body.indexOf('path.join(root, ".git")');
    assert.ok(asked >= 0 && git >= 0 && asked < git, `${which} 先摸了 .git 才问这是哪一种建置`);
  }
});
