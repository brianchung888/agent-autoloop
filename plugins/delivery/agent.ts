// The delivery as an agent: its turn is a job this program does itself, and what it prints is read the way any plain
// command's output is. It starts this program again rather than naming `run.ts`: a packaged build has no `.ts` file to
// name, and `process.execPath` there is the binary and not a node that could run one (host/self.ts).
import { selfExecutable } from "../../host/self.ts";
import command from "../command/agent.ts";
import type { Adapter } from "../../worker/agents.ts";

export default {
  command: (turn) => [...selfExecutable(), "internal:plugin", "delivery", ...(turn.command ?? [])],
  read: command.read,
  main: async (argv) => (await import("./run.ts")).main(argv),
} satisfies Adapter;
