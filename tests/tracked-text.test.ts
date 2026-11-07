// What this repository ships as text has to read as what was meant. Failure cases: a control character written by a
// tool that read `\a`, `\b` or `\e` as an escape sits in a file nobody looks at byte by byte — INSTALL.md said
// `certutil -hashfile .<BEL>gent-autoloop-windows-x64.exe`, which is a command line that cannot be copied and run, and
// no reader, reviewer or renderer shows the difference; a tracked file stops decoding as UTF-8; an icon or a font
// cannot be added at all, or one is added as a zero-byte file that looks right everywhere a person would look; a switch only
// whoever wrote it knows about, because the environment variable it reads was never written down anywhere.
//
// Every character this file is about is written as a code point and never as an escape in a literal: Prettier rewrites
// a unicode escape in a string literal into the character itself, which would put in this very file the thing it
// forbids everywhere else.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * The kinds of file that are not text and are not meant to be: an icon, a picture in the documentation, a font. Adding
 * one is still a decision — it has to be a kind named here — but it is no longer a failure, which is what this test
 * used to make it (phase3-verification-round2.md #7: any tracked binary was an error, deliberately, and that leaves no
 * way to ship a favicon).
 *
 * What is still checked for one is that it is a file at all. A zero-byte image is what a `git add` of a Git-LFS pointer
 * that was never fetched, or a failed download, leaves behind — and it looks exactly like a working one in a diff, in a
 * review and in a renderer, which is the same failure this whole file is about.
 */
const NOT_TEXT = /\.(png|jpg|jpeg|gif|webp|avif|ico|icns|woff|woff2|ttf|otf|eot|pdf|zip|gz|wasm|mp4|webm|mp3|ogg)$/i;

/** What is wrong with one file, as sentences, and nothing where nothing is. `null` for a path that is not there. */
export function troubleWith(folder: string, file: string): string[] | null {
  if (NOT_TEXT.test(file)) {
    // Not read as text, because it is not text. Only that it is a file at all.
    let size: number;
    try {
      size = statSync(join(folder, file)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (size > 0) return [];
    return [
      `${file}: 0 个字节。这个后缀的文件按二进位处理，不查 UTF-8，但不能是空的` +
        `——空的通常是没拉下来的 LFS 指针或者下载失败，而它在 diff、评审和渲染里都和好的一模一样`,
    ];
  }
  let text: string;
  try {
    // Everything else this repository tracks is text. A file that is not, and whose name does not say it is one of the
    // kinds above, decodes to U+FFFD and is reported rather than skipped: adding a binary file to this repository is a
    // decision, not something a test lets through quietly.
    text = readFileSync(join(folder, file), "utf8");
  } catch (error) {
    // A path listed but not here: a case-only rename on Windows, say. Not what this is about.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const wrong: string[] = [];
  if (text.includes(UNDECODED)) {
    wrong.push(`${file}: 不是 UTF-8。真的是二进位就把后缀加进 NOT_TEXT（见上面那段注释）`);
  }
  for (const [i, line] of text.split("\n").entries()) {
    const found = CONTROL.exec(line);
    if (found) wrong.push(`${file}:${i + 1}: ${shown(found[0])}`);
  }
  return wrong;
}

test("被跟踪的文件都是 UTF-8，而且不含 C0 控制字符（制表、换行、回车除外）", () => {
  const files = tracked();
  // A listing that came back empty would make this test pass without looking at anything.
  assert.ok(files.length > 100, `git ls-files 只给了 ${files.length} 个文件`);
  const wrong = files.flatMap((file) => troubleWith(root, file) ?? []);
  assert.deepEqual(wrong, [], `这些文件里有不该有的字符：\n${wrong.join("\n")}`);
});

/**
 * Every `AGENT_AUTOLOOP_*` this program reads has to be written down somewhere a person reads, because one that is not
 * is a switch only whoever wrote it knows about (phase3-verification-round2.md #6: AGENT_AUTOLOOP_TREE_SAMPLE existed
 * only in a comment). The table is INSTALL.md's 「环境变量」 section, with the ones that are handed to a child process
 * rather than set by a person named in the paragraph under it.
 *
 * Read out of the tracked files rather than out of a list here: a list would be the second place to add a name to, and
 * the one that gets forgotten.
 */
test("程序读的每一个 AGENT_AUTOLOOP_ 环境变量都写进了文件", () => {
  const code = tracked().filter((file) => /^(cli|host|kernel|protocol|worker|plugins|bin)\//.test(file));
  const used = new Set<string>();
  for (const file of code) {
    let text: string;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    // Only where it is read or written as a whole name: `AGENT_AUTOLOOP_SECRET_${…}` is one entry in the table and the
    // name it is built into is the source's, not this program's.
    for (const [, name] of text.matchAll(/AGENT_AUTOLOOP_([A-Z][A-Z_]*)\b/g)) used.add(name);
  }
  assert.ok(used.size > 5, `一个都没找到，这条测试就没在看什么（${used.size}）`);
  const written = ["INSTALL.md", "docs/protocol.md", "docs/plugins.md"]
    .map((file) => readFileSync(join(root, file), "utf8"))
    .join("\n");
  // `SECRET_<来源名>` is one entry: the rest of each name is whatever a person called their source, and a plugin that
  // names its own (plugins/<名字>/source.ts) is naming that person's source and not a variable of this program's.
  const missing = [...used]
    .filter((name) => !name.startsWith("SECRET_") && !written.includes(`AGENT_AUTOLOOP_${name}`))
    .sort();
  assert.deepEqual(missing, [], `这些环境变量没有写进文件里（INSTALL.md 的「环境变量」那张表）：${missing.join("、")}`);
});

test("图标、字体这些二进位按后缀放过，但不能是空的", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-tracked-"));
  try {
    // 一个真的图标：不查 UTF-8，所以里面有什么字节都行——它本来就不是字。
    writeFileSync(join(dir, "favicon.ico"), Buffer.from([0, 0, 1, 0, 0xff, 0x07, 0x1b]));
    assert.deepEqual(troubleWith(dir, "favicon.ico"), []);
    // 空的那一个：拉不下来的 LFS 指针、断掉的下载，在 diff 和渲染里都和好的一样。
    writeFileSync(join(dir, "logo.png"), "");
    assert.match(troubleWith(dir, "logo.png")!.join(""), /0 个字节/);
    // 后缀不在名单里的二进位还是错，而且话里说得出该怎么办。
    writeFileSync(join(dir, "blob.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    assert.match(troubleWith(dir, "blob.dat")!.join(""), /不是 UTF-8.*NOT_TEXT/s);
    // 文字文件照旧按行查控制字符，一个字都没变。
    writeFileSync(
      join(dir, "a.md"),
      `一行
两行${String.fromCharCode(7)}
`,
    );
    // 反斜杠本身是拼出来的，不写成转义：Prettier 会把字面量里的转义改回那个字符，而这整份文件禁的正是那个。
    const backslash = String.fromCharCode(92);
    assert.deepEqual(troubleWith(dir, "a.md"), [`a.md:2: BEL（${backslash}a）`]);
    assert.equal(troubleWith(dir, "没有这个文件.md"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
