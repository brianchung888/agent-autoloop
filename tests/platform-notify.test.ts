// What this computer can show a notification with, asked of this computer. The desktop channel and `doctor` read the
// same answer here, which is the whole point of the file: one of them deciding to skip a card while the other prints
//「在线」 is how somebody comes to believe their Agent's questions are arriving when they are not.
//
// Failure cases: Windows is said to have a notifier, so every card fails on a program that isn't there; it is said to
// have none and nothing says so, so the cards are skipped in silence; the words say nothing a person can act on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopTrouble, hasDesktopNotifier } from "../host/notify.ts";

const WINDOWS = process.platform === "win32";

test("Windows 上没有通知程序，而且明确说出来", { skip: !WINDOWS && "这一条讲的是 Windows 的降级" }, () => {
  assert.equal(hasDesktopNotifier(), false);
  assert.equal(desktopTrouble(), "桌面通知不可用：Windows 上没有可用的通知程序，卡片会跳过通知");
});

test("有通知程序就什么都不说，没有就说得出原因", () => {
  const trouble = desktopTrouble();
  if (hasDesktopNotifier()) assert.equal(trouble, null);
  else assert.match(String(trouble), /^桌面通知不可用：.+，卡片会跳过通知$/);
});
