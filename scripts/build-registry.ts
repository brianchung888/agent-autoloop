// Writes the list of built-in plugins a packaged build needs: build/builtins.generated.ts, one static import per
// `plugins/<name>/{agent,channel,source}.ts`. The output is not in the version control — a source-mode install reads
// the folders, as it always has, and this exists for Phase 3.
//
//   node --disable-warning=ExperimentalWarning scripts/build-registry.ts            写出来
//   node --disable-warning=ExperimentalWarning scripts/build-registry.ts --check    对一遍，不写
//
// `--check` says the list is a function of `plugins/` alone: run twice, the second run must find exactly what the
// first wrote. It cannot catch a stale list, because the list is not in the version control and there is none to be
// stale — a plugin added to `plugins/` and missing from the list is caught by the test that scans the folder itself
// (tests/plugin-loaders.test.ts). That is the difference worth catching: a plugin the packaged build silently does not
// have, while the source build is perfectly fine. Nor does it check that every path in the list is a file: the list is
// `scan()`, and `scan()` only names a file it has just seen — the one thing the two runs do not share is the writing.
//
// What it writes is in tsconfig's `include`, so it is typechecked like anything else: a generated module that does not
// compile is a packaged build that does not build. CI therefore writes it before the typecheck, and a tree where it
// has not been written matches nothing and is no error.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const KINDS = ["agent", "channel", "source"] as const;
export const OUTPUT = join(ROOT, "build", "builtins.generated.ts");

export type Builtin = { readonly name: string; readonly kind: string };

/** Every built-in entry file there is, in one order whatever the file system's own order is. */
export function scan(root = ROOT): Builtin[] {
  const folder = join(root, "plugins");
  const found: Builtin[] = [];
  for (const name of readdirSync(folder, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort())
    for (const kind of KINDS) if (existsSync(join(folder, name, `${kind}.ts`))) found.push({ name, kind });
  return found;
}

/** The list as a module. Every specifier is a literal: a bundler that cannot read it cannot follow it. */
export function render(builtins: Builtin[]) {
  const lines = builtins.map(({ name, kind }) => `  "${name}/${kind}": () => import("../plugins/${name}/${kind}.ts"),`);
  return [
    "// 由 scripts/build-registry.ts 产生，不进版本库，改它没有意义：下一次建置会覆盖。",
    "// 内置插件的静态清单。打包的 bundler 只跟得上字面量 import，所以每一条都写死在这里。",
    'import { registerBuiltins } from "../host/plugin-registry.ts";',
    "",
    "registerBuiltins({",
    ...lines,
    "});",
    "",
  ].join("\n");
}

function main(args: string[]) {
  const wanted = render(scan());
  const checking = args.includes("--check");
  if (!checking) {
    mkdirSync(join(ROOT, "build"), { recursive: true });
    writeFileSync(OUTPUT, wanted);
    console.log(`写好了 ${OUTPUT}：${scan().length} 条。`);
    return 0;
  }
  let written: string;
  try {
    written = readFileSync(OUTPUT, "utf8");
  } catch {
    console.error(`还没产生 ${OUTPUT}：先运行 node --disable-warning=ExperimentalWarning scripts/build-registry.ts`);
    return 1;
  }
  if (written !== wanted) {
    console.error(`${OUTPUT} 和 plugins/ 下的实际情况对不上：重新运行 scripts/build-registry.ts（不加 --check）`);
    return 1;
  }
  console.log(`对得上：${scan().length} 条内置插件都在清单里。`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
