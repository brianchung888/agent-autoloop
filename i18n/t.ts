// 说一句话的那一半：两张表、一个填空、一个取词。不问环境变数、不读磁盘、不看时间，也不记住任何东西。
//
// 为什么要把它从 host/i18n.ts 里分出来：那个文件要问 `AGENT_AUTOLOOP_LANG`、要读 config.json、还要把问出来的
// 答案记在模块里，这三件事内核一件都不许做——`tests/purity.test.ts` 的「时间和熵从外壳传入」钉的就是这个。可是
// 内核照样要说话（卡片上的字、`/v1/*` 的错误、cron 的说法）。所以这里只留纯函数：说哪一种语言是调用端传进来的
// 一个值，跟 `decide()` 的 `now` 和 `env` 完全一样的待遇。host/i18n.ts 包着这个文件，负责决定那个值。
import { zhCN, type Strings } from "./zh-CN.ts";
import { zhTW } from "./zh-TW.ts";

/** 正體 first: it is what this program says when nobody has said otherwise. */
export const LANGS = ["zh-TW", "zh-CN"] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = "zh-TW";

/**
 * 这个程序原本就是用简体写的，i18n/zh-CN.ts 是 key 的事实来源，缺了一条也是回到它。内核那些公开函数把它当
 * `lang` 参数的预设值：少传一个参数就该说原来那些字，不该让内核自己去猜今天这台电脑说哪种话。
 */
export const WRITTEN_LANG: Lang = "zh-CN";

export type Key = keyof Strings;
/** What a sentence is filled in with. Numbers are said by the locale that asked for them, so they arrive as strings. */
export type Params = Record<string, string | number>;

export const TABLES: Record<Lang, Strings> = { "zh-TW": zhTW, "zh-CN": zhCN };

/** `{name}` in a sentence is a name in `params`. One left unfilled stays as it is, so that it can be seen and fixed. */
export function fill(text: string, params?: Params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}

/** The sentence, in the language asked for, with its names filled in. A missing key falls back to 简体. */
export function say(lang: Lang, key: Key, params?: Params): string {
  return fill(TABLES[lang][key] ?? zhCN[key], params);
}

/**
 * The same sentence in every language, for the one case where that is the question being asked: text written down
 * once — a rule's name in `rules.json`, a card's title — and read back later, possibly after the language changed.
 * What was written is one of these, and which one is not worth keeping a record of.
 */
export function sayAny(key: Key, params?: Params): string[] {
  return [...new Set(LANGS.map((one) => fill(TABLES[one][key], params)))];
}
