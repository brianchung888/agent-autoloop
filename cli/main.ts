// The command line: what a person, or their Agent, types.
//
// First of all: `--env-file=` off the front of the arguments (host/env-file.ts). It has to be first because which home
// this is gets decided as host/home.ts loads, and in a packaged build nothing but this program reads that flag.
import "../host/env-file.ts";
// Then, before anything that could reach the runtime's own SQLite: the one warning a packaged build has no
// command line left to turn off (host/warnings.ts). Importing it is what does it, so it comes before everything here.
import "../host/warnings.ts";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { hubClient } from "../protocol/client.ts";
import { parseRules } from "../protocol/rules.ts";
import { CONFIG_FILE, readConfig, writeConfig, type Config } from "../host/config.ts";
import { HOME, RULES_FILE } from "../host/home.ts";
import { anyLang, asLang, lang, LANGS, t, useLang } from "../host/i18n.ts";
import { readManifest, type PluginManifest } from "../host/plugin-manifest.ts";
import { stablePath } from "../host/node-path.ts";
import { desktopTrouble } from "../host/notify.ts";
import { permissionTrouble, secureDir } from "../host/permissions.ts";
import {
  installService,
  removeService,
  restartService,
  serviceNote,
  serviceRunning,
  systemUnit,
} from "../host/service.ts";
// The one spelling of "how to start this program again" (host/self.ts), so a second one here cannot drift from it.
import { fromSource, PROGRAM } from "../host/self.ts";
import { placeSkill } from "../host/skill.ts";
import { versionLine } from "../host/version.ts";
import { spendLine } from "./spend.ts";
import { attemptsOf, newFailure, waitingRetry } from "./try.ts";

const ROOT = path.join(import.meta.dirname, "..");

/**
 * Every word of these is in i18n/ (host/i18n.ts), and each is read when it is said rather than when this module loads:
 * `lang` writes a new language and then has to confirm itself in it, and a function is what makes that one answer
 * instead of two.
 */
const HELP = () => t("cli.help", { home: HOME, rules: RULES_FILE });

/** What each command reads besides its own words, and how to use it. */
const TAKES: Record<string, { flags: string[]; usage: () => string }> = {
  add: { flags: [], usage: () => t("cli.usage.add") },
  answer: { flags: ["text"], usage: () => t("cli.usage.answer") },
  ask: { flags: ["task"], usage: () => t("cli.usage.ask") },
  backup: { flags: [], usage: () => t("cli.usage.backup") },
  check: { flags: [], usage: () => t("cli.usage.check") },
  conformance: { flags: ["config"], usage: () => t("cli.usage.conformance") },
  doctor: { flags: [], usage: () => t("cli.usage.doctor") },
  emit: {
    flags: ["dry-run", "subject", "summary", "detail", "link", "id", "key"],
    usage: () => t("cli.usage.emit"),
  },
  init: { flags: ["agent", "command", "port", "no-service", "lang"], usage: () => t("cli.usage.init") },
  join: { flags: ["worker", "key", "no-service"], usage: () => t("cli.usage.join") },
  key: { flags: [], usage: () => t("cli.usage.key") },
  lang: { flags: [], usage: () => t("cli.usage.lang") },
  mcp: { flags: [], usage: () => t("cli.usage.mcp") },
  // Only its first word is read as anything: the rest is a result in someone's own words, dashes and all.
  resolve: { flags: [], usage: () => t("cli.usage.resolve") },
  restore: { flags: ["yes"], usage: () => t("cli.usage.restore") },
  rules: { flags: [], usage: () => t("cli.usage.rules") },
  service: { flags: [], usage: () => t("cli.usage.service") },
  status: { flags: ["json"], usage: () => t("cli.usage.status") },
  stop: { flags: [], usage: () => t("cli.usage.stop") },
  tell: { flags: ["task"], usage: () => t("cli.usage.tell") },
  try: { flags: [], usage: () => t("cli.usage.try") },
  uninstall: { flags: ["yes"], usage: () => t("cli.usage.uninstall") },
  up: { flags: [], usage: () => t("cli.usage.up") },
  update: { flags: [], usage: () => t("cli.usage.update") },
  why: { flags: ["json"], usage: () => t("cli.usage.why") },
};

type Flags = Record<string, string | true>;

function flags(args: string[]) {
  const named: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) {
      rest.push(args[i]);
      continue;
    }
    const name = args[i].slice(2);
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) named[name] = args[++i];
    else named[name] = true;
  }
  return { named, rest };
}
const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);
/**
 * What `fail` leaves behind. Not `process.exit`: a command that has talked to the hub more than once is still closing
 * those connections, and ending the process outright while more than one of them is makes libuv abort on Windows
 * (uv/src/win/async.c:76 — the exit code is then 127 and what was said is lost). So the words are carried out to the
 * one place that says them, and what is left behind is an exit code.
 */
class Failed extends Error {}

const fail = (words: string): never => {
  throw new Failed(words);
};

/** The end of every command: what went wrong is said once, and the loop is let go of rather than cut short. */
const report = (error: unknown) => {
  console.error(error instanceof Failed ? error.message : ((error as Error)?.message ?? String(error)));
  process.exitCode = 1;
};

/**
 * Stops at a flag the command doesn't read. A misspelt --port would otherwise install with the default in silence, and
 * --help would install at all.
 */
function refuseUnknownFlags(args: string[], { flags: known, usage }: { flags: string[]; usage: () => string }) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  const unknown = Object.keys(flags(args).named).filter((name) => !known.includes(name));
  if (unknown.length)
    fail(`${t("cli.unknownFlags", { flags: unknown.map((name) => `--${name}`).join("、") })}\n\n${usage()}`);
}

const client = (key: string, config = readConfig()) => hubClient(config.url, key);
const ownerClient = (config = readConfig()) => client(config.owner ?? fail(t("cli.noOwnerKey")), config);

/** The first rules of a new install: its agents and one rule to try the whole loop with. */
function starterRules(agents: Record<string, object>, first: string) {
  return {
    sources: { local: { name: t("cli.starter.source") } },
    agents,
    channels: { desktop: { name: t("cli.starter.channel") } },
    rules: [
      {
        name: t("cli.starter.rule"),
        when: { source: "local", types: ["try.*"] },
        to: first,
        cwd: path.join(HOME, "try"),
        prompt: t("cli.starter.prompt"),
      },
    ],
    elsewhere: [],
  };
}

/**
 * Shows the user's Agents how to set it up. Only for the install in its usual place, never over their own.
 *
 * Windows makes a plain link to a folder only for somebody allowed to make one, and a person installing a program of
 * their own usually is not: a junction leads to the same folder and asks nobody. Where even that is refused the folder
 * is copied instead, and which of the two it was is written down — a copy is not a link, and `uninstall` has to know,
 * or what was put there stays there.
 *
 * Nothing here is worth failing an install over: it is how an Agent is told what this program can do, not the program.
 */
const SKILL_WAYS = () => path.join(HOME, "skill-link.json");
type SkillWay = "link" | "copy";

function linkSkill() {
  try {
    if (process.env.AGENT_AUTOLOOP_HOME) return;
    // In a packaged build there is no folder in a tree to link to, so this is also what writes one out (host/skill.ts).
    const skill = placeSkill();
    const ways = readSkillWays();
    for (const agent of [".claude", ".codex"]) {
      if (!existsSync(path.join(homedir(), agent))) continue;
      const link = path.join(homedir(), agent, "skills", "agent-autoloop");
      if (lstatSync(link, { throwIfNoEntry: false })) continue;
      mkdirSync(path.dirname(link), { recursive: true });
      try {
        symlinkSync(skill, link, process.platform === "win32" ? "junction" : undefined);
        ways[agent] = "link";
      } catch (error) {
        if (process.platform !== "win32") throw error;
        cpSync(skill, link, { recursive: true });
        ways[agent] = "copy";
      }
    }
    if (Object.keys(ways).length) {
      writeFileSync(SKILL_WAYS(), `${JSON.stringify(ways, null, 2)}\n`, { mode: 0o600 });
    }
  } catch (error) {
    console.log(t("cli.skillNotLinked", { why: (error as Error).message }));
  }
}

/** How the skill was put in each Agent's folder, as the install last left it. A missing file means: by a link. */
function readSkillWays(): Record<string, SkillWay> {
  try {
    const read = JSON.parse(readFileSync(SKILL_WAYS(), "utf8")) as Record<string, SkillWay>;
    return typeof read === "object" && read !== null && !Array.isArray(read) ? read : {};
  } catch {
    return {};
  }
}

/**
 * What to type to run this program: its name if that's what a shell finds, otherwise where it is. Windows has no
 * `command -v`, and nothing is found by a shell that isn't there — `where.exe` is what answers the same question. A
 * path with a space in it is quoted the way the shell being typed into reads it, which is not the same quote.
 *
 * In a packaged build the executable is the whole of it. There is no entry script to name and no `.ts` on disk to
 * name it with, so telling someone to run one would be telling them to run a file that is not there.
 */
function howToRun() {
  const windows = process.platform === "win32";
  // What a shim or a link would have to lead to for `agent-autoloop` to be this install rather than someone else's.
  const self = fromSource() ? PROGRAM : stablePath(process.execPath);
  const asked = windows
    ? spawnSync("where.exe", ["agent-autoloop"], { encoding: "utf8" })
    : spawnSync("/bin/sh", ["-c", "command -v agent-autoloop"], { encoding: "utf8" });
  // A command that could not be run leaves no output at all, which is not the same as finding nothing.
  const found = (asked.stdout ?? "").trim().split(/\r?\n/)[0]?.trim() ?? "";
  try {
    // On Windows what is on PATH is a shim that names this program rather than a link that leads to it.
    if (found && (windows ? readFileSync(found, "utf8").includes(self) : realpathSync(found) === realpathSync(self)))
      return "agent-autoloop";
  } catch {}
  // In source mode the program itself is a .ts, and Windows reads no shebang: what runs it there is the .cmd beside it.
  const cmd = path.join(ROOT, "bin", "agent-autoloop.cmd");
  const shown = fromSource() && windows && existsSync(cmd) ? cmd : self;
  if (!/\s/.test(shown)) return shown;
  return windows ? `"${shown}"` : `'${shown}'`;
}

/** What was asked for on the command line, or whichever of the usual Agents is installed. */
async function agentsToUse(named: Flags, worker: string) {
  const agents: Record<string, { name: string; worker: string; use: string; command?: string[] }> = {};
  const command = text(named.command);
  if (command) {
    agents.agent = { name: "Agent", worker, use: "command", command: command.split(/\s+/) };
    return agents;
  }
  const wanted = text(named.agent);
  const { adapterFor } = await import("../worker/agents.ts");
  const emptyTurn = {
    prompt: "",
    session: "",
    resume: null,
    cwd: "",
    access: "edit",
    contextFile: "",
    folder: "",
  } as const;
  for (const name of ["claude", "codex"]) {
    if (wanted && wanted !== name) continue;
    const adapter = await adapterFor(name);
    try {
      // An adapter finds its program to build the command line, and throws if it's not there.
      adapter.command(emptyTurn);
      agents[name] = { name: name === "claude" ? "Claude Code" : "Codex", worker, use: name };
    } catch {}
  }
  return agents;
}

async function init(args: string[]) {
  const { named, rest } = flags(args);
  // `init -p 4000` would otherwise install on the default port in silence.
  if (rest.length) return fail(`${t("cli.unknownArgs", { args: rest.join(" ") })}\n\n${t("cli.usage.init")}`);
  if (existsSync(CONFIG_FILE)) return fail(t("cli.alreadyInstalled", { file: CONFIG_FILE }));
  // Before any of this says anything: `--lang` is what it says it in, and what gets written down below.
  const told = text(named.lang);
  const chosen = told === undefined ? undefined : (asLang(told) ?? fail(unknownLang(told)));
  if (chosen) useLang(chosen);
  secureDir(HOME);
  mkdirSync(path.join(HOME, "try"), { recursive: true });
  const hostName = hostname()
    .toLowerCase()
    .replace(/\.local$/, "");
  const worker = hostName.replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "this-machine";
  const agents = await agentsToUse(named, worker);
  if (!Object.keys(agents).length) {
    return fail(t("cli.noAgentFound"));
  }
  const port = text(named.port) ?? "3350";
  const url = `http://127.0.0.1:${port}`;
  const ownRules = !existsSync(RULES_FILE);
  if (ownRules) {
    writeFileSync(RULES_FILE, `${JSON.stringify(starterRules(agents, Object.keys(agents)[0]), null, 2)}\n`);
  }
  const { addKey } = await import("../host/runtime.ts");
  const config: Config = {
    url,
    hub: { listen: `127.0.0.1:${port}`, publicUrl: url },
    worker: { name: worker, key: addKey("worker", worker) },
    source: { name: "local", key: addKey("source", "local") },
    owner: addKey("owner", "owner"),
    ...(chosen && { lang: chosen }),
    // A channel only rules.json knows about, or only this file, would do nothing: it's on only if both are ours to write.
    ...(ownRules && { channels: { desktop: { key: addKey("channel", "desktop") } } }),
  };
  writeConfig(config);
  linkSkill();
  if (!named["no-service"]) installService();
  const names = Object.values(agents).map((agent) => agent.name);
  const reach = ownRules ? `${t("cli.init.channelLine")}\n` : "";
  const run = howToRun();
  const next = named["no-service"] ? t("cli.init.nextNoService", { run }) : t("cli.init.next", { run });
  console.log(t("cli.init.done", { agents: names.join("、"), reach, rules: RULES_FILE, next }));
}

async function join(args: string[]) {
  const { named, rest } = flags(args);
  const [url] = rest;
  const name = text(named.worker);
  const key = text(named.key);
  if (!url || !name || !key) return fail(TAKES.join.usage());
  // Joining another hub must not silently replace this machine's existing hub, worker or owner keys.
  if (existsSync(CONFIG_FILE)) {
    return fail(t("cli.join.already", { file: CONFIG_FILE }));
  }
  writeConfig({ url, worker: { name, key } });
  if (!named["no-service"]) installService();
  const next = named["no-service"] ? t("cli.join.next", { run: howToRun() }) : "";
  console.log(t("cli.join.done", { name, next }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Card = { id: number; kind: string; title: string; text: string; options: string[]; recommend: number | null };

function showCard(card: Card) {
  console.log(`\n【${card.kind === "ask" ? t("cli.card.ask") : t("cli.card.notice")}】#${card.id} ${card.title}`);
  if (card.text) console.log(card.text);
  if (card.kind !== "ask") return;
  card.options.forEach((option, index) => {
    console.log(`  ${index + 1}. ${option}${index === card.recommend ? t("cli.card.recommend") : ""}`);
  });
}

const howToAnswer = (card: Card) =>
  card.kind === "ask"
    ? t("cli.card.howToAnswerAsk", { card: card.id })
    : t("cli.card.howToAnswerNotice", { card: card.id });

async function chooseAt(terminal: ReturnType<typeof createInterface>, card: Card) {
  for (;;) {
    const choice = Number(await terminal.question(`\n${t("cli.choose")}`));
    if (Number.isInteger(choice) && choice >= 1 && choice <= card.options.length) return choice - 1;
    console.log(t("cli.chooseRange", { max: card.options.length }));
  }
}

async function tryIt() {
  const config = readConfig();
  if (!config.source) return fail(t("cli.try.noSourceKey"));
  const owner = ownerClient(config);
  const stamp = Date.now();
  // A hub that can't be reached is said just below, when the event doesn't go through.
  const before = await owner.state().catch(() => ({ runs: [] }));
  const attempts = attemptsOf(before.runs);
  await client(config.source.key, config)
    .event({ id: `try-${stamp}`, type: "try.start", subject: `#${stamp}` })
    .catch((error) => fail(t("cli.try.hubUnreachable", { why: error.message })));
  const retrying = waitingRetry(before.runs);
  if (retrying) {
    const clock = { timeZone: before.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
    const time = new Date(retrying.notBefore).toLocaleString(lang(), clock);
    console.log(t("cli.try.retrying", { error: retrying.error, time }));
  } else console.log(t("cli.try.sent"));
  let asked: number | null = null;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    const state = await owner.state();
    const failed = newFailure(state.runs, attempts);
    if (failed) return fail(t("cli.try.agentFailed", { error: failed.error }));
    if (asked === null) {
      // An agent asking the same thing again lands on the card already open, so this may be from before: it's the one.
      // The prompt that asked for it was written into rules.json when this install was made, in whichever language
      // `init` then said things in: the title starts with that language's word, not today's.
      const card: Card | undefined = state.cards.find(
        (open: Card) =>
          open.kind === "ask" && anyLang("cli.try.cardPrefix").some((prefix) => open.title.startsWith(prefix)),
      );
      if (!card) continue;
      asked = card.id;
      console.log(`\n${t("cli.try.asked")}`);
      showCard(card);
      if (!process.stdin.isTTY) {
        console.log(t("cli.try.answerHint", { how: howToAnswer(card) }));
        return;
      }
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const choice = await chooseAt(terminal, card);
      terminal.close();
      await owner.answer(card.id, { choice });
      console.log(t("cli.try.received"));
      continue;
    }
    const done = state.recentCards.find(
      (card: { id: number; state: string }) => card.id === asked && card.state === "done",
    );
    if (done) {
      console.log(t("cli.try.done", { result: done.result, rules: RULES_FILE }));
      return;
    }
  }
  fail(t("cli.try.timeout"));
}

const RUN_STATES: Record<string, () => string> = {
  claimed: () => t("cli.run.claimed"),
  queued: () => t("cli.run.queued"),
  done: () => t("cli.run.done"),
  nothing: () => t("cli.run.nothing"),
  unknown: () => t("cli.run.unknown"),
  cancelled: () => t("cli.run.cancelled"),
};

async function status(named: Flags) {
  const owner = ownerClient();
  const state = await owner.state();
  if (named.json !== undefined) return console.log(JSON.stringify(state, null, 2));
  const { totals } = state;
  const clock = { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  const at = (iso: string) => new Date(iso).toLocaleString(lang(), { timeZone: state.timezone, ...clock });
  console.log(
    t("cli.status.totals", {
      running: totals.running,
      queued: totals.queued,
      doneToday: totals.doneToday,
      waiting: state.cards.length,
    }),
  );
  console.log(`${spendLine(state.spending)}\n`);
  for (const agent of state.agents) console.log(`${agent.online ? "●" : "○"} ${agent.name}（${agent.worker}）`);
  for (const channel of state.channels) console.log(`${channel.online ? "●" : "○"} ${channel.name}`);
  for (const card of state.cards) {
    showCard(card);
    console.log(howToAnswer(card));
  }
  const timed = [...state.lines.filter((line: { every: string | null }) => line.every), ...state.elsewhere];
  if (timed.length) console.log(`\n${t("cli.status.timed")}`);
  for (const { name, where, every, next } of timed) {
    const place = where ? t("cli.status.elsewhere", { where }) : "";
    console.log(t("cli.status.timedLine", { name, where: place, every, next: at(next) }));
  }
  if (state.recentCards.length) console.log(`\n${t("cli.status.recentCards")}`);
  for (const card of state.recentCards.slice(0, 5)) {
    const chosen = card.choice !== null ? card.options[card.choice] : card.answer;
    console.log(`  #${card.id} ${card.title}：${[chosen, card.result].filter(Boolean).join("。") || card.text}`);
  }
  if (state.runs.length) console.log(`\n${t("cli.status.recentRuns")}`);
  for (const run of state.runs.slice(0, 8)) {
    const shown =
      run.state === "queued" && run.attempts > 0 ? t("cli.run.retrying") : (RUN_STATES[run.state]?.() ?? run.state);
    const outcome = run.summary || run.error;
    console.log(`  #${run.id} ${run.rule} ${shown}${outcome ? `：${outcome}` : ""}`);
  }
  if (state.unrouted.length) console.log(`\n${t("cli.status.unrouted")}`);
  for (const { source, type, subject, summary } of state.unrouted.slice(0, 5)) {
    console.log(`  ${source} ${type} ${subject}${summary ? `：${summary}` : ""}`);
  }
}

async function answer(args: string[]) {
  const { named, rest } = flags(args);
  const card = Number(rest[0]);
  if (!Number.isInteger(card) || card < 1) return fail(TAKES.answer.usage());
  const words = text(named.text);
  const done = await ownerClient().answer(card, {
    ...(rest[1] !== undefined && { choice: Number(rest[1]) - 1 }),
    ...(words && { text: words }),
  });
  console.log(
    !done.changed
      ? t("cli.answer.unchanged")
      : done.state === "closed"
        ? t("cli.answer.closed")
        : t("cli.answer.received"),
  );
}

async function resolve(args: string[]) {
  const [id, ...words] = args;
  const card = Number(id);
  if (!Number.isInteger(card) || card < 1 || !words.length) return fail(TAKES.resolve.usage());
  const { changed } = await ownerClient().resolve(card, words.join(" "));
  console.log(changed ? t("cli.answer.closed") : t("cli.answer.unchanged"));
}

async function doctor() {
  let bad = 0;
  const say = (ok: boolean, words: string) => {
    console.log(`${ok ? "●" : "○"} ${words}`);
    if (!ok) bad += 1;
  };
  /**
   * Something this install does not promise, said so that whoever runs it knows. It is not a red mark — everything
   * works, it just works less than the words elsewhere suggest — and a mark of its own is what says which it is: the
   * same ○ for both would make every degradation read as a fault, and the exit code say otherwise.
   */
  const aside = (words: string) => console.log(`◐ ${words}`);
  say(Number(process.versions.node.split(".")[0]) >= 24, `Node ${process.versions.node}`);
  if (!existsSync(CONFIG_FILE)) return say(false, t("cli.doctor.notInstalled"));
  // Not a red mark: it still runs, and whoever runs it should know what it does not promise about these files.
  const files = permissionTrouble();
  if (files) aside(t("cli.doctor.filePermissions", { why: files }));
  const config = readConfig();
  if (config.hub) {
    try {
      const { channels } = checkRulesFile(RULES_FILE);
      say(true, t("cli.doctor.rules", { file: RULES_FILE }));
      for (const [id, channel] of Object.entries(channels)) {
        // Nobody answers from a desktop notification, and a link goes only to whoever it's sent to.
        if (id !== "desktop" && !channel.links && !channel.answerers) {
          aside(t("cli.doctor.noAnswerers", { channel: channel.name }));
        }
      }
    } catch (error) {
      say(false, (error as Error).message);
    }
  }
  if (serviceRunning()) {
    say(true, t("cli.doctor.serviceRunning"));
    // What this platform's way of keeping it running doesn't promise. Not a red mark: it is there, it just comes back slower.
    const note = serviceNote();
    if (note) aside(note);
  } else if (systemUnit()) say(true, t("cli.doctor.systemService"));
  else say(false, t("cli.doctor.serviceStopped"));
  try {
    const health = await (await fetch(`${config.url}/healthz`, { signal: AbortSignal.timeout(5000) })).json();
    say(health.ok === true, t("cli.doctor.hub", { url: config.url, commit: String(health.commit).slice(0, 12) }));
  } catch (error) {
    say(false, t("cli.doctor.hubUnreachable", { url: config.url, why: (error as Error).message }));
  }
  if (config.owner) {
    try {
      const state = await ownerClient(config).state();
      for (const agent of state.agents) {
        const where = agent.online ? t("cli.doctor.online") : t("cli.doctor.offline");
        say(agent.online, t("cli.doctor.agent", { name: agent.name, worker: agent.worker, state: where }));
        if (agent.worker === config.worker?.name) {
          const { adapterFor } = await import("../worker/agents.ts");
          const problem = await adapterFor(agent.use).then(
            (adapter) => adapter.check?.() ?? null,
            (error) => String(error.message),
          );
          say(!problem, problem ?? t("cli.doctor.agentUsable", { name: agent.name }));
        }
      }
      for (const channel of state.channels) {
        // A channel answering the hub is not the same as a notification arriving. Where this computer has no notifier
        // the cards go down the skipped path, and that is what to say — not a green「在线」。It is not a red mark
        // either: everything else about the install is in order, and `agent-autoloop status` still shows the card.
        const trouble = channel.id === "desktop" ? desktopTrouble() : null;
        if (channel.online && trouble) aside(trouble);
        else
          say(
            channel.online,
            t("cli.doctor.channel", {
              name: channel.name,
              state: channel.online ? t("cli.doctor.online") : t("cli.doctor.offline"),
            }),
          );
      }
      // Named, and really there: a packaged build has it inside itself, and the path it is written out to is the one
      // worth telling someone to read. Writing it is idempotent and only ever under this install's own HOME.
      const manual = path.join(placeSkill(), "SKILL.md");
      if (!state.channels.length) {
        aside(t("cli.doctor.noChannels", { manual }));
      } else if (state.channels.length === 1 && state.channels[0].id === "desktop") {
        const only = desktopTrouble() ? t("cli.doctor.onlyDesktopMuted") : t("cli.doctor.onlyDesktop");
        aside(t("cli.doctor.onlyDesktopTail", { only, manual }));
      }
    } catch (error) {
      say(false, t("cli.doctor.stateUnreadable", { why: (error as Error).message }));
    }
  }
  // Not process.exit: this has talked to the hub more than once, and ending the process outright while more than one
  // of those connections is still closing makes libuv abort on Windows (uv/src/win/async.c:76 — the exit code is then
  // 127 and the report is lost). Nothing is left to do here, so the code is left behind and the loop is let go of.
  if (bad) process.exitCode = 1;
}

/** Only reads the file: checking a draft must not open the hub's database or load the draft into it. */
function checkRulesFile(file: string) {
  let json: string;
  try {
    json = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(
      t("cli.rulesUnreadable", { file, why: (error as NodeJS.ErrnoException).code ?? (error as Error).message }),
    );
  }
  return parseRules(json, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function check(args: string[]) {
  const file = path.resolve(args[0] ?? RULES_FILE);
  checkRulesFile(file);
  console.log(t("cli.check.ok", { file }));
}

async function key(args: string[]) {
  const [action, kind, name] = args;
  if (action === "remove") {
    if (!kind || !name) return fail(t("cli.usage.keyRemove"));
    const { changed } = await ownerClient().removeKey(kind, name);
    console.log(changed ? t("cli.key.removed") : t("cli.key.notThere"));
    return;
  }
  const { addKey, listKeys } = await import("../host/runtime.ts");
  if (action === "list") {
    for (const row of listKeys()) console.log(`${row.kind} ${row.name} ${row.created_at}`);
    return;
  }
  if (action !== "new" || !["source", "worker", "channel", "owner"].includes(kind) || !name) {
    return fail(t("cli.usage.keyNew"));
  }
  console.log(addKey(kind as "source", name));
}

async function emit(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const type = rest[0] ?? fail(TAKES.emit.usage());
  const event = {
    id: text(named.id) ?? randomUUID(),
    type,
    ...(text(named.subject) && { subject: text(named.subject) }),
    ...(text(named.summary) && { summary: text(named.summary) }),
    ...(text(named.detail) && { detail: text(named.detail) }),
    ...(text(named.link) && { link: text(named.link) }),
  };
  if (named["dry-run"] !== undefined) {
    // The hub tells a source by its key, and only the key's own source is known here.
    if (text(named.key)) return fail(t("cli.emit.dryRunWithKey"));
    if (!config.source) return fail(t("cli.emit.noSourceNameForDryRun"));
    const { previewEvent } = await import("./explain.ts");
    console.log(t("cli.emit.preview"));
    for (const line of previewEvent(readFileSync(RULES_FILE, "utf8"), config.source.name, event)) console.log(line);
    return;
  }
  const secret = text(named.key) ?? config.source?.key ?? fail(t("cli.emit.noSourceKey"));
  const answer = await client(secret, config).event(event);
  console.log(answer.routed.length ? t("cli.emit.routed", { to: answer.routed.join("、") }) : t("cli.emit.unrouted"));
}

async function backupCommand(args: string[]) {
  const { rest } = flags(args);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const target = path.resolve(rest[0] ?? path.join(HOME, "backups", stamp));
  const { backup } = await import("./backup.ts");
  const { files } = await backup(HOME, target);
  console.log(t("cli.backup.done", { target, files: files.join("、") }));
}

async function restoreCommand(args: string[]) {
  const { named, rest } = flags(args);
  if (!rest[0]) return fail(t("cli.usage.restore"));
  if (named.yes === undefined) {
    if (!process.stdin.isTTY) return fail(t("cli.restore.needsYes"));
    const answer = await askAtTerminal(t("cli.restore.confirm"));
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log(t("cli.restore.cancelled"));
      return;
    }
  }
  const { restore } = await import("./backup.ts");
  const { safety } = await restore(HOME, path.resolve(rest[0]));
  console.log(t("cli.restore.done", { safety }));
}

async function rulesCommand(args: string[]) {
  const { rest } = flags(args);
  if (rest[0] !== "explain" || rest.length > 1) return fail(TAKES.rules.usage());
  const { explainRules } = await import("./explain.ts");
  for (const line of explainRules(readFileSync(RULES_FILE, "utf8"), Date.now())) console.log(line);
}

async function tell(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const matter = rest[0] ?? fail(TAKES.tell.usage());
  const words = readFileSync(0, "utf8").trim();
  if (!words) return fail(t("cli.tell.empty"));
  const task = text(named.task);
  const secret = task ? config.worker?.key : config.source?.key;
  if (!secret) return fail(task ? t("cli.tell.notWorker") : t("cli.tell.noSourceKey"));
  const answer = await client(secret, config).tell({ key: matter, text: words, ...(task && { task }) });
  console.log(answer.duplicate ? t("cli.tell.duplicate") : t("cli.tell.sent"));
}

async function ask(args: string[]) {
  const { named, rest } = flags(args);
  const task = text(named.task);
  if (!task || rest.length) return fail(TAKES.ask.usage());
  let question: unknown;
  try {
    question = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return fail(t("cli.ask.badJson"));
  }
  const config = readConfig();
  if (!config.worker) return fail(t("cli.tell.notWorker"));
  const answer = await client(config.worker.key, config).tell({ task, ask: question });
  console.log(answer.duplicate ? t("cli.ask.duplicate") : t("cli.ask.asked"));
}

/** A run is named by its number; anything else would reach the hub as /v1/runs/NaN and come back as "没有这个地址". */
function runOf(word: string | undefined, usage: string) {
  const id = Number(word);
  if (word === undefined || !/^[1-9][0-9]*$/.test(word) || !Number.isSafeInteger(id)) return fail(usage);
  return id;
}

async function why(args: string[]) {
  const id = runOf(
    args.find((arg) => !arg.startsWith("--")),
    t("cli.usage.why"),
  );
  const facts = await ownerClient().why(id);
  if (args.includes("--json")) return console.log(JSON.stringify(facts, null, 2));
  const { formatWhy } = await import("./why.ts");
  console.log(formatWhy(id, facts));
}

async function checkConformance(args: string[]) {
  const { named, rest } = flags(args);
  const file = text(named.config) ?? process.env.AGENT_AUTOLOOP_CONFORMANCE;
  if (!rest[0] || !file) return fail(TAKES.conformance.usage());
  const { conformance } = await import("../protocol/conformance.ts");
  console.log(JSON.stringify(await conformance(rest[0], JSON.parse(readFileSync(file, "utf8"))), null, 2));
}

async function stop(args: string[]) {
  const id = runOf(args[0], t("cli.usage.stop"));
  await ownerClient().cancel(id);
  console.log(t("cli.stop.told"));
}

function service(args: string[]) {
  if (args[0] === "install") {
    // Installing over kept data comes here and not to init, and uninstalling took the links away.
    linkSkill();
    return installService();
  }
  if (args[0] === "remove") return removeService();
  fail(TAKES.service.usage());
}

/** A plugin is a folder of its own under this install, named after its repository. */
function addPlugin(args: string[]) {
  const url = args[0] ?? fail(TAKES.add.usage());
  // A bare drive designator is not an address of anything in particular: on Windows `C:` means "wherever this shell
  // happens to be on drive C", so `git clone -- C: …` clones the current folder — and the last part of `C:` is the
  // letter, so it would be cloned under the name `c`. There is no address here to refuse later, only a letter, so it
  // is refused here and the one thing a person can do about it is said.
  if (/^[a-zA-Z]:[\\/]*$/.test(url)) fail(t("cli.add.driveOnly", { url, drive: url[0] }));
  // The last part of wherever it came from: a URL, an SSH address, or a path on this machine — which on Windows is
  // separated by backslashes, and whose drive letter is a colon that is not a separator at all. Every separator there
  // is, then, with the empty parts a trailing one leaves dropped. An address that is nothing but separators has no
  // last part at all: that is a name of "", which is refused below like any other name that cannot be one.
  const name = (
    url
      .split(/[/:\\]/)
      .filter(Boolean)
      .at(-1) ?? ""
  )
    .replace(/\.git$/, "")
    .toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) fail(t("cli.add.badName", { name }));
  mkdirSync(path.join(HOME, "plugins"), { recursive: true });
  const folder = path.join(HOME, "plugins", name);
  const clone = spawnSync("git", ["clone", "--", url, folder], { stdio: "inherit" });
  if (clone.status !== 0) fail(t("cli.add.cloneFailed"));
  console.log(t("cli.add.installed", { name }));
  // Only cloned: nothing of it has run yet. What it says it is, it is worth saying out loud now, because the next
  // thing that happens to a `source` plugin is the hub importing it, which runs it.
  let said: PluginManifest;
  try {
    said = readManifest(folder, name);
  } catch (error) {
    return console.log(t("cli.add.badManifest", { why: (error as Error).message }));
  }
  if (said.runtime === "process") console.log(t("cli.add.isProcess", { entry: said.entry ?? "" }));
  else console.log(t("cli.add.isSource"));
}

/**
 * A job a plugin does itself, run as a child process of this same program: `internal:plugin <名字> [参数…]`. Not in
 * `HELP` — nobody types it; a plugin's `command(turn)` puts it in the command line it hands the worker, so that what
 * starts is this executable and not one of the plugin's own files, which a packaged build has none of.
 *
 * It goes through the loader like everything else, so this file still knows no plugin by name.
 */
async function runPlugin(args: string[]) {
  const [name, ...rest] = args;
  if (!name) return fail(t("cli.usage.internalPlugin"));
  const { loadPlugin } = await import("../host/plugins.ts");
  const plugin = await loadPlugin(name, "agent");
  if (typeof plugin?.main !== "function") fail(t("cli.plugin.noMain", { name }));
  await plugin.main(rest);
}

async function update() {
  // A packaged build has no checkout to pull. What it does instead is fetch the executable the newest Release carries
  // for this platform, check it against the `.sha256` beside it, and put it where this one is — the four steps a
  // person used to be told to do by hand (计划 plan-c 3.7；cli/self-update.ts).
  if (!fromSource()) {
    const { updateBinary } = await import("./self-update.ts");
    const done = await updateBinary();
    if (!done.changed) return console.log(t("cli.update.newest", { to: done.to }));
    // In this order because it is the order it matters in: what is on the disk now, then whether the hub is back.
    const back = done.restarted ? t("cli.update.restarted") : (done.told ?? t("cli.update.upAgain"));
    console.log(t("cli.update.done", { to: done.to, back }));
    if (done.replaced) console.log(t("cli.update.oldKept", { old: done.replaced }));
    return;
  }
  const { updateCode } = await import("./update.ts");
  const { changed, to } = updateCode(ROOT);
  const version = to ? `（${to}）` : "";
  if (!changed) return console.log(t("cli.update.newestSource", { version }));
  const told = restartService();
  console.log(t("cli.update.doneSource", { version, told: told ?? "" }));
}

const unknownLang = (told: string) => t("cli.lang.unknown", { told, allowed: LANGS.join("、") });

/**
 * Which of the two Chinese scripts this install says things in: `lang` with nothing says which, and `lang zh-CN`
 * writes it into config.json. Said back in the new one, which is what `useLang` is for — the answer was settled the
 * first time anything was said, and writing a file does not unsettle it.
 *
 * `AGENT_AUTOLOOP_LANG` comes first of all (host/i18n.ts), so when it is set, what was just written would not be what
 * the next command says: that is worth one line, because otherwise the command looks as if it did nothing.
 */
function langCommand(args: string[]) {
  const { rest } = flags(args);
  if (rest.length > 1) return fail(t("cli.usage.lang"));
  if (!rest.length) return void console.log(t("cli.lang.now", { lang: lang() }));
  const told = asLang(rest[0]) ?? fail(unknownLang(rest[0]));
  writeConfig({ ...readConfig(), lang: told });
  useLang(told);
  console.log(t("cli.lang.changed", { lang: told }));
  const set = process.env.AGENT_AUTOLOOP_LANG;
  if (asLang(set) && asLang(set) !== told) console.log(t("cli.lang.overridden", { env: set! }));
}

async function askAtTerminal(question: string) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(question);
  terminal.close();
  return answer;
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => unknown> = {
  mcp: async () => (await import("./mcp.ts")).mcp(),
  // Internal subcommands: not in HELP, not in TAKES. They are how one executable does what a `.ts` file beside it used
  // to be named for, and `host/self.ts: selfExecutable()` is what puts this program in front of them.
  "internal:plugin": () => runPlugin(args),
  "internal:launch": async () => (await import("../worker/launcher.ts")).launch(args),
  add: () => addPlugin(args),
  init: () => init(args),
  join: () => join(args),
  up: async () => (await import("../host/up.ts")).up(),
  try: () => tryIt(),
  status: () => status(flags(args).named),
  why: () => why(args),
  conformance: () => checkConformance(args),
  answer: () => answer(args),
  resolve: () => resolve(args),
  doctor,
  check: () => check(args),
  rules: () => rulesCommand(args),
  key: () => key(args),
  emit: () => emit(args),
  tell: () => tell(args),
  ask: () => ask(args),
  stop: () => stop(args),
  backup: () => backupCommand(args),
  restore: () => restoreCommand(args),
  update,
  uninstall: async () => {
    const { uninstall } = await import("./uninstall.ts");
    await uninstall(flags(args).named.yes !== undefined, process.stdin.isTTY ? askAtTerminal : null);
  },
  service: () => service(args),
  lang: () => langCommand(args),
  help: () => console.log(HELP()),
  "--help": () => console.log(HELP()),
  "-h": () => console.log(HELP()),
  "--version": () => console.log(versionLine()),
};
if (!command || !commands[command]) {
  console.log(HELP());
  if (command) process.exitCode = 1;
} else {
  Promise.resolve()
    .then(() => {
      if (TAKES[command]) refuseUnknownFlags(command === "resolve" ? args.slice(0, 1) : args, TAKES[command]);
      return commands[command]();
    })
    .catch(report);
}
