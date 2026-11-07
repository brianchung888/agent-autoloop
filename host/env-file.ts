// `--env-file=<文件>` as this program's own argument.
//
// A Windows scheduled task carries no environment of its own, so the home an install uses is handed to it in a file
// (host/service-win.ts: envFile, and the `--env-file=` it puts in front of `up`).
//
// Who reads that file is the runtime, in both builds. Asked of a real binary (tests/sea-format.test.ts):
// `agent-autoloop.exe --env-file=<a file that is not there> status` ends with node's own «not found» and exit code 9,
// wherever in the command line the flag sits — a single-file build is this node with a blob injected into it, and it
// reads its own flags before the blob runs.
//
// What a packaged build has no runtime for is taking the flag back off the command line. There `process.argv` is this
// program's own from the executable onwards, so the flag stayed where a subcommand was expected: the hub printed the
// help and left with code 1, every five minutes, for ever, and a binary install with a service never came up at all.
// Nothing caught it because scripts/install-smoke.ps1 installs with `--no-service`, and the task was only ever checked
// as XML (tests/packaged-mode.test.ts) — the one thing not checked was whether the program it names can read what it
// is given. (Commit ed50d3f said the loading was what was missing. It was not: phase3-verification-round3.md.)
//
// So what is here is taking those flags off the front, and loading each as well. The loading costs nothing where the
// runtime has already done it, and is what would keep this working if a runtime stopped: existing variables win
// either way, which is what the runtime's own `--env-file` does too — a person who set AGENT_AUTOLOOP_HOME in the
// environment they started this from meant that one.
//
// Read before anything that reads the environment. Which home this is gets decided as host/home.ts loads, so a flag
// read any later would be read after the answer it changes — which is why this is a side-effect import and why it is
// the first one in cli/main.ts.
const FLAG = "--env-file=";

/**
 * Takes those flags off the front of the arguments and loads each. What comes back is the command line without them —
 * the same arguments the runtime would have left behind.
 *
 * Only at the front, and that is about the taking off: past the subcommand the words are the subcommand's, and a rule
 * or a prompt that happens to start with those letters is not a flag of this program's. It says nothing about which
 * files get loaded, which is not this function's to decide: the runtime reads one wherever it sits in the command
 * line, so `status --env-file=<a file that is not there>` is exit 9 and never reaches here.
 */
export function loadEnvFiles(argv: string[]) {
  const rest = [...argv];
  const loaded: string[] = [];
  while (rest[0]?.startsWith(FLAG)) {
    const file = rest.shift()!.slice(FLAG.length);
    try {
      process.loadEnvFile(file);
    } catch (error) {
      throw new Error(`--env-file 指的 ${file} 读不了：${(error as Error).message}`);
    }
    loaded.push(file);
  }
  return { argv: rest, loaded };
}

/**
 * Done as this module loads, to `process.argv` itself, so that everything after it sees the command line it would have
 * seen in source mode. Said and left rather than thrown: what reads this is a scheduled task, and a stack trace it
 * throws away is a hub that is simply not there, with nothing anywhere saying why.
 *
 * The sentence is a backstop and not the road a missing file takes today: every runtime this runs on reads the flag
 * first and leaves with its own «not found» and code 9 before a line here runs. It is kept for the one that stops
 * reading it, and because a file that is there and cannot be read is still worth a sentence of this program's own.
 */
try {
  const { argv } = loadEnvFiles(process.argv.slice(2));
  process.argv.splice(2, process.argv.length - 2, ...argv);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
