// What this machine is in the system: config.json, private to its owner. On a machine that runs everything it has all
// of these; a machine that only does work has the hub's address and a worker's key.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOME } from "./home.ts";
import { t, type Lang } from "./i18n.ts";
import { secureDir } from "./permissions.ts";

/**
 * How the scheduled task on Windows starts the hub: in a console window of its own, or with none. Only Windows reads
 * it — launchd and systemd have no window to show — and unset means `console`, which is what every install did before.
 */
export const HUB_WINDOWS = ["console", "hidden"] as const;
export type HubWindow = (typeof HUB_WINDOWS)[number];

export type ChannelConfig = { use?: string; key: string; [option: string]: unknown };
export type Config = {
  url: string;
  hub?: { listen: string; publicUrl?: string; window?: HubWindow };
  worker?: { name: string; key: string; capacity?: number; unreachable?: string[] };
  channels?: Record<string, ChannelConfig>;
  source?: { name: string; key: string };
  owner?: string;
  /** Which of the two Chinese scripts this install says things in (host/i18n.ts). Unset means: whatever the shell says. */
  lang?: Lang;
};

export const CONFIG_FILE = path.join(HOME, "config.json");

/** The hub's address: host:port, or [host]:port for an IPv6 address. A bare port is a mistake, not every interface. */
export function parseListen(listen: string) {
  const match = /^\[([0-9a-fA-F:.]+)\]:([0-9]+)$/.exec(listen) ?? /^([^:\s]+):([0-9]+)$/.exec(listen);
  if (!match) throw new Error(t("config.listen.shape", { listen }));
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(t("config.listen.port", { listen }));
  }
  return { host: match[1], port };
}

export function readConfig(): Config {
  if (!existsSync(CONFIG_FILE)) throw new Error(t("config.notInstalled"));
  const config = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
  const window = config.hub?.window;
  if (window !== undefined && !(HUB_WINDOWS as readonly string[]).includes(window as string)) {
    throw new Error(t("config.window", { window: String(window) }));
  }
  return config;
}

export function writeConfig(config: Config) {
  secureDir(HOME);
  writeFileSync(`${CONFIG_FILE}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
}
