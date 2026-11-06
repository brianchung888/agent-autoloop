// What a plugin may say about itself: `plugin.json` beside its entry files. Optional, and a plugin without one is a
// plugin the way every plugin was before this existed — `{"runtime":"source"}`, a `.ts` file to import.
//
// It is read leniently on purpose. A third-party repository may have a `plugin.json` of its own for something else
// entirely, and a plugin that works today must not stop working because this file learnt to look for one: no file, an
// unreadable one, one that is not an object, or one that says nothing about `runtime` all mean the default. What is
// refused is only what was meant for this and is wrong — a `runtime` that is neither of the two, or a `process` with
// nowhere to run — because carrying on would run the wrong thing or nothing at all.
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export type PluginRuntime = "source" | "process";
export type PluginManifest = {
  readonly runtime: PluginRuntime;
  /** For `process`: the executable to run, resolved to a path inside the plugin's own folder. */
  readonly entry: string | null;
};

/** A plugin that says nothing is what every plugin was: a `.ts` file this process imports. */
export const DEFAULT_MANIFEST: PluginManifest = { runtime: "source", entry: null };

const RUNTIMES: PluginRuntime[] = ["source", "process"];

export const manifestFile = (folder: string) => join(folder, "plugin.json");

/**
 * What the plugin in `folder` says about itself. `name` is only for what the errors say.
 *
 * `entry` is a path inside the plugin's own folder: anything that would reach out of it is refused, the same way a
 * plugin's name is. Nothing here runs anything — it only says what would be run.
 */
export function readManifest(folder: string, name = folder): PluginManifest {
  let written: string;
  try {
    written = readFileSync(manifestFile(folder), "utf8");
  } catch {
    return DEFAULT_MANIFEST;
  }
  let declared: unknown;
  try {
    declared = JSON.parse(written);
  } catch {
    return DEFAULT_MANIFEST;
  }
  if (typeof declared !== "object" || declared === null || Array.isArray(declared)) return DEFAULT_MANIFEST;
  const { runtime, entry } = declared as { runtime?: unknown; entry?: unknown };
  if (runtime === undefined || runtime === null) return DEFAULT_MANIFEST;
  if (typeof runtime !== "string" || !RUNTIMES.includes(runtime as PluginRuntime))
    throw new Error(
      `${name} 的 plugin.json 里 runtime 只能是 ${RUNTIMES.join(" 或 ")}，现在写的是 ${describe(runtime)}`,
    );
  if (runtime === "source") return DEFAULT_MANIFEST;
  if (typeof entry !== "string" || !entry)
    throw new Error(`${name} 的 plugin.json 写了 runtime: "process"，还要用 entry 指出要运行的程序`);
  if (isAbsolute(entry) || /^[a-zA-Z]:/.test(entry))
    throw new Error(`${name} 的 plugin.json 里 entry 要是插件目录内的相对路径，不能是绝对路径：${entry}`);
  const file = resolve(folder, entry);
  const inside = relative(resolve(folder), file);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error(`${name} 的 plugin.json 里 entry 走出了插件目录：${entry}`);
  return { runtime: "process", entry: file };
}

const describe = (value: unknown) => (typeof value === "string" ? JSON.stringify(value) : String(value));
