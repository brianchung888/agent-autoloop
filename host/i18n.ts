// 说哪一种话，是这个文件决定的；每一句话本身在 `i18n/zh-CN.ts`（key 的事实来源，就是这个程序原来那些字）和
// `i18n/zh-TW.ts`（正體，台湾用语）里，取词和填空在 `i18n/t.ts`。
//
// The program is written in Chinese, and there are two of those: 简体 as it was written, 正體 as Taiwan writes it. A
// sentence that is a literal in the middle of a function cannot be the second one as well, so the literals moved out
// to `i18n/zh-CN.ts` word for word — that file is the key set, and the type is read off it, so a key the one table has
// and the other has not is a typecheck failure rather than a sentence that silently comes out in the wrong script.
//
// 为什么取词的那一半在 `i18n/t.ts` 而不在这里：这个文件要问环境、要读磁盘、还要把答案记住，内核一件都不许做
// （`tests/purity.test.ts`）。所以这里只剩「决定说哪一种」，取词是那个纯模块的事，`t()` 是把这两半合起来给
// 外壳用的那一个函数——内核不用它，内核拿到的是调用端传进去的 `lang`。
//
// Why `AGENT_AUTOLOOP_LANG` first and the environment's own `LANG` last: the first is this program being told, by a
// person or by its own `lang` command's config, and the last is a guess from a machine that was set up for something
// else. A test suite therefore sets the first and nothing it runs can be surprised by the second. And why `config.json`
// is read here with `readFileSync` rather than through host/config.ts: that file says its own troubles in words, which
// are these words, and a module cannot be the thing it reads from.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_LANG, say, sayAny, type Key, type Lang, type Params } from "../i18n/t.ts";

export { DEFAULT_LANG, LANGS, TABLES, WRITTEN_LANG, type Key, type Lang, type Params } from "../i18n/t.ts";

/**
 * One of the two, from however it was spelt. A tag names a script more often than it names a place — `zh-Hant` is the
 * one that matters and `zh-Hans` the other — so the script is looked for first and the place only after, which is what
 * makes `zh-HK` and `zh-MO` 正體 and a bare `zh` 简体. Anything else is not one of these two and answers nothing, so
 * that the next place to look still gets asked.
 */
export function asLang(told: string | undefined | null): Lang | undefined {
  if (!told) return undefined;
  // POSIX spells a locale `zh_TW.UTF-8`; a BCP 47 tag spells it `zh-TW`. Both are read, and case means nothing.
  const tag = told.trim().toLowerCase().replace(/[_]/g, "-").split(".")[0].split("@")[0];
  if (!/^zh\b/.test(tag) && tag !== "zh") return undefined;
  if (/\bhant\b/.test(tag)) return "zh-TW";
  if (/\bhans\b/.test(tag)) return "zh-CN";
  if (/\b(tw|hk|mo)\b/.test(tag)) return "zh-TW";
  return "zh-CN";
}

/**
 * Where this install's config.json is, worked out at the moment it is read and not when this module loads — and
 * deliberately not `HOME` from host/home.ts, though that is the same two lines.
 *
 * Which home this is gets settled the instant host/home.ts loads, on purpose: everything downstream of it is then
 * talking about one place. But this module is loaded by *anything that says anything*, which is nearly every file
 * here — so importing host/home.ts from it would settle that question as a side effect of a sentence existing,
 * before whatever is about to choose a home has run (tests/helpers.ts chooses one after its imports; a test that
 * reached the real `~/.agent-autoloop` instead would be writing in somebody's install). Asked here instead, at the
 * one moment it is needed, and only ever read from. tests/i18n.test.ts pins the absence of that import.
 */
const configFile = () =>
  path.join(path.resolve(process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), ".agent-autoloop")), "config.json");

/** `lang` in config.json, read on its own: this is what the rest of the program says its own troubles with. */
function langInConfig(): Lang | undefined {
  try {
    const read = JSON.parse(readFileSync(configFile(), "utf8")) as { lang?: string };
    return asLang(read?.lang);
  } catch {
    return undefined;
  }
}

let chosen: Lang | undefined;

/**
 * Which of the two this install says things in. Asked once and remembered: it is read for every sentence, and the
 * answer cannot change under a running command — `useLang` is how a command that just wrote a new one says so.
 *
 * 内核拿不到这个函数，是故意的：它得由调用端当一个值传进去（`decide()`、`createHandler()`、`describeCron()`
 * 都收一个 `lang`），不然内核的输出就跟着这台电脑的环境变数和磁盘上的 config.json 变了。
 */
export function lang(): Lang {
  if (chosen) return chosen;
  chosen =
    asLang(process.env.AGENT_AUTOLOOP_LANG) ??
    langInConfig() ??
    asLang(process.env.LC_ALL) ??
    asLang(process.env.LC_MESSAGES) ??
    asLang(process.env.LANG) ??
    DEFAULT_LANG;
  return chosen;
}

/** Say things in this one from here on. For the `lang` command, which has to confirm itself in the new one. */
export function useLang(told: Lang | undefined) {
  chosen = told;
}

/** The sentence, in this install's language, with its names filled in. */
export function t(key: Key, params?: Params): string {
  return say(lang(), key, params);
}

/**
 * The same sentence in every language, for the one case where that is the question being asked: text written down
 * once — a rule's name in `rules.json`, a card's title — and read back later, possibly after the language changed.
 * What was written is one of these, and which one is not worth keeping a record of.
 */
export function anyLang(key: Key, params?: Params): string[] {
  return sayAny(key, params);
}
