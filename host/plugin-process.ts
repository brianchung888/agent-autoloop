// A plugin that is a program of its own, talked to over its standard input and output: one line of JSON in, one line of
// JSON out. For `runtime: "process"` in a plugin's plugin.json (host/plugin-manifest.ts).
//
// The protocol covers the shapes that already exist and nothing more. An agent plugin is four functions — `command`,
// `read`, `link`, `check` (worker/agents.ts) — and a source plugin is one, `(input) => events` (host/server.ts); each
// becomes one call, under its own name, with the same arguments and the same answer. No call is invented, nothing is
// added, and a plugin that does not say it has `link` or `check` does not get one: the hub reads the absence of those
// two, so a stand-in that always had them would change what it does.
//
// All five of those functions are synchronous where they are called from, so each call is one run of the program: the
// line goes in on its standard input, the answer comes back on its standard output, and the program exits. That is
// what makes a program in any language able to be one of these — it reads a line, prints a line, and is over — and it
// is what the kinds this covers can afford, being pure translations with nothing to keep between calls. A channel is
// not: it is a loop that lives as long as the hub does, so it is not in this (计划第四章 2.6, D8). A channel in another
// language already has a way in that costs it nothing — the hub's own HTTP protocol (host/channels.ts:1-2).
//
// Nothing here goes through a shell. The command line is an array, as everywhere else in this program.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { PluginKind } from "./plugins.ts";

/** What the plugin says it has. Only the two optional ones matter; the required ones are required. */
type Described = { calls?: unknown };

const CALL_TIMEOUT = 30_000;
/** An agent's output is handed to `read` whole, and some of them print a great deal of it. */
const MOST = 32 * 1024 * 1024;

/** One run of the plugin's program: a line in, a line out. Throws what the plugin said, or what went wrong instead. */
function ask(name: string, folder: string, argv: string[], request: Record<string, unknown>): unknown {
  const [program, ...args] = argv;
  const ran = spawnSync(program!, args, {
    input: `${JSON.stringify(request)}\n`,
    encoding: "utf8",
    timeout: CALL_TIMEOUT,
    maxBuffer: MOST,
    windowsHide: true,
    // Its own folder, so that an argument naming a file of its own is a path the plugin can write down: it cannot
    // know where it was installed, and the folder it was installed in is the one place it can be sure of.
    cwd: folder,
  });
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

/** What the plugin answers `describe` with, which is the one call every one of them has to have. */
function describe(name: string, folder: string, argv: string[]) {
  const value = ask(name, folder, argv, { call: "describe" }) as Described | null;
  const calls = Array.isArray(value?.calls)
    ? value.calls.filter((call): call is string => typeof call === "string")
    : [];
  return new Set(calls);
}

/**
 * The plugin, as the shape its kind is read as. `entry` and `args` come from the manifest, already known to stay
 * inside the plugin's own folder; `describe` is asked here, which is where a process plugin first runs — the same
 * moment a source plugin would first be imported and run.
 */
export function processPlugin(
  name: string,
  kind: PluginKind,
  folder: string,
  entry: string,
  args: readonly string[],
): unknown {
  if (kind === "channel")
    throw new Error(
      `${name} 是通道插件，现在还不能用 runtime: "process"：通道是和中台一样长命的循环，不是一次一答的翻译。` +
        `用别的语言写通道，直接当独立程序连中台的 HTTP 协议（见 docs/plugins.md 的通道一节），不必经过插件机制。`,
    );
  if (!existsSync(entry)) throw new Error(`${name} 的 plugin.json 指的程序不在：${entry}`);
  const argv = [entry, ...args];
  const has = describe(name, folder, argv);
  if (kind === "source")
    return (input: unknown) => ask(name, folder, argv, { call: "translate", ...(input as object) });
  const adapter: Record<string, unknown> = {
    command: (turn: unknown) => ask(name, folder, argv, { call: "command", turn }),
    read: (stdout: string, code: number | null, stderr: string) =>
      ask(name, folder, argv, { call: "read", stdout, code, stderr }),
  };
  if (has.has("link")) adapter.link = (session: string) => ask(name, folder, argv, { call: "link", session });
  if (has.has("check")) adapter.check = () => ask(name, folder, argv, { call: "check" });
  return adapter;
}
