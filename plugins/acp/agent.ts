// A turn over this protocol runs in a process of its own (bridge.ts), and that process is this program started again
// with a subcommand — not `bridge.ts` named as a file. A packaged build has no `.ts` file to name, and naming one is
// what stopped a turn from running at all there; `internal:plugin acp` is the same words in both modes, and it reaches
// `main` below through the one loader (host/plugins.ts), as plugins/delivery already does.
import { t } from "../../host/i18n.ts";
import { selfExecutable } from "../../host/self.ts";
import { tail, type Adapter, type Reading } from "../../worker/agents.ts";

export default {
  command: (turn) => [...selfExecutable(), "internal:plugin", "acp", JSON.stringify(turn)],
  read(stdout, code, stderr) {
    let reading: Reading = {};
    for (const line of stdout.trim().split("\n")) {
      try {
        reading = { ...reading, ...JSON.parse(line) };
      } catch {
        /* A partial final line is read again after the next poll. */
      }
    }
    // Taken back by the bridge when the agent refused the session it was to go on in.
    if (!reading.started) delete reading.started;
    if (code !== null && (code !== 0 || !reading.finished || reading.error)) {
      // What the agent itself said, then why it failed. The bridge says that last, unless the agent went on talking.
      const said = tail(stderr);
      const error = said.endsWith(reading.error ?? "") ? said : tail(`${said}\n${reading.error}`);
      return { session: reading.session, started: reading.started, error: error || t("acp.unfinished") };
    }
    return reading;
  },
  main: async (argv) => (await import("./bridge.ts")).bridge(JSON.parse(argv[0]!)),
} satisfies Adapter;
