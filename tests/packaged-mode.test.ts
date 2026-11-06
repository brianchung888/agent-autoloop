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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { assetText } from "../host/assets.ts";
import { envFile, installMark, taskXml } from "../host/service-win.ts";
import { placeSkill, skillFolder } from "../host/skill.ts";
import { unit } from "../host/service.ts";

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

test("服务定义里也没有 .ts 可以指：只有那个可执行文件和 up", () => {
  // 常驻那一层写的是「用这个 node 跑这个入口脚本」。打包版里没有入口脚本，也没有一个会去读
  // --disable-warning 的 node：任务和 unit 只该写那个可执行文件。program 为空就是「没有入口脚本」。
  const home = join(dir, "service");
  const executable = join(dir, "agent-autoloop.exe");
  const written = taskXml({
    label: "agent-autoloop",
    home,
    executable,
    program: "",
    startBoundary: "2026-01-01T00:00",
  });
  assert.ok(written.includes(`<Command>${executable}</Command>`), written);
  assert.ok(written.includes(`<Arguments>&quot;--env-file=${envFile(home)}&quot; &quot;up&quot;</Arguments>`), written);
  assert.doesNotMatch(written, /disable-warning/, "打包版里没有谁会读这个 flag");
  assert.doesNotMatch(written, /\.ts&quot;/, "任务还指着一个 .ts");
  // 任务的身份在打包版里是那个可执行文件：uninstall 靠它认出这个任务是不是自己的。
  assert.ok(written.includes(installMark(home, executable)), "任务的记号不是按这个可执行文件记的");
  // 源码模式下这一行一个字都没变：入口脚本还在，flag 也还在。
  const asBefore = taskXml({ label: "a", home, executable, program: join(home, "bin", "agent-autoloop.ts") });
  assert.ok(asBefore.includes(`&quot;--disable-warning=ExperimentalWarning&quot;`), asBefore);

  // systemd 那边同理。ExecStart 的每个词都被引起来并转义过，所以数词：两个，而不是四个。
  const service = unit({ home, executable, program: "" });
  const exec = /^ExecStart=(.*)$/m.exec(service)?.[1] ?? "";
  assert.equal(exec.split(" ").length, 2, `ExecStart 不是「可执行文件 + up」两个词：${exec}`);
  assert.ok(exec.endsWith('"up"'), exec);
  assert.doesNotMatch(service, /disable-warning/);
  assert.equal(/^ExecStart=(.*)$/m.exec(unit({ home, executable, program: "/p/bin/x.ts" }))?.[1]?.split(" ").length, 4);
});

test("内部子命令不进帮助，也不进 TAKES：它们不是给人打的", () => {
  const main = readFileSync(join(repo, "cli", "main.ts"), "utf8");
  const help = main.slice(main.indexOf("const HELP = `"), main.indexOf("const INIT_USAGE"));
  assert.doesNotMatch(help, /internal:/, "内部子命令进了帮助");
  const takes = main.slice(main.indexOf("const TAKES"), main.indexOf("type Flags"));
  assert.doesNotMatch(
    takes,
    /internal:/,
    "内部子命令进了 TAKES：它们的参数是另一个程序的命令行，不该被当成本程序的 flag 检查",
  );
  // 而它们确实都在那张表里：worker 包一轮用的、插件再起本程序用的。
  assert.match(main, /"internal:launch":/);
  assert.match(main, /"internal:plugin":/);
});

test("「这是哪一种建置」先问 node:sea，再看磁盘上有没有入口脚本", () => {
  // 顺序就是行为。PoC 实测过反过来的代价：打包版里 import.meta.dirname 变成那个 exe 自己的目录，于是一个被
  // 复制进源码树的二进位找得到 bin/agent-autoloop.ts，把自己当成源码安装——之后它去跑它根本跑不了的 .ts，
  // 而该说的那句话一句都没说。这里没有 SEA 可以假装，所以钉的是那道顺序；真二进位的行为在自检里跑。
  const self = readFileSync(join(repo, "host", "self.ts"), "utf8");
  const asked = self.indexOf("packaged() === null");
  const looked = self.indexOf("existsSync(PROGRAM)");
  assert.ok(asked >= 0, "host/self.ts 没有问 node:sea");
  assert.ok(looked > asked, "先摸了磁盘才问这是哪一种建置");
});

test("再起本程序的那条命令行，在没有入口脚本的树里只有那个可执行文件", () => {
  // selfExecutable() 是所有这些地方的唯一来源：常驻、worker 包一轮、插件再起本程序、init 告诉人怎么打。
  const done = run(["internal:plugin", "没有这个插件"]);
  assert.notEqual(done.status, 0);
  // 走到的是同一个 loader，所以说的还是那一句；这里要的是它真的走到了，而不是半路因为路径不对就死了。
  assert.match(done.stderr, /插件名字不正确|没有/);
});

test("打包版把 SKILL.md 放到这个安装自己的 HOME 下，而不是指一个没有的文件", () => {
  // PoC 里 doctor 印的是那个 exe 上一层目录下的 skills\agent-autoloop\SKILL.md——那里什么都没有。
  // 打包版带着 SKILL.md，所以它要先写出来，再把 Agent 的 skills/ 接到写出来的那个地方。
  const home = join(dir, "skill-home");
  mkdirSync(home, { recursive: true });
  const asked = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `const { placeSkill, skillFolder } = await import(${JSON.stringify(pathToFileURL(join(copy, "host", "skill.ts")).href)});
       console.log(JSON.stringify({ folder: skillFolder(), placed: placeSkill() }));`,
    ],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, AGENT_AUTOLOOP_HOME: home } },
  );
  assert.equal(asked.status, 0, asked.stderr);
  const { folder, placed } = JSON.parse(asked.stdout);
  assert.equal(folder, join(home, "skills", "agent-autoloop"), "打包版的 skill 该落在这个安装自己的 HOME 下");
  assert.equal(placed, folder);
  // 写出来的就是带在里面的那一份，逐字节相同：Agent 读到的和仓库里那一份是同一份。
  assert.equal(
    readFileSync(join(folder, "SKILL.md"), "utf8"),
    readFileSync(join(repo, "skills", "agent-autoloop", "SKILL.md"), "utf8"),
  );

  // 再放一次不会动它：接好的链接要一直是接好的，文件的时间也不该每次启动都变。
  const was = statSync(join(folder, "SKILL.md")).mtimeMs;
  const again = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `const { placeSkill } = await import(${JSON.stringify(pathToFileURL(join(copy, "host", "skill.ts")).href)});
       placeSkill();`,
    ],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, AGENT_AUTOLOOP_HOME: home } },
  );
  assert.equal(again.status, 0, again.stderr);
  assert.equal(statSync(join(folder, "SKILL.md")).mtimeMs, was, "又写了一遍");
});

test("源码模式下 skill 还是树里那个目录，一个字节都不写", () => {
  assert.equal(skillFolder(), join(repo, "skills", "agent-autoloop"));
  assert.equal(placeSkill(), skillFolder());
  assert.equal(assetText("skills/agent-autoloop/SKILL.md"), readFileSync(join(skillFolder(), "SKILL.md"), "utf8"));
});

test("二进位的升级方式是重新下载：update 不去动一棵它没有的 checkout", () => {
  // 二进位自我更新（计划 3.7）另案。在它做完之前这条命令要说实话：它不会 git fetch 一棵不存在的仓库，
  // 也不会说「已经是最新的」——那是在没有发生任何事的时候报告升级成功。
  const done = run(["update"]);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /升级方式是重新下载/);
  assert.match(done.stdout, /releases/, "没说去哪里取");
  assert.match(done.stdout, /SHA256|sha256/, "没说要对校验和");
  assert.doesNotMatch(done.stdout, /已经是最新的|更新好了/, "什么都没动，却说升级过了");
  assert.doesNotMatch(done.stderr, /git/, "去动 git 了");
  // 文件里写的也是这一条：README 和 INSTALL 都得说得出「重新下载」。
  for (const file of ["INSTALL.md", "README.md"]) {
    assert.match(readFileSync(join(repo, file), "utf8"), /重新下载/, `${file} 没写二进位怎么升级`);
  }
});
