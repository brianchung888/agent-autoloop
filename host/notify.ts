// Whether this computer can show a notification at all, and what to say when it cannot.
//
// Two things ask. The channel that shows them asks so that cards go down the skipped path rather than failing one by
// one on a program that isn't there. And `doctor` asks because the other thing it knows — that the channel is answering
// the hub — is not the same answer: a channel can be running, and in good order, and still not reach anybody. Saying
//「在线」 there would tell someone their Agent's questions arrive on this screen when they do not.
import { spawnSync } from "node:child_process";
import { t } from "./i18n.ts";

/** A program this takes to show a notification: there is one, or there is not. */
export function hasDesktopNotifier() {
  if (process.platform === "darwin") {
    // getuid is a POSIX call and missing on some platforms; this branch is the only one that asks for it.
    return spawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? -1}`], { stdio: "ignore" }).status === 0;
  }
  // Windows has a graphical session but no notifier this takes yet (D6a: the toast is a later piece of work).
  return process.platform === "linux" && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Why notifications don't arrive on this computer, in words a person can act on, or nothing when they do. */
export function desktopTrouble() {
  if (hasDesktopNotifier()) return null;
  if (process.platform === "win32") return t("notify.trouble.win");
  if (process.platform === "linux") return t("notify.trouble.linux");
  return t("notify.trouble.unknown");
}
