// The thing the rest of the suite is skipped by. A file that says it cannot run on this platform has to be skipped
// however it spells `test` — a `test.skip` or a `test.only` that quietly runs the case is how a skip becomes a failure
// nobody asked for, in a file whose whole point is that it cannot run here.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
