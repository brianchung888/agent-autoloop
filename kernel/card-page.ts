// The one page there is: a card at its own link, for channels that can only send words. A plain form, so it needs no
// script, no sign-in and nothing else from the hub. An Agent wrote what it shows after reading other people's words:
// all of it is escaped, and the only thing the page may load is its own style.
import { createHash } from "node:crypto";
import type { cardView } from "./query.ts";
import { say, WRITTEN_LANG, type Lang } from "../i18n/t.ts";

const STYLE = `:root{color-scheme:light dark;font:16px/1.6 system-ui,sans-serif}
body{max-width:34rem;margin:0 auto;padding:32px 16px;overflow-wrap:anywhere}
h1{font-size:1.25rem;line-height:1.4;margin:0 0 12px}
p{white-space:pre-wrap;margin:0 0 20px}
form{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}
button,input{font:inherit;min-height:44px;border-radius:8px;border:1px solid GrayText;padding:0 16px;\
background:Canvas;color:CanvasText}
button.best{background:CanvasText;color:Canvas;border-color:CanvasText}
input{flex:1 1 12rem;min-width:0}`;

const STYLE_SHA = createHash("sha256").update(STYLE).digest("base64");
const POLICY =
  `default-src 'none'; style-src 'sha256-${STYLE_SHA}'; ` +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy": POLICY,
};

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escaped = (words: string) => words.replace(/[&<>"']/g, (char) => ENTITIES[char]);

// `lang` on the page is the language it was said in, not a guess: a reader, a spell checker and a browser offering to
// translate all go by it, and a 正體 card announced as 简体 misleads all three.
const shell = (lang: Lang, title: string, content: string) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escaped(title)}</title>` +
  `<style>${STYLE}</style></head><body>${content}</body></html>`;

export const wordsPage = (words: string, lang: Lang = WRITTEN_LANG) => shell(lang, words, `<p>${escaped(words)}</p>`);

export function cardPage(card: ReturnType<typeof cardView>, lang: Lang = WRITTEN_LANG) {
  const words = `<h1>${escaped(card.title)}</h1>${card.text ? `<p>${escaped(card.text)}</p>` : ""}`;
  if (card.state === "open") {
    const focused = card.recommend ?? 0;
    const button = (option: string, index: number) => {
      const best = index === card.recommend ? ' class="best"' : "";
      const focus = index === focused ? " autofocus" : "";
      return `<button name="choice" value="${index}"${best}${focus}>${escaped(option)}</button>`;
    };
    // Its own form: Enter in the box mustn't press the first option.
    // A notice can take a line on how it was handled: optional, and kept with the closing.
    const notice = card.kind === "notice";
    const asked = escaped(say(lang, notice ? "kernel.card.howHandled" : "kernel.card.otherThought"));
    const label = notice ? escaped(say(lang, "kernel.card.handling")) : asked;
    const box = `<input name="text" placeholder="${asked}" aria-label="${label}"${notice ? "" : " required"}>`;
    const send = escaped(say(lang, notice ? "kernel.card.closeWithNote" : "kernel.card.send"));
    const other = `<form method="post">${box}<button>${send}</button></form>`;
    return shell(lang, card.title, `${words}<form method="post">${card.options.map(button).join("")}</form>${other}`);
  }
  const chosen = card.kind === "ask" ? (card.choice !== null ? card.options[card.choice] : card.answer) : null;
  const said = chosen ? say(lang, "kernel.card.chose", { option: chosen }) : "";
  const outcome = [said, card.result ?? ""].filter(Boolean).join("。");
  const note = (text: string) => `<p>${say(lang, "kernel.card.handlingWas", { text: escaped(text) })}</p>`;
  const settled = card.kind === "notice" && card.answer ? note(card.answer) : "";
  return shell(lang, card.title, `${words}${outcome ? `<p>${escaped(outcome)}</p>` : ""}${settled}`);
}
