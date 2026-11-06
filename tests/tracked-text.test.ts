// What this repository ships as text has to read as what was meant. Failure cases: a control character written by a
// tool that read `\a`, `\b` or `\e` as an escape sits in a file nobody looks at byte by byte — INSTALL.md said
// `certutil -hashfile .<BEL>gent-autoloop-windows-x64.exe`, which is a command line that cannot be copied and run, and
// no reader, reviewer or renderer shows the difference; a tracked file stops decoding as UTF-8.
//
// Every character this file is about is written as a code point and never as an escape in a literal: Prettier rewrites
// a unicode escape in a string literal into the character itself, which would put in this very file the thing it
// forbids everywhere else.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { skipUnless } from "./helpers.ts";

const root = join(import.meta.dirname, "..");

/** `git` is how "tracked" is asked: node_modules and whatever else is lying about are not this project's text. */
const onPath = () => {
  const ran = spawnSync("git", ["--version"], { stdio: "ignore" });
  return !ran.error && ran.status === 0;
};
const test = skipUnless(onPath(), "这份测试问 git 哪些文件是被跟踪的，PATH 上没有 git");

/** Tab, newline and carriage return are what a line of text is made of; nothing else below a space is. */
const ALLOWED = new Set([9, 10, 13]);
/** Everything C0 but those three, plus DEL. */
const FORBIDDEN = [...Array(32).keys(), 127].filter((code) => !ALLOWED.has(code));
const CONTROL = new RegExp(`[${FORBIDDEN.map((code) => `\\u{${code.toString(16)}}`).join("")}]`, "u");

/** How to show one in an error: a name where there is one, else the code point. */
const NAMES = new Map([
  [7, "BEL（\\a）"],
  [8, "BS（\\b）"],
  [27, "ESC（\\e）"],
]);
const shown = (char: string) => {
  const code = char.codePointAt(0)!;
  return NAMES.get(code) ?? `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
};

/** What `-z` separates paths with, and what a byte that did not decode became. Built, not written: see the top. */
const NUL = String.fromCharCode(0);
const UNDECODED = String.fromCharCode(0xfffd);

const tracked = () =>
  execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    .split(NUL)
    .filter(Boolean);

test("被跟踪的文件都是 UTF-8，而且不含 C0 控制字符（制表、换行、回车除外）", () => {
  const files = tracked();
  // A listing that came back empty would make this test pass without looking at anything.
  assert.ok(files.length > 100, `git ls-files 只给了 ${files.length} 个文件`);
  const wrong: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      // Everything this repository tracks is text. A file that is not decodes to U+FFFD and is reported here rather
      // than skipped: adding a binary file to this repository is a decision, not something a test lets through quietly.
      text = readFileSync(join(root, file), "utf8");
    } catch (error) {
      // A path listed but not here: a case-only rename on Windows, say. Not what this is about.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (text.includes(UNDECODED)) wrong.push(`${file}: 不是 UTF-8`);
    for (const [i, line] of text.split("\n").entries()) {
      const found = CONTROL.exec(line);
      if (found) wrong.push(`${file}:${i + 1}: ${shown(found[0])}`);
    }
  }
  assert.deepEqual(wrong, [], `这些文件里有不该有的字符：\n${wrong.join("\n")}`);
});
