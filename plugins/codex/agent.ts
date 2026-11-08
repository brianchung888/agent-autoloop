// Codex: the user's own, installed and signed in by them. A run is a `codex exec` in the background; its thread is kept
// on disk, so a retry or an answer can go on in it, and the link opens it in the app.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { t } from "../../host/i18n.ts";
import { findProgram, tail, type Adapter } from "../../worker/agents.ts";

const SANDBOX = { read: "read-only", edit: "workspace-write", full: "danger-full-access" };
/**
 * Where it is when the worker does not share the PATH the person installed it on: inside the desktop app, or in the
 * folders an install of its own uses. Only real executables — a batch shim cannot be started as a program, and a path
 * named here is taken as one. (A shim of a package manager's own shape is read on PATH instead — worker/agents.ts
 * findProgram — and comes back as the program it names, with the script it hands it.)
 */
function elsewhere() {
  if (process.platform !== "win32")
    return [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ];
  const local = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData/Local");
  return [
    path.join(local, "Programs/ChatGPT/resources/codex-cli/codex.exe"),
    path.join(local, "Programs/Codex/resources/codex.exe"),
    path.join(homedir(), ".local/bin/codex.exe"),
    path.join(homedir(), ".codex/bin/codex.exe"),
    path.join(homedir(), ".cargo/bin/codex.exe"),
  ];
}
export const IN_THE_APP = elsewhere();

export default {
  command: (turn) => [
    // A shim's `prefix` is the script its program has to be given first; for a program of its own there is none.
    ...((found) => [found.program, ...found.prefix])(findProgram("codex", () => IN_THE_APP)),
    "exec",
    ...(turn.resume ? ["resume"] : []),
    "--json",
    "--skip-git-repo-check",
    ...(turn.model ? ["-m", turn.model] : []),
    ...(turn.effort ? ["-c", `model_reasoning_effort="${turn.effort}"`] : []),
    // As config, because `codex exec resume` takes no -s.
    "-c",
    `sandbox_mode="${SANDBOX[turn.access]}"`,
    "-c",
    'approval_policy="never"',
    ...(turn.resume ? [turn.resume] : []),
    "本轮通过后台 codex exec 运行，不要假定桌面应用的浏览器连接已带到本轮。" +
      "网页操作使用本轮实际可用的浏览器工具，或使用规则或 Skill 中已明确配置的浏览器入口。" +
      "沿用该入口的会话，只交网页步骤，业务处理和中台回执仍由本轮负责；没有可用入口或需要本人恢复连接时，按待你处理的约定交回。\n\n" +
      turn.prompt,
  ],
  read(stdout, code, stderr) {
    const seen: {
      text?: string;
      session?: string;
      sessionUsage?: object;
      error?: string;
      finished?: boolean;
      started?: boolean;
      completed?: boolean;
    } = {};
    for (const line of stdout.split("\n")) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      // A login shell's profile prints here too, and `null` is valid JSON.
      if (!event) continue;
      if (event.type === "thread.started") seen.session = event.thread_id;
      else if (event.type === "turn.started") seen.started = true;
      else if (event.type === "item.completed" && event.item?.type === "agent_message") seen.text = event.item.text;
      else if (event.type === "turn.completed") {
        seen.completed = seen.finished = true;
        const { input_tokens = 0, output_tokens = 0, cached_input_tokens = 0 } = event.usage ?? {};
        seen.sessionUsage = { input: input_tokens, output: output_tokens, cached: cached_input_tokens };
      } else if (event.type === "turn.failed") {
        seen.finished = true;
        seen.error = event.error?.message || t("codex.unfinished");
      } else if (event.type === "error") seen.error = event.message;
    }
    const { completed, ...reading } = seen;
    // Only a finished turn's last message is its answer; before that it's only as far as it had got.
    if (!completed) delete reading.text;
    if (code !== null && !completed && !reading.error) reading.error = tail(stderr) || t("codex.noResult");
    if (completed && !reading.text?.trim()) reading.error = t("codex.noResult");
    return reading;
  },
  link: (session) => `codex://threads/${session}`,
  check() {
    try {
      const { program, prefix } = findProgram("codex", () => IN_THE_APP);
      execFileSync(program, [...prefix, "login", "status"], {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return null;
    } catch (error) {
      return t("codex.notLoggedIn", { why: (error as Error).message.split("\n")[0] });
    }
  },
} satisfies Adapter;
