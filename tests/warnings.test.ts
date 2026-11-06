// The one warning a packaged build has no command line left to turn off (host/warnings.ts). Real processes, with no
// `--disable-warning` on them: what is being tested is what the runtime prints, and a stand-in would print it instead.
//
// Failure cases: a binary says a paragraph about an experimental feature before every answer it gives, so `--version`
// is not something a person can paste anywhere; or the other way round, every experimental warning is swallowed and
// the next one — about something that is not this program's store — never reaches anybody.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");

/** Runs a line of this program's code with no flags at all, which is what a packaged build is. */
function bare(code: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 60_000 });
}

const hush = `await import(${JSON.stringify(pathToFileURL(join(root, "host", "warnings.ts")).href)});`;

test("没有命令行可用的时候，那一句实验性警告由程序自己关掉", () => {
  const said = `process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");`;
  // 先确认这台 Node 真的会印：不然下面那一条是空过的。
  const loud = bare(said);
  assert.match(loud.stderr, /SQLite/, "这台 Node 连这句都不印，下面那一条就证明不了什么");

  const quiet = bare(hush + said);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stderr, "", `还在印：${quiet.stderr}`);
});

test("只关那一句：别的实验性警告照旧说出来", () => {
  const other = `process.emitWarning("Type stripping is an experimental feature", "ExperimentalWarning");`;
  const done = bare(hush + other);
  assert.match(done.stderr, /Type stripping/, "把所有实验性警告都吞了：下一个新毛病就没人看得到");
  // 其它种类的警告也一样，连 Error 形式传进来的也是。
  const errors = bare(hush + `process.emitWarning(new Error("有话要说"), { type: "DeprecationWarning" });`);
  assert.match(errors.stderr, /有话要说/);
});

test("打包版那条路第一件事就是它：这个程序的每个命令都从 cli/main.ts 进来", () => {
  // 一个模块自己的 import 跑在它的 body 之前，所以写在 host/runtime.ts 的 body 里就太晚了——node:sqlite
  // 那时候已经载完、已经说完了。顺序就是行为，所以钉住它：这一句要排在 cli/main.ts 的第一个 import。
  const main = readFileSync(join(root, "cli", "main.ts"), "utf8");
  const first = main.split("\n").find((line) => line.startsWith("import "));
  assert.equal(first, 'import "../host/warnings.ts";', `cli/main.ts 的第一个 import 是 ${first}`);
});

test("源码模式下这一句什么都不改：命令行上那个 flag 还在", () => {
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(root, "bin", "agent-autoloop.ts"), "--version"],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.stderr, "", `--version 在 stderr 上留了话：${done.stderr}`);
  assert.match(done.stdout, /^agent-autoloop /);
});
