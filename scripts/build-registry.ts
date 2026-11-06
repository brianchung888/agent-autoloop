// Writes the list of built-in plugins a packaged build needs: build/builtins.generated.ts, one static import per
// `plugins/<name>/{agent,channel,source}.ts`. The output is not in the version control — a source-mode install reads
// the folders, as it always has, and this exists for Phase 3.
//
//   node --disable-warning=ExperimentalWarning scripts/build-registry.ts            写出来
//   node --disable-warning=ExperimentalWarning scripts/build-registry.ts --check    对一遍，不写
//
// `--check` is the one that belongs in CI: a plugin added to `plugins/` without the list being written again is a
// plugin the packaged build silently does not have, while the source build is perfectly fine — the hardest kind of
// difference to notice.
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
  // And every path in it is a file: a plugin renamed or taken away leaves a line that imports nothing.
  for (const { name, kind } of scan())
    if (!existsSync(join(ROOT, "plugins", name, `${kind}.ts`))) {
      console.error(`清单里的 plugins/${name}/${kind}.ts 不存在`);
      return 1;
    }
  console.log(`对得上：${scan().length} 条内置插件都在清单里。`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
