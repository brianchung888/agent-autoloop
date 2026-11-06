// The files a packaged build carries instead of a folder. One executable has no `kernel/evolve.ts` and no
// `protocol/schema.json` lying next to it, so the build embeds them under the very paths the repository spells them by
// and `node:sea` hands them back; a source-mode install has the files themselves and reads them as it always did.
//
// The bytes must be the same either way, and that is not a nicety. The format hash (host/runtime.ts) is made of the
// text of the files that decide what is stored, and a hash that differs between the two modes makes every existing
// install replay its whole log the first time it starts as a binary (计划 plan-c 第五章 Q1 — measured at 43 seconds
// for 1.1 million facts). So there is one list of these files, one spelling of each name, and one reader: a second
// spelling anywhere is a hash that can drift.
//
// Whether this is a packaged build is asked of `node:sea`, never of the file system. A build that looked around for a
// `.ts` file to decide would answer differently depending on where the executable happens to have been copied to —
// which is exactly what the PoC measured (phase3-poc-report.md 三.1 步骤 5): a binary sitting in a source tree took
// itself for a source install.
import { readFileSync } from "node:fs";

type Sea = { isSea(): boolean; getAsset(name: string, encoding: "utf8"): string };

/**
 * Every file a packaged build has to carry, by the path the repository spells it. This is the list the build embeds
 * (scripts/build-binary.*) and the list the program reads from: one list, so a file added to one side cannot be
 * missing from the other.
 */
export const ASSETS = ["kernel/evolve.ts", "kernel/credentials.ts", "protocol/schema.json"] as const;

export type Asset = (typeof ASSETS)[number];

/** The SEA interface where this is a packaged build, and null everywhere else. `node:sea` is built in to Node 24+. */
export function packaged(): Sea | null {
  try {
    // Not `import`: a bundler follows a static one into the output, and this has to be the runtime's own module.
    const sea = process.getBuiltinModule("node:sea") as Sea | undefined;
    return sea?.isSea() ? sea : null;
  } catch {
    return null;
  }
}

/**
 * One of those files, as text. Named the one way, read whichever way this build has: out of the executable, or off the
 * disk beside the program. In source mode the name is resolved against the repository root, which is one level above
 * this file — the same place `host/runtime.ts` and `protocol/schema.ts` reached for these files before.
 */
export function assetText(name: Asset): string {
  const sea = packaged();
  if (!sea) return readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  try {
    return sea.getAsset(name, "utf8");
  } catch (error) {
    // A build that left one out fails here and nowhere later, saying which file and where the list is.
    throw new Error(
      `这个打包版里没有 ${name}：建置时内嵌的清单漏了它（host/assets.ts 的 ASSETS，` +
        `由 scripts/build-binary.ps1 / .sh 写进 SEA 设定）。${(error as Error).message}`,
    );
  }
}
