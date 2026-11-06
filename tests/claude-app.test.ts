// Finding the Claude Code the desktop app ships. Failure case: the app keeps files such as auto-update-state.json next
// to its version folders, and reading one of them as a folder throws ENOTDIR, so every Claude turn fails instead of
// using the copy that is there.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skipOn } from "./helpers.ts";

/** 整份文件在 Windows 上跳过，理由写进每一条 skip 里。 */
const test = skipOn(
  ["darwin", "linux"],
  "这份测试靠 process.env.HOME 换掉家目录来摆桌面应用的版本目录；Windows 上 os.homedir() 看的是 USERPROFILE，应用自己的位置也不同（见 plugins/claude/agent.ts 的 win32 候选）",
);
import { setup } from "./helpers.ts";

const { inTheApp } = await import("../plugins/claude/agent.ts");

test("the app's own files beside its versions are skipped", () => {
  const home = setup("claude-app");
  const root = join(home, "Library/Application Support/Claude/claude-code");
  mkdirSync(join(root, "2.1.309", "build-a"), { recursive: true });
  mkdirSync(join(root, "2.1.317", "build-b"), { recursive: true });
  writeFileSync(join(root, "auto-update-state.json"), "{}");
  writeFileSync(join(root, "auto-update-candidate.json"), "{}");
  const usual = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.deepEqual(inTheApp(), [
      join(root, "2.1.317", "build-b", "claude.app/Contents/MacOS/claude"),
      join(root, "2.1.309", "build-a", "claude.app/Contents/MacOS/claude"),
    ]);
  } finally {
    process.env.HOME = usual;
  }
});
