// Whether this computer can show a notification at all, and what to say when it cannot.
//
// Two things ask. The channel that shows them asks so that cards go down the skipped path rather than failing one by
// one on a program that isn't there. And `doctor` asks because the other thing it knows — that the channel is answering
// the hub — is not the same answer: a channel can be running, and in good order, and still not reach anybody. Saying
//「在线」 there would tell someone their Agent's questions arrive on this screen when they do not.
import { spawnSync } from "node:child_process";

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
  if (process.platform === "win32") return "桌面通知不可用：Windows 上没有可用的通知程序，卡片会跳过通知";
  if (process.platform === "linux") {
    return "桌面通知不可用：这台电脑没有图形会话（DISPLAY 和 WAYLAND_DISPLAY 都没设），卡片会跳过通知";
  }
  return "桌面通知不可用：问不到这台电脑的图形会话，卡片会跳过通知";
}
