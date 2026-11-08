// 这个程序带两份手册，一份正體一份简体，而 Agent 读的永远是那个叫 `SKILL.md` 的文件。所以「哪一份被放到那个名字上」
// 这件事是有答案的，而且答案跟着 `agent-autoloop lang`（host/skill.ts）。
//
// 失败的情形：默认（正體）装好之后 Agent 读到的是简体那一份——它是整个产品的操作手册，所以这等于把说明书整本换成
// 另一种中文；切了语言手册不跟着切，下一次 `up` 之后 Agent 还照旧那一份做事；两份手册的段落对不上，一边说的事另一边
// 没有；正體那一份里混进简体字（i18n/zh-TW.ts 有同样一条，手册这边以前谁都没查过）。
//
// 语言在一个进程里只定一次（host/i18n.ts 的 lang() 问一次就记住），所以每一种语言都在自己的子进程里问。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { ASSETS } from "../host/assets.ts";
import { LANGS, type Lang } from "../host/i18n.ts";

const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-skill-lang-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

/** 树里那两份手册，按语言。这张表和 host/skill.ts 的 CARRIED 说的是同一件事，所以下面钉住它们一致。*/
const MANUAL: Record<Lang, string> = {
  "zh-CN": "skills/agent-autoloop/SKILL.md",
  "zh-TW": "skills/agent-autoloop/SKILL.zh-TW.md",
};
const manualText = (which: Lang) => readFileSync(join(root, MANUAL[which]), "utf8");

let homes = 0;
/**
 * 在这种语言下问 host/skill.ts 两个问题：skill 该在哪，放好之后真的在哪。在子进程里问，而且这个进程自己的
 * AGENT_AUTOLOOP_LANG（tests/lang.env 给的）要被这里说的那个盖掉。
 */
function asked(which: Lang, home = join(dir, `home-${++homes}`)) {
  mkdirSync(home, { recursive: true });
  const where = JSON.stringify(pathToFileURL(join(root, "host", "skill.ts")).href);
  const done = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e",
      `const { placeSkill, skillFolder } = await import(${where});
       console.log(JSON.stringify({ folder: skillFolder(), placed: placeSkill() }));`,
    ],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, AGENT_AUTOLOOP_HOME: home, AGENT_AUTOLOOP_LANG: which },
    },
  );
  assert.equal(done.status, 0, done.stderr);
  return { home, ...(JSON.parse(done.stdout) as { folder: string; placed: string }) };
}

test("两份手册都带在打包版里，而且 host/skill.ts 认的就是这两个名字", () => {
  for (const which of LANGS) {
    assert.ok(existsSync(join(root, MANUAL[which])), `树里没有 ${MANUAL[which]}`);
    assert.ok(
      (ASSETS as readonly string[]).includes(MANUAL[which]),
      `${MANUAL[which]} 不在 host/assets.ts 的 ASSETS 里：打包版不会带它，二进位装好就只有另一种中文的手册`,
    );
  }
  // 两份不是同一份：谁要是把文件复制一遍凑数，这一条就红。
  assert.notEqual(manualText("zh-TW"), manualText("zh-CN"));
});

test("简体装的时候 skill 还是树里那个目录，一个字节都不写", () => {
  const { home, folder, placed } = asked("zh-CN");
  assert.equal(folder, join(root, "skills", "agent-autoloop"));
  assert.equal(placed, folder);
  assert.equal(existsSync(join(home, "skills")), false, "简体的源码安装不该往 HOME 里写手册：树里那一份就是它");
});

test("正體装的时候放出来的是正體那一份，放在这个安装自己的 HOME 下", () => {
  // 树里的 `SKILL.md` 是简体的，所以正體那一份只能被写到别处：往 checkout 里写会被 agent-autoloop update 拉掉。
  const { home, folder, placed } = asked("zh-TW");
  assert.equal(folder, join(home, "skills", "agent-autoloop"));
  assert.equal(placed, folder);
  assert.equal(readFileSync(join(folder, "SKILL.md"), "utf8"), manualText("zh-TW"), "放出来的不是正體那一份");

  // 再放一次不会动它：接好的链接要一直是接好的，文件的时间也不该每次启动都变。
  const was = statSync(join(folder, "SKILL.md")).mtimeMs;
  asked("zh-TW", home);
  assert.equal(statSync(join(folder, "SKILL.md")).mtimeMs, was, "又写了一遍");
});

test("切了语言，下一次放的就是新语言那一份：手册跟着这个程序说哪种话", () => {
  // 先按正體放好，再按简体问同一个 HOME——简体的源码安装指回树里，所以这一次换的是「Agent 该读哪个目录」。
  const { home } = asked("zh-TW");
  const written = join(home, "skills", "agent-autoloop", "SKILL.md");
  assert.equal(readFileSync(written, "utf8"), manualText("zh-TW"));
  assert.equal(asked("zh-CN", home).folder, join(root, "skills", "agent-autoloop"));

  // 而反过来，HOME 里留着别的语言那一份时，正體这一次要把它换掉，不是看见有文件就算了。
  writeFileSync(written, manualText("zh-CN"));
  const again = asked("zh-TW", home);
  assert.equal(readFileSync(join(again.folder, "SKILL.md"), "utf8"), manualText("zh-TW"), "旧语言那一份没被换掉");
});

/** 明显只有简体才这样写的字。和 tests/i18n.test.ts 里那张是同一张：那边查两张字符串表，这里查手册。 */
const SIMPLIFIED_ONLY = [..."这个们为么来发过说时对还现开关实单应当长问题见边讲语课"];

/**
 * 正文里的字。围栏代码块、行内代码和链接地址都剥掉：命令、路径和 JSON 两份手册里逐字相同是故意的——它们是要照着打的
 * 东西和要去读的文件名，翻一遍就打不出来、点不开了（README 的锚点 `#拿来即用的场景模板` 就是一个）。
 */
const proseOf = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\]\([^)]*\)/g, "]");

test("正體那一份手册的正文里没有简体字", () => {
  const prose = proseOf(manualText("zh-TW"));
  const found = SIMPLIFIED_ONLY.filter((char) => prose.includes(char));
  assert.deepEqual(found, [], `skills/agent-autoloop/SKILL.zh-TW.md 的正文里有简体字 ${found.join("")}`);
  // 而这条检查确实在看东西：同一段话在简体那一份里是查得出来的。
  assert.ok(
    SIMPLIFIED_ONLY.some((char) => proseOf(manualText("zh-CN")).includes(char)),
    "这条检查什么都没在查",
  );
});

test("两份手册逐段对应：章节标题一样多，围栏代码块一字不差", () => {
  const headings = (text: string) => text.split("\n").filter((line) => /^#{1,6} /.test(line));
  assert.equal(
    headings(manualText("zh-TW")).length,
    headings(manualText("zh-CN")).length,
    "两份手册的章节数不一样：有一边多说或少说了一节",
  );
  // 命令和路径不翻，所以非 JSON 的围栏代码块两边必须一个字节都不差——除了 yaml 里那两个占位（它们是让人替换的话）。
  const fenced = (text: string) => [...text.matchAll(/```(\w*)\n([\s\S]*?)```/g)].map((found) => found[1]);
  assert.deepEqual(fenced(manualText("zh-TW")), fenced(manualText("zh-CN")), "两份手册的代码块对不上");
  // JSON 例子里，键、结构和不带中文的值（真的要照着打的命令、路径）不该不一样；但说给人看的字（name、prompt 这类标签、
  // 连占位路径里的说明文字）两份手册各讲各的中文，翻了才对——所以比较前把汉字都抹掉再比，不解析 JSON（有几块本来就不是
  // 单一合法 JSON：一行一个物件、或裸的 `"key": {…}` 片段，混着 `// 文件名` 这样的注释行）。
  const jsonShape = (body: string): string => body.replace(/[一-鿿]+/g, "…");
  const json = (text: string) => [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((found) => jsonShape(found[1]));
  assert.deepEqual(
    json(manualText("zh-TW")),
    json(manualText("zh-CN")),
    "JSON 例子的结构（键、非中文的值）对不上：照着改的人要能对上位置",
  );
});
