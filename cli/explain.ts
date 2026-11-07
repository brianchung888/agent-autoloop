// `rules explain` and `emit --dry-run`: what this machine's rules file says, without asking a hub or writing a fact.
import { lang, t } from "../host/i18n.ts";
import { describeCron, nextRun, parseCron } from "../kernel/cron.ts";
import { cronOf, eventRule, typeMatches, type Rule, type Rules } from "../kernel/rules.ts";
import { parseRules } from "../protocol/rules.ts";
import { parseEvent } from "../protocol/validate.ts";

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const clock = (zone: string) =>
  ({ timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) as const;
const when = (rule: Rule, rules: Rules, now: number) =>
  eventRule(rule)
    ? t("cli.explain.whenEvent", { source: rule.when.source, types: rule.when.types.join("、") })
    : t("cli.explain.whenCron", {
        cron: describeCron(cronOf(rule)),
        next: new Date(nextRun(parseCron(cronOf(rule))!, now, rules.timezone)!).toLocaleString(
          lang(),
          clock(rules.timezone),
        ),
      });

function details(rule: Rule, rules: Rules, now: number) {
  const parts = [when(rule, rules, now), `→ ${rule.to}`, rule.cwd];
  if (rule.parallel) parts.push(t("cli.explain.parallel", { n: rule.parallel }));
  if (rule.resume) parts.push(t("cli.explain.resume"));
  if (rule.group !== rule.name) parts.push(t("cli.explain.group", { group: rule.group }));
  if (rule.tell !== "needed") parts.push(t("cli.explain.tell", { tell: rule.tell }));
  if (rule.skill) parts.push(t("cli.explain.hasSkill"));
  if (rule.prompt) parts.push(t("cli.explain.hasPrompt"));
  if (rule.emits) parts.push(t("cli.explain.emits", { source: rule.emits.source, types: rule.emits.types.join("、") }));
  return parts.join(" · ");
}

/** The rules as this machine would run them, one line per thing an owner asks about. */
export function explainRules(text: string, now = Date.now(), zone = localZone()): string[] {
  const rules = parseRules(text, now, zone);
  const lines = [
    t("cli.explain.header", {
      zone: rules.timezone,
      askFirst: rules.askFirst.join("、"),
      count: rules.rules.length,
    }),
    t("cli.explain.sources", {
      list: Object.entries(rules.sources)
        .map(([id, source]) => t("cli.explain.sourceItem", { id, name: source.name }))
        .join("、"),
    }),
    t("cli.explain.agents", {
      list: Object.entries(rules.agents)
        .map(([id, agent]) =>
          t("cli.explain.agentItem", { id, name: agent.name, worker: agent.worker, access: agent.access }),
        )
        .join("、"),
    }),
  ];
  if (Object.keys(rules.channels).length)
    lines.push(
      t("cli.explain.channels", {
        list: Object.entries(rules.channels)
          .map(([id, channel]) => {
            const answerers = channel.answerers?.length
              ? t("cli.explain.answerers", { list: channel.answerers.join("、") })
              : "";
            return t("cli.explain.channelItem", {
              id,
              name: channel.name,
              answerers,
              links: channel.links ? t("cli.explain.withLinks") : "",
            });
          })
          .join("、"),
      }),
    );
  lines.push(t("cli.explain.rulesHeading"));
  for (const rule of rules.rules)
    lines.push(t("cli.explain.ruleLine", { name: rule.name, details: details(rule, rules, now) }));
  for (const task of rules.elsewhere) {
    const answers = task.cwd
      ? t("cli.explain.elsewhereAnswers", { agent: rules.agents[task.to].name, cwd: task.cwd })
      : "";
    lines.push(
      t("cli.explain.elsewhereLine", {
        name: task.name,
        where: task.where,
        cron: describeCron(task.cron),
        answers,
      }),
    );
  }
  return lines;
}

/** What a source event would be handed to, by the rules file alone: no hub, no log, no key. */
export function previewEvent(
  text: string,
  source: string,
  event: unknown,
  now = Date.now(),
  zone = localZone(),
): string[] {
  const rules = parseRules(text, now, zone);
  const parsed = parseEvent(event);
  const lines = [
    `${t("cli.explain.event", { source, type: parsed.type })}${parsed.subject ? ` ${parsed.subject}` : ""}`,
  ];
  if (!rules.sources[source]) lines.push(t("cli.explain.unregisteredSource", { source }));
  const matched = rules.rules.filter(
    (rule) => eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, parsed.type),
  );
  if (!matched.length) {
    lines.push(t("cli.explain.noRule"));
    return lines;
  }
  lines.push(t("cli.explain.willGo"));
  for (const rule of matched) lines.push(t("cli.explain.goesTo", { name: rule.name, to: rule.to, cwd: rule.cwd }));
  return lines;
}
