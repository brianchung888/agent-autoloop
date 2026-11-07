// The thing the rest of the suite is skipped by. A file that says it cannot run on this platform has to be skipped
// however it spells `test` — a `test.skip` or a `test.only` that quietly runs the case is how a skip becomes a failure
// nobody asked for, in a file whose whole point is that it cannot run here.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { setup, skipOn } from "./helpers.ts";

test("一份整体跳过的文件，每一种写法都跳过", () => {
  const skipping = skipOn([process.platform], "这是给这条测试装的理由");
  for (const spelling of ["skip", "only", "todo"] as const) {
    assert.equal(skipping[spelling], skipping, `test.${spelling} 必须也是那个跳过的包装`);
  }
});

test("不是它说的平台，就还是原来的 test", () => {
  assert.equal(skipOn([], "没有哪个平台"), test);
});

test("上一次跑剩下的临时目录，下一次开始时清掉", () => {
  // Windows 偶尔删不掉这些目录（有东西还开着），于是一台每天跑这个套件的机器会攒下几百个。
  const long = (Date.now() - 24 * 60 * 60 * 1000) / 1000;
  const left = mkdtempSync(join(tmpdir(), "agent-autoloop-剩下的-"));
  writeFileSync(join(left, "hub.db"), "");
  utimesSync(left, long, long);
  // 刚才的那个可能正是这个套件另一个文件在用的；名字不是这个套件的，一个都不碰。
  const fresh = mkdtempSync(join(tmpdir(), "agent-autoloop-正在跑的-"));
  const theirs = mkdtempSync(join(tmpdir(), "别人的东西-"));
  utimesSync(theirs, long, long);
  try {
    setup("helpers-sweep");
    assert.equal(existsSync(left), false, "早先剩下的没有清掉");
    assert.equal(existsSync(fresh), true, "刚才建的可能有人正在用");
    assert.equal(existsSync(theirs), true, "名字不是这个套件的，碰不得");
  } finally {
    for (const dir of [left, fresh, theirs]) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

/**
 * 哪个 HOME 是 host/home.ts 加载那一刻定下来的（它是故意这样的：往下所有东西从此说的是同一个地方）。而
 * `setup()` 是在一份测试文件的 import 都跑完之后才选那个 HOME 的——静态 import 排在模块体之前，这是语言的
 * 规矩，不是这里的安排。所以一份测试文件只要在静态 import 里顺着什么路摸到了 host/home.ts，它那一行 `setup()`
 * 就已经晚了：那一整份测试跑的是真正的 `~/.agent-autoloop`，在别人的安装里写东西，而且一句话都不会说。
 *
 * 发生过一次：给人看的话挪进 i18n/ 的时候，host/i18n.ts import 了 host/home.ts，而「凡是要说话的文件」都会
 * 加载 host/i18n.ts——于是 tests/cards.test.ts 静态 import 的那两个模块把这件事提前定死了。所以这里钉的不是
 * 那一个 import，是这条路本身。
 */
function reaches(from: string, target: string) {
  const root = join(import.meta.dirname, "..");
  const seen = new Set<string>();
  const left = [from];
  while (left.length) {
    const file = left.pop()!;
    if (seen.has(file) || !existsSync(join(root, file))) continue;
    seen.add(file);
    if (file === target) return true;
    const text = readFileSync(join(root, file), "utf8");
    // 只看静态 import：`await import(...)` 是在模块体里跑的，排在 setup() 之后，这正是别的文件躲开它的办法。
    // `import type ...` 也不算：它整句被擦掉，那个模块根本不会加载（verbatimModuleSyntax）。
    for (const found of text.matchAll(/^import\s+(?!type\s)(?:[^;]*?\s+from\s+)?"(\.[^"]+)";$/gm)) {
      left.push(relative(root, resolve(dirname(join(root, file)), found[1])).replaceAll("\\", "/"));
    }
  }
  return false;
}

test("没有一份测试在 setup() 之前就把「哪个 HOME」定下来", () => {
  const root = join(import.meta.dirname, "..");
  const early: string[] = [];
  for (const name of readdirSync(join(root, "tests")).filter((name) => name.endsWith(".test.ts"))) {
    const text = readFileSync(join(root, "tests", name), "utf8");
    if (!text.includes("setup(")) continue;
    if (reaches(`tests/${name}`, "host/home.ts")) early.push(`tests/${name}`);
  }
  assert.deepEqual(
    early,
    [],
    `这些文件的静态 import 会摸到 host/home.ts，于是它们跑在真正的 ~/.agent-autoloop 里：\n${early.join("\n")}\n` +
      "把那条路上的 import 改成 setup() 之后的 await import()，或者让那个模块不要再 import host/home.ts。",
  );
});
