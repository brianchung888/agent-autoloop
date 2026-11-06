// The loader chain behind `loadPlugin`, and what a plugin may say about itself. Failure cases: a plugin.json a
// third-party repository wrote for something else of its own stops a plugin that works today from loading; a runtime
// nobody implements is taken for the default and the wrong thing runs; an `entry` reaches out of the plugin's folder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  assert.deepEqual(DEFAULT_MANIFEST, { runtime: "source", entry: null });
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
  assert.deepEqual(readManifest(fine, "runs"), { runtime: "process", entry: join(fine, "bin", "run.js") });
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
