// The loader chain behind `loadPlugin`, and what a plugin may say about itself. Failure cases: a plugin.json a
// third-party repository wrote for something else of its own stops a plugin that works today from loading; a runtime
// nobody implements is taken for the default and the wrong thing runs; an `entry` reaches out of the plugin's folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("plugin-loaders");
const { DEFAULT_MANIFEST, readManifest } = await import("../host/plugin-manifest.ts");

/** A plugin folder under this install, with whatever is written as its plugin.json. */
function plugin(name: string, manifest?: string) {
  const folder = join(home, "plugins", name);
  mkdirSync(folder, { recursive: true });
  if (manifest !== undefined) writeFileSync(join(folder, "plugin.json"), manifest);
  return folder;
}

test("没有 plugin.json 的插件，就是这个机制存在之前的那种插件", () => {
  assert.deepEqual(readManifest(plugin("bare")), DEFAULT_MANIFEST);
  assert.deepEqual(DEFAULT_MANIFEST, { runtime: "source", entry: null, args: [] });
});

test("别人为别的用途写的 plugin.json 不能让今天能用的插件用不了", () => {
  // 这几种都读成默认值：第三方仓库里本来就可能有一个 plugin.json，讲的是它自己的事。
  for (const written of [
    '{"name":"theirs","version":"1.0.0"}',
    "not json at all",
    "[1,2,3]",
    "null",
    '{"runtime":null}',
  ])
    assert.deepEqual(readManifest(plugin(`lenient-${written.length}`, written)), DEFAULT_MANIFEST, written);
});

test("写明了 runtime 又写错，就不能当没写：接着走会跑错东西，或者什么都不跑", () => {
  assert.throws(() => readManifest(plugin("odd", '{"runtime":"wasm"}'), "odd"), /runtime 只能是 source 或 process/);
  assert.throws(() => readManifest(plugin("odd2", '{"runtime":42}'), "odd2"), /runtime 只能是/);
  assert.throws(() => readManifest(plugin("noentry", '{"runtime":"process"}'), "noentry"), /还要用 entry/);
});

test("process 的 entry 是插件目录里的一个相对路径，走不出去", () => {
  const folder = plugin("outside", '{"runtime":"process","entry":"../../escape.exe"}');
  assert.throws(() => readManifest(folder, "outside"), /走出了插件目录/);
  writeFileSync(join(folder, "plugin.json"), '{"runtime":"process","entry":"/bin/sh"}');
  assert.throws(() => readManifest(folder, "outside"), /不能是绝对路径/);
  writeFileSync(
    join(folder, "plugin.json"),
    String.raw`{"runtime":"process","entry":"C:\\Windows\\system32\\cmd.exe"}`,
  );
  assert.throws(() => readManifest(folder, "outside"), /不能是绝对路径/);

  // 路径的写法不够：插件目录里一个符号链接，写出来是目录内的相对路径，指的却是外面——跑的是它指到的那个。
  const linked = plugin("linked", '{"runtime":"process","entry":"out/run.js"}');
  const elsewhere = join(home, "另一个地方");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(join(elsewhere, "run.js"), "");
  let made = true;
  try {
    // Windows 上 junction 不需要特权，POSIX 上就是一个目录链接。
    symlinkSync(elsewhere, join(linked, "out"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    made = false;
  }
  if (made) assert.throws(() => readManifest(linked, "linked"), /走出了插件目录/, "经过链接走出去了");
  // 指向无处的链接也算出去：从它写进去，创建的是它指到的那个地方。
  const dangling = plugin("dangling", '{"runtime":"process","entry":"gone"}');
  try {
    symlinkSync(join(home, "根本没有这个"), join(dangling, "gone"), "junction");
    assert.throws(() => readManifest(dangling, "dangling"), /走出了插件目录/);
  } catch (error) {
    assert.match(String(error), /走出了插件目录|ENOENT|EPERM|EINVAL|UNKNOWN/);
  }

  const fine = plugin("runs", '{"runtime":"process","entry":"bin/run.js"}');
  assert.deepEqual(readManifest(fine, "runs"), { runtime: "process", entry: join(fine, "bin", "run.js"), args: [] });
  // args 是参数，不是 shell 词：写错形状就拒掉。
  writeFileSync(join(fine, "plugin.json"), '{"runtime":"process","entry":"bin/run.js","args":"-x"}');
  assert.throws(() => readManifest(fine, "runs"), /args 要是一串字符串/);
});

test("解析顺序没有变：这个安装目录里的同名插件，胜过随引擎发布的那一个", async () => {
  const { loadPlugin } = await import("../host/plugins.ts");
  // 内置的 command 插件是一个 Adapter；同名放一个到安装目录里，拿到的就是后者。
  assert.equal(typeof (await loadPlugin("command", "agent")).command, "function");
  mkdirSync(join(home, "plugins", "command"), { recursive: true });
  writeFileSync(join(home, "plugins", "command", "agent.ts"), "export default {marker:7};");
  assert.equal((await loadPlugin("command", "agent")).marker, 7);
  // 而找不到的那一句话，一个 loader 都没找到才说，用词和改动前一样。
  await assert.rejects(() => loadPlugin("nobody", "agent"), /没有 nobody 的插件（plugins\/nobody\/agent\.ts）/);
});

/**
 * A copy of the engine's `host/` with no `bin/agent-autoloop.ts` beside it, which is exactly what host/self.ts asks
 * about: such a tree is a packaged build as far as `fromSource()` can tell. Nothing can be faked here — the loaders
 * read that answer themselves — so the branch is reached by giving them a tree where it is really false.
 */
async function packaged() {
  const engine = join(home, "packaged");
  mkdirSync(engine, { recursive: true });
  cpSync(join(import.meta.dirname, "..", "host"), join(engine, "host"), { recursive: true });
  return await import(pathToFileURL(join(engine, "host", "plugins.ts")).href);
}

test("打包版里，装在这里的源码插件要得到那句能照着做的话，而不是 Node 的原始错误", async () => {
  const { loadPlugin } = await packaged();
  // 真有这个插件，只是这个版本跑不了它的 .ts：external 退开，processLoader 才说得上话。
  writeFileSync(join(plugin("their-source"), "agent.ts"), "export default { marker: 1 };");
  await assert.rejects(() => loadPlugin("their-source", "agent"), /这个打包版跑不了外部的 \.ts 文件/);
  // 而且那句话要指着这个插件自己的 plugin.json，说清楚改哪一个文件。
  await assert.rejects(
    () => loadPlugin("their-source", "agent"),
    new RegExp(`${join(home, "plugins", "their-source", "plugin.json").replaceAll("\\", "\\\\")}.*runtime.*process`),
  );
  // 而源码模式下的同一个插件照旧 import 得到：这一句只属于打包版。
  const here = await import("../host/plugins.ts");
  assert.equal((await here.loadPlugin("their-source", "agent")).marker, 1);
  // 两边都没有的插件，说的还是原来那一句。
  await assert.rejects(() => loadPlugin("nobody-at-all", "agent"), /没有 nobody-at-all 的插件/);
});

test("内置清单覆盖 plugins/ 下所有的 agent/channel/source，一条都不少", async () => {
  const { OUTPUT, render, scan } = await import("../scripts/build-registry.ts");
  const root = join(import.meta.dirname, "..");
  // 产生器扫出来的，要和自己读一遍目录得到的完全一样：漏登记的插件在源码模式下毫无异样，只有打包版没有它。
  const read = readdirSync(join(root, "plugins"), { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .flatMap((item) =>
      ["agent", "channel", "source"]
        .filter((kind) => existsSync(join(root, "plugins", item.name, `${kind}.ts`)))
        .map((kind) => `${item.name}/${kind}`),
    )
    .sort();
  assert.deepEqual(
    scan(root)
      .map(({ name, kind }) => `${name}/${kind}`)
      .sort(),
    read,
  );
  assert.equal(read.length, 11, "README 和计划里都说是 11 个内置插件");

  // 扫出来的每一条都是真有那个文件：这是 scan() 自己的性质——它只说刚刚看见过的文件——所以 --check 里
  // 再对一遍「清单里的路径存不存在」是永远成立的死码。这一条钉住那个性质，好让那段话没有被白删。
  for (const { name, kind } of scan(root))
    assert.ok(existsSync(join(root, "plugins", name, `${kind}.ts`)), `${name}/${kind}`);

  // 产生出来的那份模块也要过 typecheck：打包版编不过的模块，就是编不出来的打包版。
  const tsconfig = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
  assert.ok(tsconfig.include.includes("build"), "build/ 不在 tsconfig 的 include 里，产生出来的模块没人检查");
  assert.ok(OUTPUT.startsWith(join(root, "build") + sep), `产生的位置在 build/ 之外：${OUTPUT}`);

  // 写出来的那份模块里，每一条都是字面量 import：bundler 读不懂的东西它跟不上。
  const written = render(scan(root));
  for (const key of read) assert.ok(written.includes(`"${key}": () => import("../plugins/${key}.ts"),`), key);
  assert.equal(written.split("() => import(").length - 1, read.length);
});

test("没有产生清单的时候，loadPlugin 走的还是原来那条路", async () => {
  const { builtins } = await import("../host/plugin-registry.ts");
  assert.equal(builtins(), null, "源码模式里根本没有这张表");
});

test("插件要再起一次本程序，用的是同一种写法，不提自己的文件名", async () => {
  const root = join(import.meta.dirname, "..");
  const { PROGRAM, selfExecutable } = await import("../host/self.ts");
  const { stablePath } = await import("../host/node-path.ts");
  // 源码模式下的三个词，和 host/service.ts 写进服务、worker/worker.ts 包 launcher 用的是同一种：
  // 这个运行时、关掉那条警告、入口脚本的路径。
  assert.deepEqual(selfExecutable(), [
    stablePath(process.execPath),
    "--disable-warning=ExperimentalWarning",
    join(root, "bin", "agent-autoloop.ts"),
  ]);
  assert.equal(PROGRAM, join(root, "bin", "agent-autoloop.ts"));

  const delivery = (await import("../host/plugins.ts")).loadPlugin("delivery", "agent");
  const line = (await delivery).command({ command: ["owner/app"] });
  assert.deepEqual(line, [...selfExecutable(), "internal:plugin", "delivery", "owner/app"]);
  // 关键是这一句：命令行里不再有插件自己的文件，打包版里根本没有 .ts 可以指。
  assert.ok(
    !line.slice(3).some((part: string) => part.endsWith(".ts")),
    `命令行还指着插件自己的文件：${line.join(" ")}`,
  );
  assert.equal(typeof (await delivery).main, "function");
});

test("internal:plugin 走的是同一个 loader，所以命令行这边照样不认识任何插件", () => {
  const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "internal:plugin", ...args], {
      encoding: "utf8",
      env: { ...process.env, AGENT_AUTOLOOP_HOME: home },
      timeout: 30_000,
    });
  assert.match(run().stderr, /用法：agent-autoloop internal:plugin/);
  assert.match(run("nobody").stderr, /没有 nobody 的插件（plugins\/nobody\/agent\.ts）/);
  // 有这个插件、但它没有要自己跑的活：说清楚是哪一种缺。
  assert.match(run("codex").stderr, /没有可以这样跑的活/);
  // 而且它没有列进 HELP：没人需要手打它。
  assert.doesNotMatch(
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "help"], { encoding: "utf8" }).stdout,
    /internal:plugin/,
  );
});

test("一共四个 loader，顺序就是那句注释说的：装在这里的优先，随引擎发布的在后", async () => {
  const { builtinLoader, externalLoader, processLoader, shippedLoader } = await import("../host/plugin-loaders.ts");
  const { loaderOrder } = await import("../host/plugins.ts");
  assert.deepEqual(
    loaderOrder().map((loader) => loader.id),
    ["external", "process", "builtin", "shipped"],
  );
  assert.deepEqual(loaderOrder(), [externalLoader, processLoader, builtinLoader, shippedLoader]);
});

// 这一条要改全局的那张表，所以放在最后：前面有一条断言「源码模式下根本没有这张表」。
test("交进来一张清单，内置就从清单里拿——这是打包版走的那条路", async () => {
  const { loadPlugin } = await import("../host/plugins.ts");
  const { registerBuiltins } = await import("../host/plugin-registry.ts");
  const root = join(import.meta.dirname, "..");
  registerBuiltins({
    "made-up/agent": async () => ({ default: { marker: "from the registry" } }),
    // 真的内置插件也放一条：清单里的 import 要确实能把它拿出来。
    "webhook/channel": () => import(`${pathToFileURL(join(root, "plugins", "webhook", "channel.ts")).href}`),
  });
  assert.equal((await loadPlugin("made-up", "agent")).marker, "from the registry");
  assert.equal(typeof (await loadPlugin("webhook", "channel")), "function");

  // 而装在这个安装目录里的同名插件，还是赢过清单里的那一条。
  mkdirSync(join(home, "plugins", "made-up"), { recursive: true });
  writeFileSync(join(home, "plugins", "made-up", "agent.ts"), 'export default { marker: "from the folder" };');
  assert.equal((await loadPlugin("made-up", "agent")).marker, "from the folder");

  // 清单里没有、目录里也没有，还是原来那一句话。
  await assert.rejects(() => loadPlugin("neither", "source"), /没有 neither 的插件（plugins\/neither\/source\.ts）/);
});

test("插件名字是来处的最后一段：Windows 路径的反斜线也算分隔", () => {
  const bin = join(import.meta.dirname, "..", "bin", "agent-autoloop.ts");
  // 不跑 git，只看它把名字算成什么：名字不对就在克隆之前拒掉，这句话里会把算出的名字说出来。
  const name = (url: string) =>
    spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, "add", url], {
      encoding: "utf8",
      env: { ...process.env, AGENT_AUTOLOOP_HOME: join(home, "不存在的安装") },
      timeout: 30_000,
    });
  assert.match(name(String.raw`C:\tmp\plugins\Bad_Name`).stderr, /插件名字「bad_name」不能用/);
  assert.match(name("C:\\tmp\\plugins\\Bad_Name\\").stderr, /插件名字「bad_name」不能用/);
  assert.match(name("C:/tmp/plugins/Bad_Name/").stderr, /插件名字「bad_name」不能用/);
  assert.match(name("git@example.com:me/Bad_Name.git").stderr, /插件名字「bad_name」不能用/);
  assert.match(name("https://example.com/me/Bad_Name/").stderr, /插件名字「bad_name」不能用/);
  // 光一个盘符不是地址：Windows 上 `C:` 是「这个 shell 现在在 C 盘的哪里」，git clone 会把当前目录
  // 整个克隆过来，而它的最后一段是那个字母，于是装出一个叫 c 的插件。这个要在克隆之前就拒掉。
  for (const drive of ["C:", "c:", "D:/", "D:\\", "z:////"]) {
    const said = name(drive);
    assert.match(said.stderr, /只是一个盘符/, drive);
    assert.equal(said.status, 1, drive);
  }

  // 一个全是分隔符的地址根本没有最后一段：那也是一个不能用的名字，不是一句崩溃。
  for (const nothing of ["///", "/", ":", "\\", "::\\\\//"]) {
    const said = name(nothing);
    assert.match(said.stderr, /插件名字「」不能用/, nothing);
    assert.equal(said.status, 1, nothing);
  }
});
