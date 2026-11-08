// An agent is a process: give it a prompt, read its last message from what it prints. An adapter is what's different
// about one: its command line and how to read its output. `plugins/<use>/agent.ts`, in this install's folder first,
// then the ones that ship. Anything with a print mode needs no file at all: `use: "command"` with a command line in
// rules.json.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { t } from "../host/i18n.ts";
import { loadPlugin } from "../host/plugins.ts";
import { fromSource } from "../host/self.ts";
import type { Usage } from "../protocol/validate.ts";

export type { Usage } from "../protocol/validate.ts";
export type Access = "read" | "edit" | "full";
/** One launch of an agent. `resume` is the session to go on in, if any; otherwise `session` is a new id it may use. */
export type Turn = {
  prompt: string;
  session: string;
  resume: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  access: Access;
  command?: string[];
  contextFile: string;
  folder: string;
};
export type Reading = {
  text?: string;
  session?: string;
  /** What this launch used. */
  usage?: Usage;
  /** What the session has used so far, for amounts the program only gives that way. */
  sessionUsage?: Usage;
  error?: string;
  /** Its turn is over, though it may not have exited. */
  finished?: boolean;
  /** It has this turn's prompt, in a conversation that's there. From here on the work may be half done. */
  started?: boolean;
};
export type Adapter = {
  /** Its command line for this turn. */
  command(turn: Turn): string[];
  /** What its output says so far. `code` is null while it's still running or when it died without saying. */
  read(stdout: string, code: number | null, stderr: string): Reading;
  /** Where a person can open this session. */
  link?(session: string): string;
  /** Whether it's installed and signed in: what's wrong, in words a person can act on, or nothing. */
  check?(): string | null;
  /**
   * A job of its own, run as a child process of this same program: `agent-autoloop internal:plugin <名字> [参数…]`.
   * For a plugin whose turn is not somebody else's CLI but work it does itself — `command(turn)` then starts this
   * program again (host/self.ts: selfExecutable) instead of naming one of its own files, which a packaged build has
   * none of. What it prints is read by `read` exactly as any other program's output is.
   */
  main?(argv: string[]): Promise<void>;
};

const adapters = new Map<string, Adapter>();

export async function adapterFor(use: string): Promise<Adapter> {
  const known = adapters.get(use);
  if (known) return known;
  const adapter = (await loadPlugin(use, "agent")) as Adapter;
  adapters.set(use, adapter);
  return adapter;
}

/**
 * What to start, and the words that have to come before the ones the caller wants. `prefix` is empty for a program that
 * is a program; it carries the script when what was found on PATH is a batch shim that only starts one (a package
 * manager's global install writes such a shim instead of an executable).
 */
export type Program = { program: string; prefix: string[] };

const found = new Map<string, Program | null>();

/** The files in a shim's line, with the two names such a shim defines for itself filled in. */
const QUOTED = /"([^"\r\n]*)"/g;
const SCRIPT = /\.(js|cjs|mjs)$/i;
const EXECUTABLE = /\.(exe|com)$/i;

/** Every real executable by this name on PATH, nearest first. Windows only: where.exe is what there is to ask. */
function executablesOnPath(name: string) {
  try {
    const printed = execFileSync("where.exe", [name], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    // where.exe prints every match, nearest on PATH first, which is the one that would run.
    return printed
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The node a shim means by `%_prog%` when there is none beside it: the one on PATH. A source install is itself running
 * on a node and could stand in for it — a packaged build is not (`process.execPath` is then this program, which would
 * be handed a script it knows nothing about), and must find a real one or give up.
 */
function nodeOnPath(): string | null {
  return (
    executablesOnPath("node").find((match) => /\bnode\.exe$/i.test(match)) ?? (fromSource() ? process.execPath : null)
  );
}

/**
 * What a batch shim on PATH actually starts, or nothing when it is not one of the shapes below. Only the fixed shape a
 * package manager writes for a global install is read — never anything else in the file, and never by running it:
 *
 *     "%dp0%\<...>\thing.exe"  %*                        a real program beside the shim
 *     "%_prog%"  "%dp0%\<...>\thing.js" %*               node, named by the shim's own IF/ELSE, and a script
 *
 * `%dp0%` is the shim's own folder; `%_prog%` is the node beside it if there is one, else the `node` on PATH that the
 * shim itself would have started. Anything left unexpanded, any file that isn't there, no node to be found, or any
 * other shape at all: nothing, so the caller goes on looking elsewhere.
 */
function whatTheShimStarts(shim: string): Program | null {
  let text: string;
  try {
    if (statSync(shim).size > 8_192) return null;
    text = readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const line = text
    .split(/\r?\n/)
    .filter((each) => each.includes("%*"))
    .at(-1);
  if (!line) return null;
  const folder = path.dirname(shim);
  const beside = path.join(folder, "node.exe");
  const names: Record<string, string> = {
    "%dp0%": `${folder}${path.sep}`,
    "%_prog%":
      (text.includes('SET "_prog=%dp0%\\node.exe"') && existsSync(beside) ? beside : nodeOnPath()) ?? "%_prog%",
  };
  const words = [...line.matchAll(QUOTED)]
    .map(([, word]) => word!)
    .map((word) => path.normalize(word.replace(/%dp0%|%_prog%/g, (found) => names[found]!)));
  if (!words.length || words.length > 2 || words.some((word) => word.includes("%"))) return null;
  const [first, second] = words;
  // A program and nothing else; or node and the one script it is given.
  if (words.length === 1 && EXECUTABLE.test(first!)) return existsSync(first!) ? { program: first!, prefix: [] } : null;
  if (words.length === 2 && first === names["%_prog%"] && SCRIPT.test(second!))
    return existsSync(second!) ? { program: first!, prefix: [second!] } : null;
  return null;
}

/**
 * Where a program is: on the login shell's PATH (launchd and systemd start with a bare one), or in one of these. A name
 * is only ever an argument to the shell, never part of the script it runs. Windows has no login shell and no `command
 * -v`: a scheduled task already starts with its owner's environment, so its own PATH is the one to ask about.
 */
export function findProgram(name: string, elsewhere: () => string[] = () => []): Program {
  if (!found.has(name)) {
    let onPath: Program | null = null;
    try {
      if (process.platform === "win32") {
        const matches = executablesOnPath(name);
        // A .cmd / .bat shim is a script for the command interpreter and cannot be started as a program: Windows
        // refuses it outright. A real executable is therefore what is wanted; failing that, a shim of the one fixed
        // shape a package manager writes says in so many words what it would have started, and that — the program it
        // names, with the script it hands it — is as good as having found the program itself. Anything else is as good
        // as nothing here, and the places in `elsewhere()` are looked at instead: taking the nearest match whatever it
        // is would both shadow those places and hand the launcher a name it can't start.
        const real = matches.find((match) => EXECUTABLE.test(match));
        onPath = real
          ? { program: real, prefix: [] }
          : (matches
              .filter((match) => /\.(cmd|bat)$/i.test(match))
              .map(whatTheShimStarts)
              .find(Boolean) ?? null);
      } else {
        const shell = process.env.SHELL ?? "/bin/sh";
        const printed = execFileSync(shell, ["-lc", 'command -v "$1"', "sh", name], {
          encoding: "utf8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const where = printed.trim().split("\n").at(-1);
        onPath = where ? { program: where, prefix: [] } : null;
      }
    } catch {}
    const other = elsewhere().find(existsSync);
    found.set(name, onPath ?? (other ? { program: other, prefix: [] } : null));
  }
  const program = found.get(name);
  if (!program) throw new Error(t("agents.notFound", { name }));
  return program;
}

/** The end of some output, for saying why something failed. */
export const tail = (text: string, length = 300) => text.trim().slice(-length);
