// A plugin that is a program of its own, talked to over its standard input and output: one line of JSON in, one line of
// JSON out. For `runtime: "process"` in a plugin's plugin.json (host/plugin-manifest.ts).
//
// The protocol covers the shapes that already exist and nothing more. An agent plugin is four functions — `command`,
// `read`, `link`, `check` (worker/agents.ts) — and a source plugin is one, `(input) => events` (host/server.ts); each
// becomes one call, under its own name, with the same arguments and the same answer. No call is invented, nothing is
// added, and a plugin that does not say it has `link` or `check` does not get one: the hub reads the absence of those
// two, so a stand-in that always had them would change what it does.
//
// Each call is one run of the program: the line goes in on its standard input, the answer comes back on its standard
// output, and the program exits. That is what makes a program in any language able to be one of these — it reads a
// line, prints a line, and is over — and it is what the kinds this covers can afford, being pure translations with
// nothing to keep between calls. An agent's four calls block, because `Adapter` (worker/agents.ts) is read
// synchronously where it is used; a source plugin's calls — `translate` and the `describe` that precedes it — do not,
// because the webhook that reaches them (host/server.ts `adaptWebhook`) is already `async` and so is `loadPlugin`
// (host/plugins.ts) — so waiting on another program is not the hub standing still. A channel is
// not: it is a loop that lives as long as the hub does, so it is not in this (计划第四章 2.6, D8). A channel in another
// language already has a way in that costs it nothing — the hub's own HTTP protocol (host/channels.ts:1-2).
//
// Nothing here goes through a shell. The command line is an array, as everywhere else in this program.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { PluginKind } from "./plugins.ts";

/** What the plugin says it has. Only the two optional ones matter; the required ones are required. */
type Described = { calls?: unknown };

const CALL_TIMEOUT = 30_000;
/** An agent's output is handed to `read` whole, and some of them print a great deal of it. */
const MOST = 32 * 1024 * 1024;

/** What one run of the plugin's program left behind, however it was started: the same four things either way. */
type Ran = { error?: Error; signal: string | null; status: number | null; stdout: string; stderr: string };

/** The options both ways of starting it share, so that a call means the same thing whichever one ran it. */
const where = (folder: string) => ({
  windowsHide: true,
  // Its own folder, so that an argument naming a file of its own is a path the plugin can write down: it cannot
  // know where it was installed, and the folder it was installed in is the one place it can be sure of.
  cwd: folder,
});

/** The one line of JSON the plugin's answer is, read out of what the run left behind. Throws what it said instead. */
function answerOf(name: string, request: Record<string, unknown>, program: string, ran: Ran): unknown {
  if (ran.error) throw new Error(`${name} 插件的程序起不来（${program}）：${ran.error.message}`);
  if (ran.signal) throw new Error(`${name} 插件的程序被 ${ran.signal} 结束了，没有答复 ${request.call}`);
  // The answer is the last line it printed: a program is allowed to say things on the way, and a line of its own is
  // what makes the answer findable without counting what came before it.
  const line = ran.stdout
    .split("\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  if (!line)
    throw new Error(
      `${name} 插件对 ${request.call} 什么都没答（退出码 ${ran.status}）${ran.stderr ? `：${ran.stderr.trim().slice(0, 500)}` : ""}`,
    );
  let answer: { ok?: unknown; value?: unknown; error?: unknown };
  try {
    answer = JSON.parse(line);
  } catch {
    throw new Error(`${name} 插件对 ${request.call} 答的不是一行 JSON：${line.slice(0, 500)}`);
  }
  if (answer.ok !== true) {
    const said = typeof answer.error === "string" && answer.error ? answer.error : `没说原因（${line.slice(0, 200)}）`;
    throw new Error(`${name} 插件说：${said}`);
  }
  return answer.value;
}

/**
 * One run of the plugin's program: a line in, a line out. Throws what the plugin said, or what went wrong instead.
 *
 * This one blocks, because the four calls of an agent plugin are read from where they are called synchronously
 * (worker/agents.ts): `command`, `read`, `link`, `check` are a `Adapter`'s own shape and are not this file's to change.
 */
function ask(name: string, folder: string, argv: string[], request: Record<string, unknown>): unknown {
  const [program, ...args] = argv;
  const ran = spawnSync(program!, args, {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    timeout: CALL_TIMEOUT,
    maxBuffer: MOST,
    ...where(folder),
  });
  return answerOf(name, request, program!, {
    error: ran.error,
    signal: ran.signal,
    status: ran.status,
    stdout: ran.stdout ?? "",
    stderr: ran.stderr ?? "",
  });
}

/**
 * The same run, without blocking the hub while it happens. A source plugin's one call is reached from a webhook
 * (host/server.ts `adaptWebhook`), which is already `async` and awaits what the plugin hands back — so the hub's event
 * loop keeps turning while another program is being waited on, and a slow plugin stops being a stall for everyone.
 *
 * It answers exactly what `ask` would: the same timeout, the same ceiling on output, the same `Ran` read by the same
 * reader. The timeout and the ceiling are spelt out here because `spawn` has neither of its own.
 */
function askLater(name: string, folder: string, argv: string[], request: Record<string, unknown>): Promise<unknown> {
  const [program, ...args] = argv;
  return new Promise<Ran>((settle) => {
    const child = spawn(program!, args, { ...where(folder), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let said = 0;
    let done = false;
    const finish = (ran: Ran) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      settle(ran);
    };
    // What `spawnSync` does on each of these, done by hand: a timeout kills it and is reported as a signal, and more
    // output than the ceiling is an error about the ceiling rather than a truncated answer read as if it were whole.
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ signal: "SIGTERM", status: null, stdout: out, stderr: err });
    }, CALL_TIMEOUT);
    timer.unref?.();
    const take = (text: string, into: "out" | "err") => {
      said += Buffer.byteLength(text);
      if (said > MOST) {
        child.kill("SIGKILL");
        finish({
          error: new Error("stdout maxBuffer length exceeded"),
          signal: null,
          status: null,
          stdout: "",
          stderr: err,
        });
        return;
      }
      if (into === "out") out += text;
      else err += text;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => take(text, "out"));
    child.stderr.on("data", (text: string) => take(text, "err"));
    child.on("error", (error: Error) => finish({ error, signal: null, status: null, stdout: out, stderr: err }));
    child.on("close", (status, signal) => finish({ signal, status, stdout: out, stderr: err }));
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify(request)}\n`);
  }).then((ran) => answerOf(name, request, program!, ran));
}

/** What the plugin said it has, read out of its answer to `describe`. */
function declared(value: Described | null) {
  const calls = Array.isArray(value?.calls)
    ? value.calls.filter((call): call is string => typeof call === "string")
    : [];
  return new Set(calls);
}

/**
 * What the plugin answers `describe` with, which is the one call every one of them has to have.
 *
 * This one blocks, and is only for an agent plugin: its four calls block anyway (`ask` above), so there is nothing
 * here for the hub to gain. A source plugin's `describe` goes the other way — `describeLater`.
 */
function describe(name: string, folder: string, argv: string[]) {
  return declared(ask(name, folder, argv, { call: "describe" }) as Described | null);
}

/**
 * The same question, without the hub standing still for the answer. This is the first run of a source plugin's
 * program, and the first one is the slow one: the plugin may be starting a runtime of its own, and until it has
 * answered, a blocking ask has the hub — the whole of it, `/healthz` included — waiting up to the call timeout.
 *
 * It can be this way because of who asks. A source plugin is reached from a webhook (host/server.ts `adaptWebhook`),
 * which is already `async` and awaits what comes back, and `loadPlugin` (host/plugins.ts) is `async` too — so the one
 * thing that waits here is the request that happened to be first.
 */
function describeLater(name: string, folder: string, argv: string[]) {
  return askLater(name, folder, argv, { call: "describe" }).then((value) => declared(value as Described | null));
}

/**
 * The plugins already made, by `<name>/<kind>`. A source plugin is made once because importing a module caches it:
 * `loadPlugin` is called on every webhook (host/server.ts) and on every tick (worker/agents.ts), and what comes back
 * the second time is the module that was already there. A process plugin has to be the same, or every one of those
 * calls is an extra run of the program just to ask `describe` what it has — one request, two processes, both of them
 * blocking the hub. So it is made once, and that is also what makes it behave as a source plugin does: a plugin
 * changed under a running hub takes effect when the hub is next started, not halfway through.
 */
const made = new Map<string, Promise<unknown>>();

/**
 * The plugin, as the shape its kind is read as. `entry` and `args` come from the manifest, already known to stay
 * inside the plugin's own folder; `describe` is asked here, which is where a process plugin first runs — the same
 * moment a source plugin would first be imported and run, and as with an import, only the first time.
 *
 * What is kept is the making of it rather than the made thing, which is what "only the first time" means when the
 * making is awaited: a second webhook arriving while the first is still waiting on `describe` joins that wait instead
 * of starting the program again.
 */
export function processPlugin(
  name: string,
  kind: PluginKind,
  folder: string,
  entry: string,
  args: readonly string[],
): Promise<unknown> {
  const key = `${name}/${kind}`;
  const already = made.get(key);
  if (already) return already;
  const making = make(name, kind, folder, entry, args);
  made.set(key, making);
  // Only what came out whole is kept. A plugin that threw — no entry, nothing answered, a channel — is asked again
  // next time, so a person who fixes it does not have to restart the hub to find out.
  making.catch(() => {
    if (made.get(key) === making) made.delete(key);
  });
  return making;
}

async function make(
  name: string,
  kind: PluginKind,
  folder: string,
  entry: string,
  args: readonly string[],
): Promise<unknown> {
  if (kind === "channel")
    throw new Error(
      `${name} 是通道插件，现在还不能用 runtime: "process"：通道是和中台一样长命的循环，不是一次一答的翻译。` +
        `用别的语言写通道，直接当独立程序连中台的 HTTP 协议（见 docs/plugins.md 的通道一节），不必经过插件机制。`,
    );
  if (!existsSync(entry)) throw new Error(`${name} 的 plugin.json 指的程序不在：${entry}`);
  const argv = [entry, ...args];
  // Which call this is, last: the webhook's own headers and body are spread in here, and a request that arrives with
  // a `call` of its own would otherwise choose which of the plugin's calls runs.
  if (kind === "source") {
    // Asked, and what it says is read for the same reason an agent's is — a plugin that cannot answer this one is
    // not a plugin, and saying so here is what keeps it out of the cache. A source plugin has only `translate`, so
    // nothing is chosen by the answer; the waiting is what matters, and it is not the hub's.
    await describeLater(name, folder, argv);
    return async (input: unknown) => askLater(name, folder, argv, { ...(input as object), call: "translate" });
  }
  const has = describe(name, folder, argv);
  const adapter: Record<string, unknown> = {
    command: (turn: unknown) => ask(name, folder, argv, { call: "command", turn }),
    read: (stdout: string, code: number | null, stderr: string) =>
      ask(name, folder, argv, { call: "read", stdout, code, stderr }),
  };
  if (has.has("link")) adapter.link = (session: string) => ask(name, folder, argv, { call: "link", session });
  if (has.has("check")) adapter.check = () => ask(name, folder, argv, { call: "check" });
  return adapter;
}
