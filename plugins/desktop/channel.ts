// The channel a new install starts with: a notification on this computer that there's something to look at. It can't take
// an answer; `agent-autoloop status` shows the card and `agent-autoloop answer` answers it.
//   "channels": { "desktop": { "key": "…" } } in config.json
//   "channels": { "desktop": { "name": "桌面通知" } } in rules.json
import { execFile } from "node:child_process";
import type { Card, ChannelContext } from "../../host/channels.ts";
// Saying there is no notifier sends cards down the skipped path, which is right and quiet, rather than failing each one
// on a command that isn't there. `doctor` reads the same answer, so the two can never say different things.
import { t } from "../../host/i18n.ts";
import { hasDesktopNotifier } from "../../host/notify.ts";

const APPLESCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];

/**
 * A card's title is whatever an Agent wrote, so it's only ever an argument, never part of a script. The `--` is what keeps
 * it one when it starts with a dash: without it osascript takes a title of `-e` as more script to run.
 */
export function notifyCommand(title: string, platform: string = process.platform): [string, string[]] {
  const body = `${title}\n${t("desktop.words")}`;
  const heading = t("desktop.title");
  if (platform === "darwin")
    return ["osascript", [...APPLESCRIPT.flatMap((line) => ["-e", line]), "--", heading, body]];
  return ["notify-send", ["--", heading, body]];
}

/** Not the sync call the other channels get away with: this runs in the hub's own process, and may wait on a dialog. */
function show(title: string) {
  const [program, args] = notifyCommand(title);
  return new Promise<void>((resolve, reject) => {
    execFile(program, args, { timeout: 30_000 }, (error) => (error ? reject(error) : resolve()));
  });
}

export default async function desktop({ hub, log, signal }: ChannelContext) {
  const available = hasDesktopNotifier();
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch (error) {
      log(t("desktop.hubUnreachable", { why: String(error) }));
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (!card) continue;
    // A notification is gone once shown: an update has nothing to do.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    if (!available) {
      await hub.delivered(card.id, card.version, `skipped-${card.id}`);
      continue;
    }
    try {
      await show(card.title);
      await hub.delivered(card.id, card.version, `shown-${card.id}`);
    } catch (error) {
      log(t("desktop.notSent", { card: card.id, why: String(error) }));
      await hub.failed(card.id, card.version, String(error)).catch(() => {});
    }
  }
}
