// The thing the rest of the suite is skipped by. A file that says it cannot run on this platform has to be skipped
// however it spells `test` — a `test.skip` or a `test.only` that quietly runs the case is how a skip becomes a failure
// nobody asked for, in a file whose whole point is that it cannot run here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { skipOn } from "./helpers.ts";

test("一份整体跳过的文件，每一种写法都跳过", () => {
  const skipping = skipOn([process.platform], "这是给这条测试装的理由");
  for (const spelling of ["skip", "only", "todo"] as const) {
    assert.equal(skipping[spelling], skipping, `test.${spelling} 必须也是那个跳过的包装`);
  }
});

test("不是它说的平台，就还是原来的 test", () => {
  assert.equal(skipOn([], "没有哪个平台"), test);
});
