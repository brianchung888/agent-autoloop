// The loader chain behind `loadPlugin`, and what a plugin may say about itself. Failure cases: a plugin.json a
// third-party repository wrote for something else of its own stops a plugin that works today from loading; a runtime
// nobody implements is taken for the default and the wrong thing runs; an `entry` reaches out of the plugin's folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("内置清单覆盖 plugins/ 下所有的 agent/channel/source，一条都不少", async () => {
  const { render, scan } = await import("../scripts/build-registry.ts");
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
