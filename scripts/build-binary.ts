// Builds the single executable: one file somebody can download and run with no Node installed.
//
//   pwsh -NoProfile -File scripts/build-binary.ps1          Windows
//   sh scripts/build-binary.sh                              macOS, Linux
//
// Those two are the way in on each platform; this is where the build itself is written down, once. A build contract
// said twice is a build contract that drifts, and this one is not a list of commands — it is a set of things that have
// to be true together, each of which the source relies on:
//
//   - The bundler's three `--define`s. A CJS bundle has no `import.meta`, and the warning esbuild gives for each use
//     is not the point: `import.meta.main=false` turns every "run as a script" guard into dead code, which is what
//     makes the two top-level awaits in the tree disappear (plugins/delivery/run.ts, protocol/conformance.ts — a CJS
//     output cannot have one); `import.meta.dirname` and `import.meta.url` become the CJS words for the same thing.
//     Nothing in the program decides *which build this is* from any of them — that is `node:sea` (host/assets.ts) —
//     but plenty of it still reads them in source mode, so they have to mean something here.
//   - The assets. host/assets.ts says which files the program reads out of itself; that list is read from there
//     rather than written again, so a file added on one side cannot be missing from the other.
//   - The version. A packaged build has no checkout to ask (host/version.ts), so what it is gets written into it.
//   - The entry. The generated list of built-ins has to register itself before the command line runs, so the entry is
//     a file of this build's own and not `bin/agent-autoloop.ts`.
//
// Nothing is installed to build this. The two tools come in through `npx --yes`, pinned, and `package.json` is
// untouched — no `dependencies`, no `devDependencies` for a bundler (计划 plan-c 第七章 D1(a)): the development and
// test flow is what it was, and the binary is an extra channel rather than a new requirement.
import { execFileSync, spawnSync, type StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ASSETS } from "../host/assets.ts";
import { OUTPUT, render, scan } from "./build-registry.ts";

const ROOT = join(import.meta.dirname, "..");
const BUILD = join(ROOT, "build");

/**
 * Pinned, so that two builds of the same commit are built by the same two tools: a bundler that changed under this
 * build would be a change to the program nobody wrote.
 *
 * This is not a reproducible build, and the SHA256 printed at the end is not a thing to compare two builds by. The
 * blob carries V8's code cache (`useCodeCache` below), which is produced by the runtime doing the building and is not
 * a function of the source alone — the same commit built twice on the same machine gives two files that differ.
 * What the checksum is for is the one thing it can be for: telling whoever downloaded a binary that it is the file
 * that was built and attached, byte for byte (INSTALL.md says so to them).
 */
export const TOOLS = { esbuild: "esbuild@0.28.2", postject: "postject@1.0.0-alpha.6" };

/** What `node --experimental-sea-config` is handed. Asset names are the paths the repository spells them by. */
export function seaConfig() {
  return {
    main: "build/agent-autoloop.cjs",
    output: "build/sea-prep.blob",
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets: Object.fromEntries(ASSETS.map((name) => [name, name])),
  };
}

/**
 * What this build is, as a module of its own (host/version.ts reads these two). Said in a file rather than as two more
 * `--define`s because a define's value is a quoted string, and a quoted string is the one thing that cannot be passed
 * through a Windows shell unharmed. `||=`, so that a deployment can still say otherwise — as it can in source mode.
 *
 * A module of its own, and not two lines in the entry below, because of when it has to happen: a module's imports all
 * run before any statement in its body, and importing the command line is what runs the command. So this is imported
 * first instead — import order is source order, and that is the whole of the ordering being relied on here.
 */
export const toldSource = (told: { commit: string; release: string }) =>
  [
    "// 由 scripts/build-binary.ts 产生，不进版本库，改它没有意义：下一次建置会覆盖。",
    "// 这次建置是哪一份代码。打包版没有 .git 可问（host/version.ts），所以建置期把答案写进来。",
    `process.env.AGENT_AUTOLOOP_COMMIT ||= ${JSON.stringify(told.commit)};`,
    `process.env.AGENT_AUTOLOOP_RELEASE ||= ${JSON.stringify(told.release)};`,
    "",
  ].join("\n");

/**
 * The packaged build's entry. Not `bin/agent-autoloop.ts`: that one only imports the command line, and a packaged
 * build has two things to settle first — what this build is, and the generated list of built-ins registering itself
 * (there being no `plugins/` folder to look in). Three imports, in that order, and no top-level await anywhere: a CJS
 * output cannot have one, and this file existing at all is what keeps the order without needing one.
 *
 * Generated rather than committed, for the same reason the list itself is (计划 plan-c 第七章 D3(a)): nothing in the
 * version control then refers to `build/`, and a fresh clone typechecks without having built anything.
 */
export const ENTRY = [
  "// 由 scripts/build-binary.ts 产生，不进版本库，改它没有意义：下一次建置会覆盖。",
  "// 打包版的入口。顺序就是这三行的顺序，而且一个 top-level await 都没有——CJS 的产物不能有。",
  'import "./sea-told.ts";',
  'import "./builtins.generated.ts";',
  'import "../cli/main.ts";',
  "",
].join("\n");

/**
 * The bundler's arguments, which are the build contract's own half of it. `out` is the single-file CJS bundle.
 *
 * Every one of these is free of the double quote, which is what lets the whole line go through a Windows shell: `npx`
 * there is a `.cmd`, and a `.cmd` cannot be started as a program at all. The banner is the only one with a space in
 * it, and quoting it adds no quote of its own.
 */
export function bundleArgs(entry: string, out: string) {
  return [
    entry,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node24",
    "--packages=external",
    "--define:import.meta.main=false",
    "--define:import.meta.dirname=__dirname",
    "--define:import.meta.url=__seaModuleUrl",
    "--banner:js=const __seaModuleUrl = require('node:url').pathToFileURL(__filename).href;",
    `--outfile=${out}`,
  ];
}

/** The fuse Node looks for in its own binary. Its spelling is the runtime's, not this program's. */
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const git = (...args: string[]) => {
  try {
    return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const value = (args: string[], name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? "") : undefined;
};

function run(program: string, args: string[], what: string) {
  const done = spawnSync(program, args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
  if (done.error) throw new Error(`${what} 起不来：${done.error.message}`);
  if (done.status !== 0) throw new Error(`${what} 失败（退出码 ${done.status}）`);
}

/** One word for a shell. Nothing here holds a double quote, so quoting needs no escape — and it is checked. */
function quoted(word: string) {
  if (word.includes('"')) throw new Error(`建置的命令行里不能有引号：${word}`);
  return /^[\w@./:=-]+$/.test(word) ? word : `"${word}"`;
}

/**
 * One of the two tools, through `npx --yes` so that nothing is installed to build this.
 *
 * On Windows `npx` is a `.cmd`, and a `.cmd` cannot be started as a program — a shell has to read it. A shell is
 * handed one line and nothing quotes the arguments on the way, so this does; it is safe here because no argument holds
 * a double quote (see `bundleArgs`). Everywhere else `npx` is a program and the arguments go as they are.
 */
function tool(args: string[], what: string) {
  const where = { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] satisfies StdioOptions };
  const done =
    process.platform === "win32"
      ? spawnSync(["npx", ...args].map(quoted).join(" "), { ...where, shell: true })
      : spawnSync("npx", args, { ...where });
  if (done.error) throw new Error(`${what} 起不来：${done.error.message}`);
  if (done.status !== 0) throw new Error(`${what} 失败（退出码 ${done.status}）`);
}

export function build(args: string[] = []) {
  const windows = process.platform === "win32";
  const out = value(args, "out") || join(BUILD, `agent-autoloop${windows ? ".exe" : ""}`);
  const commit = value(args, "commit") ?? process.env.AGENT_AUTOLOOP_COMMIT ?? git("rev-parse", "HEAD");
  const release =
    value(args, "release") ??
    process.env.AGENT_AUTOLOOP_RELEASE ??
    git("tag", "--points-at", "HEAD")
      .split("\n")
      .find((tag) => /^v\d+\.\d+\.\d+$/.test(tag)) ??
    "";
  mkdirSync(BUILD, { recursive: true });

  // 1. The built-ins, as a list of literal imports: the only form a bundler can follow (host/plugin-registry.ts).
  writeFileSync(OUTPUT, render(scan(ROOT)));
  console.log(`内置清单：${scan(ROOT).length} 条 → ${OUTPUT}`);

  // 2. The entry, and what it settles before the command line runs: this build's own version, then that list.
  writeFileSync(join(BUILD, "sea-told.ts"), toldSource({ commit, release }));
  const entry = join(BUILD, "sea-entry.ts");
  writeFileSync(entry, ENTRY);

  // 3. One file, CJS, with the three substitutions that make a CJS output possible at all.
  const bundle = join(BUILD, "agent-autoloop.cjs");
  rmSync(bundle, { force: true });
  tool(["--yes", TOOLS.esbuild, ...bundleArgs(entry, bundle)], TOOLS.esbuild);
  console.log(`打包：${statSync(bundle).size} 字节 → ${bundle}`);

  // 4. The blob: the bundle, plus the files the program reads out of itself.
  const config = join(BUILD, "sea-config.json");
  writeFileSync(config, `${JSON.stringify(seaConfig(), null, 2)}\n`);
  const blob = join(BUILD, "sea-prep.blob");
  rmSync(blob, { force: true });
  run(process.execPath, ["--experimental-sea-config", config], "node --experimental-sea-config");

  // 5. This runtime, with the blob put inside it. Windows refuses to overwrite an executable something is running.
  rmSync(out, { force: true });
  copyFileSync(process.execPath, out);
  // On a Mac the signature has to come off before the blob goes in and a fresh ad-hoc one back on after, or the
  // result will not start at all; `--macho-segment-name` is what postject wants there. Nothing is signed on Windows —
  // INSTALL.md says what SmartScreen does about that.
  const inject = ["--yes", TOOLS.postject, out, "NODE_SEA_BLOB", blob, "--sentinel-fuse", FUSE];
  if (process.platform === "darwin") {
    spawnSync("codesign", ["--remove-signature", out], { stdio: "ignore" });
    inject.push("--macho-segment-name", "NODE_SEA");
  }
  tool(inject, TOOLS.postject);
  if (process.platform === "darwin") spawnSync("codesign", ["--sign", "-", out], { stdio: "ignore" });
  if (!windows) run("chmod", ["+x", out], "chmod");

  // 6. What a person can check the download against — that file against this build, and nothing else: two builds of
  // the same commit do not give the same sum (TOOLS above says why).
  const sum = createHash("sha256").update(readFileSync(out)).digest("hex");
  writeFileSync(`${out}.sha256`, `${sum}  ${basename(out)}\n`);
  console.log(`二进位：${statSync(out).size} 字节 → ${out}`);
  console.log(`SHA256：${sum}`);
  console.log(`版本：${release || "未发布"}（提交 ${commit.slice(0, 12) || "dev"}）`);
  return { out, sum, commit, release };
}

if (import.meta.main) build(process.argv.slice(2));
