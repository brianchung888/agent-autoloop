// A plugin in this install's folder wins over one that ships. What "finding one" means is a loader: a file to import,
// a built-in a packaged build has compiled in, an executable to talk to. This file stays the only entry point and the
// only place the name is checked and the one error is worded; all it adds is the order the loaders are asked in.
//
// The order is the behaviour, so it does not change: this install's folder first, then the ones that ship. A loader
// finds a plugin or says it has none; the first that finds one wins, and the lot of them coming up empty is the one
// error below. Finding is what loads it, at the moment it is found — importing a plugin runs it, as it always has.
import { externalLoader, shippedLoader } from "./plugin-loaders.ts";

export type PluginKind = "agent" | "channel" | "source";
/**
 * What a loader found, in a box of its own. A plugin's default export can be anything at all, `null` included, and a
 * bare `null` would otherwise read as "no such plugin" and send the search on to the next loader.
 */
export type Found = { readonly plugin: unknown };
export type PluginLoader = {
  readonly id: string;
  /** `null` when this loader has no such plugin — not an error: the one below is worded once, by `loadPlugin`. */
  resolve(name: string, kind: PluginKind): Promise<Found | null>;
};

const loaders: PluginLoader[] = [externalLoader, shippedLoader];

// What it hands back is what it always did: the plugin's default export, which each caller reads as the shape its kind
// requires (worker/agents.ts: `Adapter`, host/channels.ts: the channel function, host/server.ts: the source function).
export async function loadPlugin(name: string, kind: PluginKind): Promise<any> {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`插件名字不正确：${name}`);
  for (const loader of loaders) {
    const found = await loader.resolve(name, kind);
    if (found) return found.plugin;
  }
  throw new Error(`没有 ${name} 的插件（plugins/${name}/${kind}.ts）`);
}
