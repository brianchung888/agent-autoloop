// The files a packaged build carries inside itself (host/assets.ts). What is being checked here is the source-mode
// half of it, and that the two halves can only ever be about the same files: the packaged half needs a binary, and
// tests/sea-format.test.ts is where that is compared.
//
// Failure cases: the one reader hands back different bytes than the expression it replaced, so the format hash moves
// and every existing install replays its whole log on the first start after an upgrade; a file is named here and is
// not in the tree, so a build embeds nothing under that name and the binary dies at its first start; a second spelling
// of one of these paths appears somewhere, and the two can then drift.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ASSETS, assetText, packaged } from "../host/assets.ts";
import { digest } from "../kernel/credentials.ts";

const root = join(import.meta.dirname, "..");

test("源码模式下这不是打包版，每个 asset 读回来的就是磁盘上那个文件", () => {
  assert.equal(packaged(), null, "源码模式下 node:sea 不该说自己是打包版");
  assert.ok(ASSETS.length, "清单是空的：打包版什么都不会带");
  for (const name of ASSETS) {
    const file = join(root, name);
    assert.ok(existsSync(file), `清单里有 ${name}，树里没有这个文件：打包版会带一个空的名字`);
    // 逐字节相同，不是「大致一样」：format hash 就是这些字节本身。
    assert.equal(assetText(name), readFileSync(file, "utf8"), name);
  }
});

test("format hash 用的还是原来那两个文件的原文：读取口没有动过字节", () => {
  // 改动前 host/runtime.ts 写的是 readFileSync(new URL("../kernel/evolve.ts", import.meta.url))，拼出来就是下面
  // 这两个路径。原样重算一遍，和经过那个唯一读取口得到的结果比：不相等就意味着每个现有安装升级时都要吃一次全量重放。
  const byHand = ["kernel/evolve.ts", "kernel/credentials.ts"]
    .map((file) => readFileSync(join(root, file), "utf8"))
    .join("\n");
  const byReader = (["kernel/evolve.ts", "kernel/credentials.ts"] as const).map((file) => assetText(file)).join("\n");
  assert.equal(digest(byReader), digest(byHand), "读取口改掉了字节：format hash 会变，升级要吃一次全量重放");
});

test("这些文件只有一种读法：没有第二处自己去读盘", () => {
  // 第二处读法就是 format hash 可以悄悄分叉的地方：一边走 asset、一边走磁盘，打包版和源码版的 digest 就不同。
  for (const [file, pattern] of [
    ["host/runtime.ts", /readFileSync\(new URL\(/],
    ["protocol/schema.ts", /readFileSync\(/],
  ] as const) {
    assert.doesNotMatch(readFileSync(join(root, file), "utf8"), pattern, `${file} 又自己读了一次这些文件`);
  }
});
