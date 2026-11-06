// The two loaders that have always been here: a folder of plugin folders, `<folder>/<name>/<kind>.ts`, imported from
// the file system. This install's folder is one of them and the folder that ships beside the engine is the other; the
// order they are asked in is host/plugins.ts and is not this file's business.
//
// Nothing about what they do has changed in being moved. In particular: being found is being imported, and importing a
// plugin runs it — whatever its top level does, it does at that moment, in this process, with everything this process
// can reach (security-audit.md L4). `agent-autoloop add` only clones; this is where a cloned plugin first runs.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HOME } from "./home.ts";
import { readManifest } from "./plugin-manifest.ts";
import { processPlugin } from "./plugin-process.ts";
import { builtins, registryKey } from "./plugin-registry.ts";
import { fromSource } from "./self.ts";
import type { Found, PluginLoader } from "./plugins.ts";

/** Where a plugin's entry file would be under a folder of plugin folders. The name is already known to be a name. */
export const entryIn = (folder: string, name: string, kind: string) => join(folder, name, `${kind}.ts`);

const fromFolder = (id: string, folder: () => string): PluginLoader => ({
  id,
  async resolve(name, kind): Promise<Found | null> {
    const file = entryIn(folder(), name, kind);
    if (!existsSync(file)) return null;
    return { plugin: (await import(pathToFileURL(file).href)).default };
  },
});

/** What `agent-autoloop add <git 地址>` put under this install: `~/.agent-autoloop/plugins/<name>/<kind>.ts`. */
export const externalLoader = fromFolder("external", () => join(HOME, "plugins"));

/** The ones that ship with the engine, in the folder beside it. */
export const shippedLoader = fromFolder("shipped", () => join(import.meta.dirname, "..", "plugins"));

/**
 * The ones a packaged build carries instead of a folder. There is no registry in a source-mode install, so this finds
 * nothing there and the search goes straight on to the folder beside the engine — which is what it always did.
 */
export const builtinLoader: PluginLoader = {
  id: "builtin",
  async resolve(name, kind): Promise<Found | null> {
    const open = builtins()?.[registryKey(name, kind)];
    if (!open) return null;
    return { plugin: (await open()).default };
  },
};

/**
 * A plugin under this install that says it is a program of its own: `plugin.json` with `runtime: "process"`
 * (host/plugin-manifest.ts, host/plugin-process.ts). Asked after the folder has been looked in for a `.ts` file, so
 * that a plugin with both is the plugin it has always been.
 *
 * It is also where a packaged build says what to do about a plugin it cannot import. Such a build has no way to run an
 * external `.ts` file, and "没有这个插件" would be a lie about a plugin that is plainly there.
 */
export const processLoader: PluginLoader = {
  id: "process",
  async resolve(name, kind): Promise<Found | null> {
    const folder = join(HOME, "plugins", name);
    if (!existsSync(folder)) return null;
    const manifest = readManifest(folder, name);
    if (manifest.runtime !== "process") {
      if (!fromSource() && existsSync(entryIn(folder, name, kind)))
        throw new Error(
          `${name} 是源码插件（plugins/${name}/${kind}.ts），这个打包版跑不了外部的 .ts 文件。` +
            `在 ${join(folder, "plugin.json")} 里写 {"runtime":"process","entry":"…"}，让它当一个独立程序被调用（见 docs/plugins.md）。`,
        );
      return null;
    }
    return { plugin: processPlugin(name, kind, folder, manifest.entry!, manifest.args) };
  },
};
