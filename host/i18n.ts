// Every sentence a person reads, in one place per language, and one way of asking for it.
//
// The program is written in Chinese, and there are two of those: 简体 as it was written, 正體 as Taiwan writes it. A
// sentence that is a literal in the middle of a function cannot be the second one as well, so the literals moved out
// to `i18n/zh-CN.ts` word for word — that file is the key set, and the type below is read off it, so a key the one
// table has and the other has not is a typecheck failure rather than a sentence that silently comes out in the wrong
// script. Whichever is asked for, something is always said: a missing key falls back to 简体 rather than to the key.
//
// Why `AGENT_AUTOLOOP_LANG` first and the environment's own `LANG` last: the first is this program being told, by a
// person or by its own `lang` command's config, and the last is a guess from a machine that was set up for something
// else. A test suite therefore sets the first and nothing it runs can be surprised by the second. And why `config.json`
// is read here with `readFileSync` rather than through host/config.ts: that file says its own troubles in words, which
// are these words, and a module cannot be the thing it reads from.
import { readFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "./home.ts";
import { zhCN, type Strings } from "../i18n/zh-CN.ts";
import { zhTW } from "../i18n/zh-TW.ts";

/** 正體 first: it is what this program says when nobody has said otherwise. */
export const LANGS = ["zh-TW", "zh-CN"] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = "zh-TW";

export type Key = keyof Strings;
/** What a sentence is filled in with. Numbers are said by the locale that asked for them, so they arrive as strings. */
export type Params = Record<string, string | number>;

export const TABLES: Record<Lang, Strings> = { "zh-TW": zhTW, "zh-CN": zhCN };

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

/** `lang` in config.json, read on its own: this is what the rest of the program says its own troubles with. */
function langInConfig(): Lang | undefined {
  try {
    const read = JSON.parse(readFileSync(path.join(HOME, "config.json"), "utf8")) as { lang?: string };
    return asLang(read?.lang);
  } catch {
    return undefined;
  }
}

let chosen: Lang | undefined;

/**
 * Which of the two this install says things in. Asked once and remembered: it is read for every sentence, and the
 * answer cannot change under a running command — `useLang` is how a command that just wrote a new one says so.
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

/** `{name}` in a sentence is a name in `params`. One left unfilled stays as it is, so that it can be seen and fixed. */
function fill(text: string, params?: Params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** The sentence, in this install's language, with its names filled in. */
export function t(key: Key, params?: Params): string {
  return fill(TABLES[lang()][key] ?? zhCN[key], params);
}

/**
 * The same sentence in every language, for the one case where that is the question being asked: text written down
 * once — a rule's name in `rules.json`, a card's title — and read back later, possibly after the language changed.
 * What was written is one of these, and which one is not worth keeping a record of.
 */
export function anyLang(key: Key, params?: Params): string[] {
  return [...new Set(LANGS.map((one) => fill(TABLES[one][key], params)))];
}
