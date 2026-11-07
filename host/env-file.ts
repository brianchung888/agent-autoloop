// `--env-file=<文件>` as this program's own argument.
//
// A Windows scheduled task carries no environment of its own, so the home an install uses is handed to it in a file
// (host/service-win.ts: envFile, and the `--env-file=` it puts in front of `up`). In source mode the runtime reads
// that flag before any of this program runs, and there is nothing here to do.
//
// A packaged build has no runtime reading a command line. `process.argv` is this program's own, so the flag arrived
// where a subcommand was expected: the hub printed the help and left with code 1, every five minutes, for ever, and a
// binary install with a service never came up at all. Nothing caught it because scripts/install-smoke.ps1 installs
// with `--no-service`, and the task was only ever checked as XML (tests/packaged-mode.test.ts) — the one thing not
// checked was whether the program it names can read what it is given.
//
// Read here, and before anything that reads the environment. Which home this is gets decided as host/home.ts loads,
// so a flag read any later would be read after the answer it changes — which is why this is a side-effect import and
// why it is the first one in cli/main.ts.
//
// Existing variables win, which is what the runtime's own `--env-file` does too: a person who set AGENT_AUTOLOOP_HOME
// in the environment they started this from meant that one.
const FLAG = "--env-file=";

/**
 * Takes those flags off the front of the arguments and loads each. What comes back is the command line without them —
 * the same arguments the runtime would have left behind. Only at the front: past the subcommand the words are the
 * subcommand's, and a rule or a prompt that happens to start with those letters is not a flag of this program's.
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
 */
try {
  const { argv } = loadEnvFiles(process.argv.slice(2));
  process.argv.splice(2, process.argv.length - 2, ...argv);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
