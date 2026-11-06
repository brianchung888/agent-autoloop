// What this program says about itself where there is no entry script on disk. A packaged build is one executable and
// nothing beside it: no `bin/agent-autoloop.ts` to name, no `.cmd` to run it with, no `.ts` anywhere at all. So every
// place that tells a person or an Agent what to type has to say the executable instead.
//
// Nothing is faked. The branch is reached by running the program out of a tree that really has no `bin/` in it, which
// is exactly the question `fromSource()` (host/self.ts) asks — the same trick tests/plugin-loaders.test.ts uses for the
// loaders, one level up: here the whole command line runs there.
//
// Failure cases: `init` finishes by telling someone to run a `.ts` that is not on their disk, so the first thing they
// do after installing fails; the two spellings of the entry script's path drift apart, and a shim written by one is not
// recognised by the other.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-packaged-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

const repo = join(import.meta.dirname, "..");
/**
 * The program without its entry script: everything it imports, and not `bin/`. As far as anything inside it can tell,
 * this is a packaged build — which is the whole point, since what decides that is asked of the file system.
 */
const copy = join(dir, "no-entry");
for (const part of ["cli", "host", "kernel", "plugins", "protocol", "skills", "worker", "package.json"]) {
  cpSync(join(repo, part), join(copy, part), { recursive: true });
}

let homes = 0;
/** One run of the command line out of that tree, in a throwaway home of its own. */
function run(args: string[], home = join(dir, `home-${++homes}`)) {
  mkdirSync(home, { recursive: true });
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(copy, "cli", "main.ts"), ...args],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        AGENT_AUTOLOOP_HOME: home,
        AGENT_AUTOLOOP_RULES: join(home, "rules.json"),
      },
    },
  );
  return { ...done, home };
}

test("打包版里没有入口脚本，所以 init 说的下一步是那个可执行文件，不是一个不存在的 .ts", () => {
  const done = run(["init", "--no-service", "--command", "echo {prompt}", "--port", "3998"]);
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.match(done.stdout, /装好了/);
  // 这就是那个毛病：以前这里印的是 ROOT/bin/agent-autoloop.ts，而 ROOT 在打包版里是那个 exe 的上一层目录。
  assert.doesNotMatch(done.stdout, /\.ts\b/, `init 叫人去跑一个 .ts：\n${done.stdout}`);
  assert.doesNotMatch(done.stdout, /\.cmd\b/, "打包版里没有 bin/agent-autoloop.cmd 可以跑");
  const next = /先运行 (.+?) up 启动中台/.exec(done.stdout);
  assert.ok(next, `没说下一步怎么启动：\n${done.stdout}`);
  // 这个测试跑的是源码树的副本，所以「这个可执行文件」就是 node 自己；真正的打包版里它是 agent-autoloop.exe。
  assert.ok(
    next[1] === process.execPath || next[1] === `"${process.execPath}"` || next[1] === `'${process.execPath}'`,
    `说的不是这个可执行文件：${next[1]}`,
  );
  // 而且这一步真的走完了：装好的东西都在。
  assert.ok(JSON.parse(readFileSync(join(done.home, "config.json"), "utf8")).owner, "init 没写出配置");
});

test("入口脚本的路径只有一种写法：命令行这边不再自己抄一份", () => {
  const main = readFileSync(join(repo, "cli", "main.ts"), "utf8");
  assert.ok(
    !/\bpath\.join\(ROOT, "bin", "agent-autoloop\.ts"\)/.test(main),
    "cli/main.ts 又自己拼了一份入口脚本路径：要从 host/self.ts 取 PROGRAM，否则两份会各走各的（ROOT 来自 import.meta.dirname，打包版里被 define 掉）",
  );
  assert.match(main, /from "\.\.\/host\/self\.ts"/, "cli/main.ts 没有从 host/self.ts 取这件事");
});
