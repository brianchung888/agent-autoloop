// The one thing the whole packaged build was conditional on: that the format hash is the same in both modes.
//
// The hub keeps a projection of its log, and `projection_meta.format` is the digest of the files that decide what is
// stored (host/runtime.ts). A start that finds a different digest throws the projection away and replays the whole log
// — 43 seconds for 1.1 million facts, on every existing install, the first time it started as a binary. So this is not
// a nicety: 计划 plan-c 第五章 listed Q1 as the go/no-go for Phase 3, and this is that question, asked of the real
// binary rather than of an argument about it.
//
// It needs a binary to ask. There is none in CI's check job on purpose — the bundler lives in the release job alone
// (计划 D1(a)) — so this says so and skips there, and runs for real wherever one has been built.
//
// What a binary can be asked and what it cannot: `conformance` is an ordinary subcommand and so is reachable inside
// one (verified by hand against a hub the binary itself was running: 120 checks, passed). `sim/*` is not — nothing in
// the packaged entry imports it, and giving it a subcommand of its own was not done. INSTALL.md says so.
//
// Failure cases: the two modes read different bytes for the same file (a newline normalised, a BOM added, a second
// reader somewhere), so every upgrade replays; the binary takes itself for a source install because of where it was
// put, which is how it reaches for `.ts` files it cannot run and says none of the things it is meant to say about that.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

const root = join(import.meta.dirname, "..");
/**
 * The binary, where one has been built. Deliberately the one in `build/`, which is inside the source tree: that is the
 * arrangement a packaged build must not be fooled by, and one of the tests below is about exactly that.
 */
const binary = [join(root, "build", "agent-autoloop.exe"), join(root, "build", "agent-autoloop")].find(existsSync);
const NEEDS_BINARY = {
  skip:
    !binary &&
    "这一条要有一个真的二进位才问得出来：先跑 scripts/build-binary.ps1（或 .sh）。CI 的 check job 里没有 bundler——" +
      "按计划 D1(a) 它只出现在 release job，所以这里是 skip 而不是红",
};

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-sea-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

let homes = 0;
function home() {
  const where = join(dir, `home-${++homes}`);
  mkdirSync(where, { recursive: true });
  return where;
}

const inside = (where: string) => ({
  ...process.env,
  AGENT_AUTOLOOP_HOME: where,
  AGENT_AUTOLOOP_RULES: join(root, "tests", "rules.fixture.json"),
  AGENT_AUTOLOOP_COMMIT: undefined,
  AGENT_AUTOLOOP_RELEASE: undefined,
  AGENT_AUTOLOOP_PUBLIC_URL: undefined,
});

/** Opens this install's database in source mode, which is what writes the format down. */
function asSource(where: string) {
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", 'await import("./host/runtime.ts");'],
    { cwd: root, env: inside(where), encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(done.status, 0, done.stderr);
}

/**
 * The same, by the binary. `key list` is the cheapest command that opens the database locally and nothing else: no
 * port, no hub, no network — and opening it is the whole of what this test is about, because opening it with another
 * format is what rewrites `projection_meta` and replays the log.
 */
function asBinary(where: string, ...args: string[]) {
  const done = spawnSync(binary!, args.length ? args : ["key", "list"], {
    cwd: root,
    env: inside(where),
    encoding: "utf8",
    timeout: 120_000,
  });
  return done;
}

/** What the database says its projection was built from, and how far the projection has got. */
function stored(where: string) {
  const db = new DatabaseSync(join(where, "hub.db"), { readOnly: true });
  try {
    return db.prepare("SELECT format,seq FROM projection_meta WHERE id=1").get() as { format: string; seq: number };
  } finally {
    db.close();
  }
}

test("两个模式的 format hash 逐字相同：现有安装升级到二进位不吃一次全量重放", NEEDS_BINARY, () => {
  const where = home();
  // 同一个 HOME，所以 master.key 是同一把——digest(environment.secret) 这一项相同，比的才是 kernel 原文那一项。
  asSource(where);
  const was = stored(where);
  assert.match(was.format, /^[0-9a-f]{64}$/);

  const done = asBinary(where);
  assert.equal(done.status, 0, done.stderr);
  const now = stored(where);
  assert.equal(now.format, was.format, "打包版算出来的 format 不一样：每个现有安装升级时都要重放整条日志");

  // 而且确实没有重建：重建会把 seq 重新走一遍并改写 projection_meta，所以这两个数字一起钉住。
  assert.equal(now.seq, was.seq, "projection 被重建了");

  // 反过来也走一遍：打包版建的库，源码模式开起来同样不该重建。
  const other = home();
  assert.equal(asBinary(other).status, 0);
  const first = stored(other);
  asSource(other);
  assert.deepEqual(stored(other), first, "源码模式开打包版建的库，重建了");
});

test("二进位放在源码树里，仍然知道自己是打包版", NEEDS_BINARY, () => {
  // PoC 里这一条是真的坏过（phase3-poc-report.md 三.1 步骤 5）：打包版的 import.meta.dirname 是那个 exe 自己的
  // 目录，于是放在 build/ 里的二进位找得到 ../bin/agent-autoloop.ts，fromSource() 答 true，它就去 import 一个
  // 自己根本跑不了的 .ts，拿到的是 Node 的原始错误而不是那句能照着做的话。上面那个 binary 用的就是 build/ 里
  // 那一个，所以这一条问的正是那个局面。
  assert.ok(existsSync(join(root, "bin", "agent-autoloop.ts")), "这一条的前提是那个入口脚本真的就在旁边");

  const where = home();
  const folder = join(where, "plugins", "outside");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "agent.ts"), "export default { marker: 42 };\n");
  const done = asBinary(where, "internal:plugin", "outside");
  assert.notEqual(done.status, 0);
  assert.match(
    done.stderr,
    /这个打包版跑不了外部的 \.ts 文件/,
    `打包版把自己当成了源码安装：\n${done.stdout}\n${done.stderr}`,
  );
  // 而且那句话要指着这个插件自己的 plugin.json，说清楚改哪一个文件。
  assert.ok(done.stderr.includes(join(folder, "plugin.json")), done.stderr);
});

test("二进位说得出自己是哪一份代码，而且 stderr 上一句话都没有", NEEDS_BINARY, () => {
  const said = spawnSync(binary!, ["--version"], { encoding: "utf8", timeout: 60_000 });
  assert.equal(said.status, 0, said.stderr);
  assert.equal(said.stderr, "", `二进位在 stderr 上留了话：${said.stderr}`);
  assert.match(said.stdout.trim(), /^agent-autoloop .+（提交 [0-9a-f]{12}）$/, said.stdout);
  assert.doesNotMatch(said.stdout, /提交 dev/, "建置期没把提交号写进去：bug report 里没人放得下这个版本");
});
