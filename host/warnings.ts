// One warning, turned off from inside the program.
//
// The hub's store is the runtime's own SQLite (`node:sqlite`), and while that module was experimental the runtime said
// so on stderr at every start. Source mode answers that on the command line — `--disable-warning=ExperimentalWarning`,
// in the shebang (bin/agent-autoloop.ts), in the `.cmd` beside it, and in what the service starts. A packaged build has
// no command line to put it on: the executable is the first word and everything after it belongs to this program, so
// the only place left to turn it off is inside.
//
// It is version-dependent in exactly one direction. On Node 25.8.1 `node:sqlite` no longer warns at all, which is the
// Node a release is built with — so on a current build this does nothing. On Node 24, the oldest this program runs on
// (package.json: engines), it is what keeps `--version` from printing a paragraph about an experimental feature.
//
// Only that one warning, and only the runtime's own: an experimental warning about anything else is news, and a program
// that swallowed all of them would hide the next one. Everything else goes out as it always did.
//
// Importing this file does it. That is what makes it reliable: nothing in the body of a module runs before that
// module's own imports, so a call in `host/runtime.ts` would come after `node:sqlite` had already been loaded and had
// already said its piece. Importing this first, from the one file every command goes through (cli/main.ts), is before.
let hushed = false;

/** Turns off the runtime's own "SQLite is experimental" warning, and nothing else. Said once; said again is nothing. */
export function hushStoreWarning() {
  if (hushed) return;
  hushed = true;
  // Node prints warnings from a handler of its own, which a listener is added alongside rather than instead of. What
  // can be stood in front of is the call itself.
  const said = process.emitWarning.bind(process);
  // The two shapes `emitWarning` is called in — (warning, type, code?, ctor?) and (warning, options) — and the answer
  // is the same for both: what it is about is the first argument, and which kind it is is the second, either way.
  process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
    const kind = typeof rest[0] === "string" ? rest[0] : ((rest[0] as { type?: string } | undefined)?.type ?? "");
    const about = typeof warning === "string" ? warning : ((warning as Error | undefined)?.message ?? "");
    if (kind === "ExperimentalWarning" && /\bSQLite\b/i.test(about)) return;
    return said(warning as string, ...(rest as []));
  }) as typeof process.emitWarning;
}

hushStoreWarning();
