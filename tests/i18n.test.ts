// 这个程序说哪种中文。失败的情形：谁都没说的时候说出了简体；切了语言没有切；两张表的 key 对不上；
// 一句给人看的话绕过 t() 写死在代码里；正體那张表里混进了简体字。
//
// 这份文件和别的测试相反：别的测试都在 AGENT_AUTOLOOP_LANG=zh-CN 底下跑（tests/lang.env、tests/helpers.ts），
// 因为它们断言的是这个程序原来那些字；这里要看的正是「没人说的时候说什么」，所以每一条自己说清楚它给的是
// 什么环境，而且都在子进程里问——语言在一个进程里只定一次（host/i18n.ts 的 lang() 问一次就记住）。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { asLang, DEFAULT_LANG, LANGS } from "../host/i18n.ts";
import { zhCN } from "../i18n/zh-CN.ts";
import { zhTW } from "../i18n/zh-TW.ts";

const root = join(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-i18n-"));
after(() => rmSync(dir, { recursive: true, force: true }));

let homes = 0;
/** A home of its own, with whatever config.json this case is about — or none at all. */
function home(config?: object) {
  const place = join(dir, `home-${++homes}`);
  mkdirSync(place, { recursive: true });
  if (config) writeFileSync(join(place, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  return place;
}

/**
 * One command, in a process whose environment is exactly what this case says. Not `{ ...process.env }`: the whole
 * point of most of these is a variable *not* being set, and this suite's own run has it set.
 */
function run(args: string[], place: string, environment: Record<string, string> = {}) {
  const done = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(root, "bin", "agent-autoloop.ts"), ...args],
    {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32" && {
          SystemRoot: process.env.SystemRoot ?? "",
          windir: process.env.windir ?? "",
          TEMP: process.env.TEMP ?? "",
          USERPROFILE: process.env.USERPROFILE ?? "",
          USERNAME: process.env.USERNAME ?? "",
        }),
        HOME: process.env.HOME ?? "",
        AGENT_AUTOLOOP_HOME: place,
        AGENT_AUTOLOOP_RULES: join(place, "rules.json"),
        ...environment,
      },
    },
  );
  return `${done.stdout ?? ""}${done.stderr ?? ""}`;
}

test("谁都没说的时候说正體：help、doctor 和 init 的用法都是", () => {
  const place = home();
  const help = run(["help"], place);
  assert.match(help, /Agent 自動化中台/, help);
  assert.doesNotMatch(help, /自动化/, help);
  assert.match(run(["doctor"], place), /還沒裝好：執行 agent-autoloop init/);
  assert.match(run(["init", "--help"], place), /用法：agent-autoloop init/);
  assert.match(run(["init", "--help"], place), /這個程式說哪種中文/);
});

test("AGENT_AUTOLOOP_LANG 说了就按它说的，两边都试", () => {
  const place = home();
  assert.match(run(["help"], place, { AGENT_AUTOLOOP_LANG: "zh-CN" }), /Agent 自动化中台/);
  assert.match(run(["help"], place, { AGENT_AUTOLOOP_LANG: "zh-TW" }), /Agent 自動化中台/);
  // 认得 POSIX 的写法和带编码的写法，也认得按文字系统写的那种。
  for (const told of ["zh_TW.UTF-8", "zh-Hant", "zh-HK"])
    assert.match(run(["help"], place, { AGENT_AUTOLOOP_LANG: told }), /自動化/, told);
  for (const told of ["zh_CN.UTF-8", "zh-Hans", "zh"])
    assert.match(run(["help"], place, { AGENT_AUTOLOOP_LANG: told }), /自动化/, told);
});

test("config.json 的 lang 排在环境的 LANG 前面，AGENT_AUTOLOOP_LANG 排在它前面", () => {
  const said = home({ url: "http://127.0.0.1:3350", lang: "zh-CN" });
  // config.json 说简体，环境的 LANG 说正體：按 config.json。
  assert.match(run(["help"], said, { LANG: "zh_TW.UTF-8" }), /自动化/);
  // 而 AGENT_AUTOLOOP_LANG 盖得过 config.json。
  assert.match(run(["help"], said, { AGENT_AUTOLOOP_LANG: "zh-TW" }), /自動化/);
  // 什么都没写的时候才看环境那一层，再往下才是默认。
  const nothing = home();
  assert.match(run(["help"], nothing, { LANG: "zh_CN.UTF-8" }), /自动化/);
  assert.match(run(["help"], nothing, { LC_ALL: "zh_CN.UTF-8" }), /自动化/);
  assert.match(run(["help"], nothing, { LANG: "en_US.UTF-8" }), /自動化/);
});

test("不是这两种中文的说法一概不算，接着问下一层", () => {
  for (const told of ["", "   ", "en", "en-US", "ja-JP", "ko", "nonsense"]) assert.equal(asLang(told), undefined, told);
  assert.equal(asLang(undefined), undefined);
  assert.equal(DEFAULT_LANG, "zh-TW");
  assert.deepEqual([...LANGS], ["zh-TW", "zh-CN"]);
});

test("lang 这个命令：不带参数说现在说哪种，带参数写进 config.json 并当场改口", () => {
  const place = home({ url: "http://127.0.0.1:3350" });
  assert.match(run(["lang"], place), /現在說的是 zh-TW。/);
  assert.match(run(["lang", "zh-CN"], place), /以后说 zh-CN。/);
  const written = JSON.parse(readFileSync(join(place, "config.json"), "utf8"));
  assert.equal(written.lang, "zh-CN");
  // 写下来了，下一个命令就按它说。
  assert.match(run(["help"], place), /自动化/);
  assert.match(run(["lang"], place), /现在说的是 zh-CN。/);
  assert.match(run(["lang", "zh-TW"], place), /以後說 zh-TW。/);
  assert.equal(JSON.parse(readFileSync(join(place, "config.json"), "utf8")).lang, "zh-TW");
  // 别的设置一个都不许动。
  assert.equal(JSON.parse(readFileSync(join(place, "config.json"), "utf8")).url, "http://127.0.0.1:3350");
});

test("lang 写下来了，但 AGENT_AUTOLOOP_LANG 还盖着：这件事要说出来，不然看着像没生效", () => {
  const place = home({ url: "http://127.0.0.1:3350" });
  const said = run(["lang", "zh-CN"], place, { AGENT_AUTOLOOP_LANG: "zh-TW" });
  assert.match(said, /AGENT_AUTOLOOP_LANG/);
  // 这一句跟着刚写下的那种话说，所以这里是简体的那个写法。
  assert.match(said, /盖得过 config.json/);
});

test("不认得的语言不写进去，也说清楚只能写哪两个", () => {
  const place = home({ url: "http://127.0.0.1:3350" });
  const said = run(["lang", "klingon"], place);
  assert.match(said, /klingon/);
  assert.match(said, /zh-TW、zh-CN/);
  assert.equal(JSON.parse(readFileSync(join(place, "config.json"), "utf8")).lang, undefined);
});

test("init --lang 写进 config.json，而且那一次的输出就已经是那种话", () => {
  const place = home();
  // 这台电脑上有没有 Agent 不一定，所以给一个 --command：init 要么装好，要么只说没找到 Agent。
  const said = run(["init", "--command", "x {prompt}", "--no-service", "--lang", "zh-CN"], place);
  assert.match(said, /装好了。|已经装过了/, said);
  assert.equal(JSON.parse(readFileSync(join(place, "config.json"), "utf8")).lang, "zh-CN");
  const other = home();
  assert.match(run(["init", "--command", "x {prompt}", "--no-service", "--lang", "klingon"], other), /klingon/);
});

test("两张表的 key 一模一样，一个不多一个不少", () => {
  const cn = Object.keys(zhCN).sort();
  const tw = Object.keys(zhTW).sort();
  assert.deepEqual(
    tw,
    cn,
    `正體少了：${cn.filter((k) => !tw.includes(k))}；多了：${tw.filter((k) => !cn.includes(k))}`,
  );
  assert.ok(cn.length > 200, `只有 ${cn.length} 条，像是漏搬了`);
});

test("每一条都有字，而且 `{名字}` 两边一样：填不进去的占位就是说漏了一个值", () => {
  const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((found) => found[1]).sort();
  for (const key of Object.keys(zhCN) as (keyof typeof zhCN)[]) {
    assert.ok(zhCN[key].trim(), `zh-CN 的 ${key} 是空的`);
    assert.ok(zhTW[key].trim(), `zh-TW 的 ${key} 是空的`);
    assert.deepEqual(holes(zhTW[key]), holes(zhCN[key]), `${key} 的占位对不上`);
  }
});

/** 明显只有简体才这样写的字。两边都有的写法（比如「后」）不列，不然全是假警报。 */
const SIMPLIFIED_ONLY = [..."这个们为么来发过说时对还现开关实单应当长问题见边讲语课"];

test("正體那张表里没有简体字", () => {
  for (const key of Object.keys(zhTW) as (keyof typeof zhTW)[]) {
    const found = SIMPLIFIED_ONLY.filter((char) => zhTW[key].includes(char));
    assert.deepEqual(found, [], `zh-TW 的 ${key} 里有简体字 ${found.join("")}：${zhTW[key]}`);
  }
});

/**
 * 给人看的话写死在代码里，这几个文件是故意的，别的都不行。每一条都要说清为什么，而且这张表自己也被钉住：
 * 哪天那个文件里的汉字搬干净了，这里要跟着删，不然它就成了一张谁都不看的通行证。
 */
const WRITTEN_IN = {
  // tests/warnings.test.ts 钉住了「host/env-file.ts 自己不 import 任何东西」：它要排在那句关警告的前面，
  // 所以它连 t() 都不能 import，那一句话只能留在原地。
  "host/env-file.ts": "这个文件一个 import 都不许有",
  // 交给 Agent 的提示词和回执协议，不是给人看的界面：第一行结论那两个词（没跑成、没事可做）是被解析的。
  "worker/contract.ts": "这是发给 Agent 的提示词和它答复的协议",
  "plugins/codex/agent.ts": "这一段是发给 Agent 的提示词",
  // 卡片上那个选项是中台自己给的（kernel/query.ts），中台没有跟着翻，所以这里比的还是它给的那个词。
  "plugins/webhook/channel.ts": "比的是中台给的选项文字，不是这里说的话",
  // 交付这一套是一份业务配方：它的话发到 GitHub 的提交状态和它自己的审查提示词里，不是这个程序的界面。
  "plugins/delivery": "业务配方，话是发给 GitHub 和审查用的 Agent 的",
} as const;

/** 一个文件里的代码，注释都去掉。够用就好：这里要找的是字面量里的汉字。 */
function codeOf(text: string) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line.replace(/\/\/[^"'`]*$/, "")))
    .join("\n");
}

const HAN = /\p{Script=Han}/u;

test("cli、host、worker、plugins 里没有绕过 t() 的汉字", () => {
  const bypassing: string[] = [];
  for (const folder of ["cli", "host", "worker", "plugins"]) {
    for (const name of readdirSync(join(root, folder), { recursive: true }).map(String)) {
      if (!name.endsWith(".ts")) continue;
      const file = `${folder}/${name.replaceAll("\\", "/")}`;
      if (Object.keys(WRITTEN_IN).some((allowed) => file === allowed || file.startsWith(`${allowed}/`))) continue;
      const code = codeOf(readFileSync(join(root, folder, name), "utf8"));
      for (const [at, line] of code.split("\n").entries())
        if (HAN.test(line)) bypassing.push(`${file}:${at + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(bypassing, [], `这些话没有走 i18n/：\n${bypassing.join("\n")}`);
});

test("那张通行证上的每一个文件确实还有汉字：搬完了就该把它删掉", () => {
  for (const [where, why] of Object.entries(WRITTEN_IN)) {
    const files = where.endsWith(".ts")
      ? [where]
      : readdirSync(join(root, where), { recursive: true })
          .map(String)
          .filter((name) => name.endsWith(".ts"))
          .map((name) => `${where}/${name.replaceAll("\\", "/")}`);
    const still = files.some((file) => HAN.test(codeOf(readFileSync(join(root, file), "utf8"))));
    assert.ok(still, `${where}（${why}）里已经没有汉字了：把它从 WRITTEN_IN 里删掉`);
  }
});

test("host/i18n.ts 不碰 host/home.ts：说一句话不许顺手把「哪个 HOME」定下来", () => {
  // 哪个 HOME 是 host/home.ts 加载那一刻定下来的，这是故意的。而这个模块是「凡是要说话的文件」都会加载的，
  // 所以它一 import host/home.ts，那个问题就会被一句话的存在提前定死——tests/helpers.ts 是在 import 之后才
  // 选 HOME 的，于是一份测试会跑到真正的 ~/.agent-autoloop 里去写东西。实际发生过一次。
  const words = readFileSync(join(root, "host", "i18n.ts"), "utf8");
  assert.doesNotMatch(words, /^import .*\.\/home\.ts/m, "host/i18n.ts import 了 host/home.ts");
  // 它只许 import 这几样：三个 node: 模块和取词那个纯模块（两张表在它后面）。多一个就可能顺着那条路又摸到
  // host/home.ts。
  const imported = [...words.matchAll(/^import .* from "([^"]+)";$/gm)].map((found) => found[1]).sort();
  assert.deepEqual(imported, ["../i18n/t.ts", "node:fs", "node:os", "node:path"]);
  // 而取词那个纯模块只许 import 两张表：内核 import 的是它，它一碰 node: 就把环境和磁盘带进内核了
  // （tests/purity.test.ts 的「时间和熵从外壳传入」）。
  const pure = readFileSync(join(root, "i18n", "t.ts"), "utf8");
  const inPure = [...pure.matchAll(/^import .* from "([^"]+)";$/gm)].map((found) => found[1]).sort();
  assert.deepEqual(inPure, ["./zh-CN.ts", "./zh-TW.ts"]);
});

test("标点不算：顿号和冒号两种中文一样写，所以它们留在代码里不是漏翻", () => {
  for (const mark of [..."、：（）。，；「」【】…"]) assert.doesNotMatch(mark, HAN, mark);
});
