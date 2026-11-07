// Where this install keeps its things: rules.json, config.json, secrets.env, hub.db and the worker's runs.
import { homedir } from "node:os";
import path from "node:path";

/**
 * One of these variables, where being set to nothing counts as not being set. `??` keeps an empty string, and
 * `path.resolve("")` is the working directory — so `AGENT_AUTOLOOP_RULES=` (a line in an env file with nothing after
 * the `=`, a shell that expanded a name that was not there, a CI step that passed an unset variable along) made the
 * rules file `rules.json` of whatever folder the program happened to be started in, and a hub with no rules at all
 * where a person had meant the default (phase3-verification-round3.md L). Whitespace is the same thing said longer.
 */
const given = (name: string) => {
  const value = process.env[name];
  return value?.trim() ? value : undefined;
};

export const HOME = path.resolve(given("AGENT_AUTOLOOP_HOME") ?? path.join(homedir(), ".agent-autoloop"));
export const RULES_FILE = path.resolve(given("AGENT_AUTOLOOP_RULES") ?? path.join(HOME, "rules.json"));
