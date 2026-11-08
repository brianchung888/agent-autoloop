// rules.json: the sources that may send events, the agents that do the work, the channels that reach the owner, the
// rules between them and, only to be shown, the scheduled tasks that run elsewhere. A mistake is caught here with a
// message saying where: at start it stops the hub, later it leaves the old rules running and the owner is told.
//
// Every sentence here is asked for by key (host/i18n.ts), and asked for when it is said rather than when this module
// loads: `lang()` remembers its answer the first time anybody asks, and a sentence existing is not a reason to settle
// that question. Two of these are not sentences but data — the default `askFirst` list and the name of the schedule
// source — and each says below what that means for them.
import { t } from "../host/i18n.ts";
import { nextRun, parseCron } from "../kernel/cron.ts";
import { SCHEDULE, type Rule, type Rules } from "../kernel/rules.ts";

export class RulesError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(t("protocol.rules.badFile", { issues: issues.join("\n") }));
    this.issues = issues;
  }
}

const ACCESS = ["read", "edit", "full"];
const TELLS = ["always", "needed", "never"];
const ID = /^[a-z][a-z0-9-]*$/;
const TYPE_PATTERN = /^(\*|[a-z][a-z0-9_.-]{0,63}(\.\*)?)$/;
/**
 * What an Agent asks about before doing it, when rules.json does not say. This one is not a message but a value: it
 * goes into the rules the hub runs, into `/v1/state` and into the prompt the Agent is given. So it is written in
 * whichever language this install says things in, the way `init` writes a rule's name (cli/try.ts) — and an
 * `askFirst` the owner wrote themselves is never touched, so a rules.json from before is read exactly as it was.
 * Nothing in the program ever compares a line of it back, so there is nothing to match in every language.
 */
const askFirstDefault = () => t("protocol.rules.askFirstDefault").split("、");
const NOT_EMPTY = () => t("protocol.rules.notEmpty");
const ID_WORDS = () => t("protocol.rules.idWords");

type Check = (value: unknown) => boolean;
type Field = [name: string, check: Check, problem: string, optional?: boolean];

const isText: Check = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isWords: Check = (value) => Array.isArray(value) && value.every(isText);
const isSomeWords: Check = (value) => isWords(value) && (value as string[]).length > 0;
const isId: Check = (value) => typeof value === "string" && ID.test(value);
const isCount: Check = (value) => Number.isInteger(value) && (value as number) > 0;
const isTypes: Check = (value) => isSomeWords(value) && (value as string[]).every((type) => TYPE_PATTERN.test(type));
const isCron: Check = (value) => typeof value === "string" && parseCron(value) !== null;
/**
 * A folder is said from its root, so that what it means does not depend on where anything was started from. On Windows
 * a root is a drive or a share, and the separator there is the other one — said only where that is what a path is, so
 * rules written for one kind of machine are not quietly accepted on the other.
 */
const WINDOWS_ROOT = /^([A-Za-z]:[\\/]|\\\\[^\\/]|~\\)/;
const isFolder: Check = (value) =>
  typeof value === "string" && (/^(~\/|\/)/.test(value) || (process.platform === "win32" && WINDOWS_ROOT.test(value)));
const FOLDER = () => (process.platform === "win32" ? t("protocol.rules.folderWin") : t("protocol.rules.folderPosix"));

function isKeyOf(table: object): Check {
  return (value) => typeof value === "string" && value in table;
}

function isZone(zone: unknown) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone as string });
    return isText(zone);
  } catch {
    return false;
  }
}

/** Each field present and well formed, and no others: a misspelt field would otherwise be silently ignored. */
function checkFields(issues: string[], where: string, value: unknown, spec: Field[]) {
  if (!isObject(value)) return void issues.push(t("protocol.rules.whereObject", { where }));
  for (const [name, check, problem, optional] of spec) {
    if (!(name in value)) {
      if (!optional) issues.push(t("protocol.rules.missing", { where, name }));
    } else if (!check(value[name])) issues.push(t("protocol.rules.fieldProblem", { where, name, problem }));
  }
  for (const name of Object.keys(value)) {
    if (!spec.some(([known]) => known === name)) issues.push(t("protocol.rules.unknownField", { where, name }));
  }
}

const nameOf = (entry: unknown) => (isObject(entry) && typeof entry.name === "string" ? entry.name : "");

function checkRule(issues: string[], rules: Rules, rule: Rule, names: Set<string>, now: number) {
  const name = nameOf(rule);
  if (names.has(name)) issues.push(t("protocol.rules.duplicateName", { name }));
  names.add(name);
  const where = t("protocol.rules.ruleWhere", { name });
  const when = isObject(rule) ? rule.when : undefined;
  checkFields(issues, where, rule, [
    ["name", isText, NOT_EMPTY()],
    ["when", isObject, t("protocol.rules.object")],
    ["to", isKeyOf(rules.agents), t("protocol.rules.unknownAgentIs", { to: String(isObject(rule) ? rule.to : "") })],
    ["cwd", isFolder, FOLDER()],
    ["skill", isText, NOT_EMPTY(), true],
    ["prompt", isText, NOT_EMPTY(), true],
    ["group", isText, NOT_EMPTY(), true],
    ["parallel", isCount, t("protocol.rules.count"), true],
    ["resume", (value) => typeof value === "boolean", t("protocol.rules.boolean"), true],
    [
      "tell",
      (value) => TELLS.includes(value as string),
      t("protocol.rules.oneOf", { allowed: TELLS.join("、") }),
      true,
    ],
    ["emits", isObject, t("protocol.rules.object"), true],
    ["channels", isSomeWords, t("protocol.rules.channelList"), true],
  ]);
  if (isObject(when) && "source" in when) {
    checkFields(issues, t("protocol.rules.whenWhere", { where }), when, [
      ["source", isKeyOf(rules.sources), t("protocol.rules.unknownSourceIs", { source: String(when.source) })],
      ["types", isTypes, t("protocol.rules.typeListWild")],
    ]);
  } else if (isObject(when)) {
    if (isCron(when.cron) && nextRun(parseCron(when.cron as string)!, now, rules.timezone) === null) {
      issues.push(t("protocol.rules.cronNever", { where, cron: String(when.cron) }));
    }
    checkFields(issues, t("protocol.rules.whenWhere", { where }), when, [
      ["cron", isCron, t("protocol.rules.badCron")],
    ]);
  }
  if (!isObject(rule)) return;
  // A plain command needs no words: a script that polls something is an agent too.
  if (!rule.skill && !rule.prompt && rules.agents[rule.to]?.use !== "command") {
    issues.push(t("protocol.rules.needWords", { where }));
  }
  if (isObject(rule.emits)) {
    const emittable: Check = (value) => value !== SCHEDULE && isKeyOf(rules.sources)(value);
    checkFields(issues, t("protocol.rules.emitsWhere", { where }), rule.emits, [
      [
        "source",
        emittable,
        t("protocol.rules.unknownSourceIs", { source: String((rule.emits as Record<string, unknown>).source) }),
      ],
      ["types", isTypes, t("protocol.rules.typeList")],
    ]);
  }
  for (const channel of isSomeWords(rule.channels) ? (rule.channels as string[]) : []) {
    if (!Object.hasOwn(rules.channels, channel)) issues.push(t("protocol.rules.unknownChannel", { where, channel }));
  }
  rule.group ??= rule.name;
  rule.tell ??= "needed";
}

export function parseRules(json: string, now: number, timezone: string): Rules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new RulesError([t("protocol.rules.notJson", { why: (error as Error).message })]);
  }
  const issues: string[] = [];
  checkFields(issues, "rules.json ", parsed, [
    ["timezone", isZone, t("protocol.rules.badZone"), true],
    ["askFirst", isWords, t("protocol.rules.wordList"), true],
    ["sources", isObject, t("protocol.rules.object")],
    ["agents", isObject, t("protocol.rules.object")],
    ["channels", isObject, t("protocol.rules.object"), true],
    ["rules", Array.isArray, t("protocol.rules.list")],
    ["elsewhere", Array.isArray, t("protocol.rules.list"), true],
  ]);
  if (issues.length) throw new RulesError(issues);
  const rules = parsed as Rules;
  rules.timezone ??= timezone;
  rules.askFirst ??= askFirstDefault();
  rules.channels ??= {};
  rules.elsewhere ??= [];
  if (SCHEDULE in rules.sources) issues.push(t("protocol.rules.reservedSource", { id: SCHEDULE }));
  for (const [id, source] of Object.entries(rules.sources)) {
    if (!ID.test(id)) issues.push(t("protocol.rules.sourceId", { words: ID_WORDS(), id }));
    checkFields(issues, t("protocol.rules.sourceWhere", { id }), source, [
      ["name", isText, NOT_EMPTY()],
      ["adapter", isText, NOT_EMPTY(), true],
    ]);
  }
  // The hub's own source, named here rather than in rules.json. Like `askFirst` above it is data: it is shown in
  // `rules explain`, in `/v1/state` and in the text of a card, and it is set afresh on every parse, so an install
  // that changes language simply sees the new spelling. Nothing matches on it, only on the id.
  rules.sources[SCHEDULE] = { name: t("protocol.rules.scheduleSource") };
  for (const [id, channel] of Object.entries(rules.channels)) {
    if (!ID.test(id)) issues.push(t("protocol.rules.channelId", { words: ID_WORDS(), id }));
    checkFields(issues, t("protocol.rules.channelWhere", { id }), channel, [
      ["name", isText, NOT_EMPTY()],
      ["answerers", isWords, t("protocol.rules.wordList"), true],
      ["links", (value) => typeof value === "boolean", t("protocol.rules.trueFalse"), true],
    ]);
  }
  for (const [id, agent] of Object.entries(rules.agents)) {
    if (!ID.test(id)) issues.push(t("protocol.rules.agentId", { words: ID_WORDS(), id }));
    checkFields(issues, `Agent ${id} `, agent, [
      ["name", isText, NOT_EMPTY()],
      ["worker", isId, ID_WORDS()],
      ["use", isId, ID_WORDS()],
      ["model", isText, NOT_EMPTY(), true],
      ["effort", isText, NOT_EMPTY(), true],
      [
        "access",
        (value) => ACCESS.includes(value as string),
        t("protocol.rules.oneOf", { allowed: ACCESS.join("、") }),
        true,
      ],
      ["command", isSomeWords, t("protocol.rules.commandList"), !isObject(agent) || agent.use !== "command"],
      ["timeout", isCount, t("protocol.rules.minutes"), true],
    ]);
    if (isObject(agent)) agent.access ??= "edit";
  }
  const names = new Set<string>();
  for (const rule of rules.rules) checkRule(issues, rules, rule, names, now);
  if (issues.length) throw new RulesError(issues);
  const limits = new Map<string, number | undefined>();
  for (const { group, parallel } of rules.rules) {
    if (limits.has(group) && limits.get(group) !== parallel) {
      issues.push(t("protocol.rules.groupParallel", { group }));
    }
    limits.set(group, parallel);
  }
  for (const task of rules.elsewhere) {
    const name = nameOf(task);
    if (names.has(name)) issues.push(t("protocol.rules.taskDuplicate", { name }));
    names.add(name);
    checkFields(issues, t("protocol.rules.taskWhere", { name }), task, [
      ["name", isText, NOT_EMPTY()],
      ["source", isKeyOf(rules.sources), t("protocol.rules.unknownSource")],
      ["to", isKeyOf(rules.agents), t("protocol.rules.unknownAgent")],
      ["cron", isCron, t("protocol.rules.badCron")],
      ["where", isText, NOT_EMPTY()],
      ["cwd", isFolder, FOLDER(), true],
      ["skill", isText, NOT_EMPTY(), true],
      ["prompt", isText, NOT_EMPTY(), true],
    ]);
    if (!isObject(task)) continue;
    // Its answers go on like a round of a rule, so they need what a rule needs.
    const words = task.skill !== undefined || task.prompt !== undefined;
    if (words && task.cwd === undefined) issues.push(t("protocol.rules.taskNeedsCwd", { name }));
    if (task.cwd !== undefined && !words && rules.agents[task.to]?.use !== "command") {
      issues.push(t("protocol.rules.taskNeedsWords", { name }));
    }
  }
  if (issues.length) throw new RulesError(issues);
  return rules;
}
