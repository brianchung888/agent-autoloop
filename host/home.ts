// Where this install keeps its things: rules.json, config.json, secrets.env, hub.db and the worker's runs.
import { homedir } from "node:os";
import path from "node:path";

/**
 * One of these variables, where being set to nothing counts as not being set. `??` keeps an empty string, and
 * `path.resolve("")` is the working directory — so `AGENT_AUTOLOOP_RULES=` (a line in an env file with nothing after
 * the `=`, a shell that expanded a name that was not there, a CI step that passed an unset variable along) made the
 * rules file `rules.json` of whatever folder the program happened to be started in, and a hub with no rules at all
 * where a person had meant the default (phase3-verification-round3.md L). Whitespace is the same thing said longer.
 *
 * And what comes back is trimmed, not the value as it was written. Whitespace around a path is never part of the path:
 * what puts it there is an env file written by hand, a `=` with a space after it, a line that ended in a space, a
 * value pasted with a newline on it. It only decided whether the variable counted as set, so ` C:\agent ` named a
 * folder whose name begins and ends with a space — one `path.resolve` keeps and nothing a person could type again
 * (phase3-verification-round4.md 4).
 */
const given = (name: string) => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

export const HOME = path.resolve(given("AGENT_AUTOLOOP_HOME") ?? path.join(homedir(), ".agent-autoloop"));
export const RULES_FILE = path.resolve(given("AGENT_AUTOLOOP_RULES") ?? path.join(HOME, "rules.json"));
