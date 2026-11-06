// The single-hub lock where there is a `ps` to read a command line back off a number. Failure case: a number given away
// after a forced stop still carries the token this install left behind, so the lock sticks for as long as whatever holds
// that number runs and `up` never starts again.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { skipOn } from "./helpers.ts";

/** 整份文件在 Windows 上跳过，理由写进每一条 skip 里。 */
const test = skipOn(
  ["win32"],
  "这份测试讲的是读 ps 的命令行认人；Windows 上读不到命令行，那条路由 tests/platform-service.test.ts 覆盖",
);
import { setup } from "./helpers.ts";

const home = setup("service-lock");
const { claimUp, runningUp } = await import("../host/service.ts");

const pidFile = join(home, "up.pid");
const tokenFile = join(home, "up.token");
const started = (args: string[]) => spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", ...args]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test("token 对得上还不够：读得到命令行的地方，那个号还得真的在跑 up", async (t) => {
  // 硬杀之后 up.pid 和 up.token 都还在，号早还给了系统。token 是文件对文件，留下的文件永远对得上自己；真正说明
  // 「现在拿着这个号的是个 up」的只有命令行。只比 token 的话，机器上随便哪个进程捡到这个号，锁就永远黏住。
  const other = started([]);
  t.after(() => other.kill("SIGKILL"));
  await settle();
  writeFileSync(tokenFile, "left-behind\n");
  writeFileSync(pidFile, JSON.stringify({ pid: other.pid, token: "left-behind", born: null }));
  assert.equal(runningUp(), null, "号被别人捡走了，token 再对也不是这把锁");

  // 而命令行像个 up 的，就是它：这是本来的语义，加了 token 之后也不能丢。
  const real = started([join("app", "bin", "agent-autoloop.ts"), "up"]);
  t.after(() => real.kill("SIGKILL"));
  await settle();
  writeFileSync(pidFile, JSON.stringify({ pid: real.pid, token: "left-behind", born: null }));
  assert.equal(runningUp(), real.pid, "命令行和 token 都对得上，这才是在跑的那个");

  // 没有 token 文件的老版本，照旧只看命令行。
  rmSync(tokenFile, { force: true });
  assert.equal(runningUp(), real.pid);
  writeFileSync(pidFile, JSON.stringify({ pid: other.pid, token: "left-behind", born: null }));
  assert.equal(runningUp(), null);
});

test("自己持锁的时候，这两样都对得上", () => {
  const release = claimUp();
  try {
    // 这个进程跑的是测试，不是 up：命令行对不上，所以这里要的是「不会把别人的号算成锁」而不是 process.pid。
    assert.notEqual(runningUp(), "unknown");
  } finally {
    release();
  }
  assert.equal(runningUp(), null, "松手以后两个文件都没了");
});
