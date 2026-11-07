// The cost line in `agent-autoloop status`, from /v1/state's completion-time totals. Agents report usage for themselves, or
// don't: a plain command says nothing, and some give tokens but no price. So every figure says how many rounds it leaves out.
import { lang, t } from "../host/i18n.ts";
import type { Spending } from "../host/state.ts";
/**
 * The compact form each language writes: 1.2万 in 简体, 1.2萬 in 正體. A space goes in front of whichever unit this
 * locale used, which is why the units are in the string table too — `Intl` picks them, and the pattern has to be the
 * one it picked from.
 */
const compact = () => new Intl.NumberFormat(lang(), { notation: "compact", maximumFractionDigits: 1 });
const spaced = (amount: number) =>
  compact()
    .format(amount)
    .replace(new RegExp(`(${t("cli.spend.units")})`), " $1");
/** To two places, a day on a cheap model would read as nothing at all. */
const dollars = (amount: number) => (amount > 0 && amount < 0.01 ? "<$0.01" : `$${amount.toFixed(2)}`);

function tally(label: string, { rounds, tokens, cost, missingTokens, missingCost }: Spending) {
  if (!rounds) return t("cli.spend.zero", { label });
  const missing = (silent: number) => (silent ? t("cli.spend.missing", { rounds: silent }) : "");
  const shownTokens =
    missingTokens === rounds
      ? t("cli.spend.noTokens")
      : t("cli.spend.tokens", { amount: spaced(tokens), missing: missing(missingTokens) });
  const shownCost = missingCost === rounds ? t("cli.spend.noCost") : `${dollars(cost)}${missing(missingCost)}`;
  return t("cli.spend.line", { label, rounds, tokens: shownTokens, cost: shownCost });
}

export function spendLine(spending: { today: Spending; week: Spending }) {
  return `${tally(t("cli.spend.today"), spending.today)}    ${tally(t("cli.spend.week"), spending.week)}`;
}
