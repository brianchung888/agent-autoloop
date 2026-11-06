// Where `up` says what it is doing on Windows. launchd points it at a file and systemd at its journal, and both keep
// that file to a size; a scheduled task points it nowhere, so the file is this program's own to write — and its own to
// stop writing for ever.
//
// Failure cases: a hub that has been up for months fills the disk one line at a time; rolling it over throws into the
// very call it was meant to serve; what it rolled over to is kept for ever as well.
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("platform-log");
const { rollLog } = await import("../host/up.ts");

test("长到一定大小就翻一页，上一页只留一份", () => {
  const file = join(home, "up.log");
  writeFileSync(file, "x".repeat(100));
  assert.equal(rollLog(file, 1000), false, "没到就不动它");
  assert.equal(statSync(file).size, 100);

  writeFileSync(file, "第一页".repeat(500));
  assert.equal(rollLog(file, 1000), true);
  assert.equal(existsSync(file), false, "新的一页从头开始写");
  assert.match(readFileSync(`${file}.1`, "utf8"), /第一页/);

  // The next one takes the place of what is there: one generation back, never a folder filling up with them.
  writeFileSync(file, "第二页".repeat(500));
  assert.equal(rollLog(file, 1000), true);
  assert.match(readFileSync(`${file}.1`, "utf8"), /第二页/);
});

test("没有这个文件也不抛错", () => {
  assert.equal(rollLog(join(home, "没有这个文件"), 10), false);
});
