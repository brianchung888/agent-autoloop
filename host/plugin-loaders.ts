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
