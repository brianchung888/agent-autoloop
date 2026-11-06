// Where the built-ins are, for a build that has no folders to look in. A packaged binary carries no `plugins/` tree and
// cannot `import()` a path that is not there, so what it has instead is a list a build step wrote out: one static import
// per built-in, which is the only form a bundler can follow.
//
// The list is handed in rather than read, and that is deliberate. Nothing here imports `build/builtins.generated.ts`:
// that file is not in the version control (scripts/build-registry.ts writes it), and a source-mode install therefore
// has no registry at all — `builtins()` is null, the loader that asks finds nothing, and `loadPlugin` behaves exactly
// as it did before any of this existed. A packaged build imports the generated file once, as it starts, and the list
// registers itself. It is also what keeps tests/purity.test.ts true without a word of allowlist: no file in the version
// control imports a plugin, and none of them knows a product by name.
export type Registry = Readonly<Record<string, () => Promise<{ default: unknown }>>>;

/** `<name>/<kind>`, the one spelling both the generator and the loader use. */
export const registryKey = (name: string, kind: string) => `${name}/${kind}`;

let registered: Registry | null = null;

/** Called once, by the generated list, as a packaged build starts. */
export function registerBuiltins(registry: Registry) {
  registered = registry;
}

/** The list, or null where there is none — which is every source-mode install. */
export function builtins(): Registry | null {
  return registered;
}
