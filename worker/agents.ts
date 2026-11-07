// An agent is a process: give it a prompt, read its last message from what it prints. An adapter is what's different
// about one: its command line and how to read its output. `plugins/<use>/agent.ts`, in this install's folder first,
// then the ones that ship. Anything with a print mode needs no file at all: `use: "command"` with a command line in
// rules.json.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { t } from "../host/i18n.ts";
import { loadPlugin } from "../host/plugins.ts";
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

const found = new Map<string, string | null>();

/**
 * Where a program is: on the login shell's PATH (launchd and systemd start with a bare one), or in one of these. A name
 * is only ever an argument to the shell, never part of the script it runs. Windows has no login shell and no `command
 * -v`: a scheduled task already starts with its owner's environment, so its own PATH is the one to ask about.
 */
export function findProgram(name: string, elsewhere: () => string[] = () => []) {
  if (!found.has(name)) {
    let onPath: string | null = null;
    try {
      if (process.platform === "win32") {
        // where.exe prints every match, nearest on PATH first, which is the one that would run.
        const printed = execFileSync("where.exe", [name], {
          encoding: "utf8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        const matches = printed
          .trim()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        // A .cmd / .bat shim, such as the one npm writes, is a script for the command interpreter and cannot be
        // started as a program: Windows refuses it outright. So only a real executable counts as being on PATH —
        // anything else is as good as nothing here, and the places in `elsewhere()` are looked at instead. Taking the
        // nearest match whatever it is would both shadow those places and hand the launcher a name it can't start.
        onPath = matches.find((match) => /\.(exe|com)$/i.test(match)) ?? null;
      } else {
        const shell = process.env.SHELL ?? "/bin/sh";
        const printed = execFileSync(shell, ["-lc", 'command -v "$1"', "sh", name], {
          encoding: "utf8",
          timeout: 15_000,
          stdio: ["ignore", "pipe", "ignore"],
        });
        onPath = printed.trim().split("\n").at(-1) || null;
      }
    } catch {}
    found.set(name, onPath ?? elsewhere().find(existsSync) ?? null);
  }
  const program = found.get(name);
  if (!program) throw new Error(t("agents.notFound", { name }));
  return program;
}

/** The end of some output, for saying why something failed. */
export const tail = (text: string, length = 300) => text.trim().slice(-length);
