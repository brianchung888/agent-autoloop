// Looking at a launched run and stopping it, on this machine, with real processes. Nothing here stands in for anything:
// the point of worker/process.ts is what the operating system actually answers, and a stand-in would answer for it.
//
// Failure cases: a process that is going is called gone, so a run is given up on while its agent works; a process that is
// gone is called going, so a turn waits for the timeout; something that could not be looked at is called gone, and the
// worker hands in `cancelled` with the tree still running (docs/protocol.md: 确认组内没有活进程后才交 cancelled); a tree
// outlives the stop it was asked for; a number that is nobody's is taken for somebody.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { alive, bornAt, forgetProcesses, running, terminate, treeAlive } from "../worker/process.ts";

const WINDOWS = process.platform === "win32";
/** Long enough that nothing here finishes by itself; the test ends it. */
const SLEEP = "setTimeout(() => {}, 600000)";

const ONLY_WINDOWS = {
  skip: !WINDOWS && "这一条讲的是 Windows 把进程号还回去以后拿什么认人；POSIX 读 ps 的命令行，上面一条已经覆盖",
};

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-process-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits up to five seconds for something to become true, so nothing here depends on how fast this machine is. */
async function until(what: string, ready: () => boolean | null) {
  for (let tries = 0; tries < 250; tries++) {
    if (ready() === true) return;
    await pause(20);
  }
  assert.fail(what);
}

/** A process of its own group (POSIX) or its own tree root (Windows), with one child under it. */
function started(code: string) {
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

test("a live process is alive, and the number of a gone one is not", async (t) => {
  const child = started(SLEEP);
  t.after(() => terminate(child.pid, true));
  await until("it started", () => running(child.pid!));
  assert.equal(running(child.pid!), true);
  // `marker` is what POSIX reads out of the command line; on Windows the launcher's own image is what is matched.
  assert.equal(alive(child.pid, WINDOWS ? "" : "-e"), true);

  const gone = started("0");
  await new Promise((resolve) => gone.once("exit", resolve));
  // Windows keeps a number for a moment after the process that held it has gone.
  await until("the number stopped being a process", () => running(gone.pid!) === false || null);
  assert.equal(running(gone.pid!), false);
});

test("nothing is a process, and neither is nothing at all", () => {
  assert.equal(running(0), false);
  assert.equal(running(-1), false);
  assert.equal(running(1.5), false);
  assert.equal(alive(undefined, "x"), false);
  assert.equal(treeAlive(undefined), false);
});

test("a tree is alive while anything in it is, and the answer is never a guess", async (t) => {
  // The parent waits on a child of its own, so the tree outlives neither of them on its own.
  const child = started(
    `require("node:child_process").spawn(process.execPath,["-e","${SLEEP}"],{stdio:"ignore"});${SLEEP}`,
  );
  t.after(() => terminate(child.pid, true));
  await until("the tree started", () => treeAlive(child.pid));
  const seen = treeAlive(child.pid);
  assert.equal(seen, true, "a tree with two live processes in it");
});

test("asked to stop, a whole tree goes", async (t) => {
  const child = started(
    `require("node:child_process").spawn(process.execPath,["-e","${SLEEP}"],{stdio:"ignore"});${SLEEP}`,
  );
  t.after(() => terminate(child.pid, true));
  await until("the tree started", () => treeAlive(child.pid));
  // Windows posts a message a program without a window never reads, so only the forced kill ends such a tree.
  terminate(child.pid, WINDOWS);
  await until("the tree went", () => treeAlive(child.pid) === false || null);
  assert.equal(treeAlive(child.pid), false, "nothing in the group is left, which is what lets a run be `cancelled`");
});

test("stopping nothing is not an error", () => {
  assert.doesNotThrow(() => terminate(undefined, false));
  assert.doesNotThrow(() => terminate(undefined, true));
  // A number nobody holds: whatever the platform says, it must not throw into the worker's loop.
  assert.doesNotThrow(() => terminate(0x7ffffff0, true));
});

test(
  "一个 tick 里问多少次，机器只被问一次",
  { skip: !WINDOWS && "只有 Windows 要列整张进程表；POSIX 的 ps 一次就够，没有可省的" },
  () => {
    // 树不在了才需要整张表，所以这里问的是一个谁都不是的号：第一次要等机器列表，之后在同一个 tick 里不再等。
    const nobody = 0x7ffffff0;
    forgetProcesses();
    const first = Date.now();
    assert.notEqual(treeAlive(nobody), true);
    const asked = Date.now() - first;
    const second = Date.now();
    assert.notEqual(treeAlive(nobody), true);
    assert.ok(
      Date.now() - second < Math.max(asked / 2, 200),
      `又问了一次机器：${asked}ms 之后还要 ${Date.now() - second}ms`,
    );
    // 新的 tick 说一声，就重新问。
    forgetProcesses();
    assert.notEqual(treeAlive(nobody), true);
  },
);

test("父进程死了以后，留在孩子身上的父号不能让这一轮永远活着", ONLY_WINDOWS, async (t) => {
  // Windows 永久保留「父进程号」这一项：父没了、号还回去了、号给了别人，孩子身上写的还是那个号。只按父号展开，机器上任何
  // 一个「父已死、父号刚好等于本轮 launcher 号」的进程都让树看起来永远活着——被 stop 的一轮于是永远不变 cancelled，
  // 每个 tick 还要再硬杀一次，连无关的残留进程一起杀。所以要比创建时刻：本轮起的东西不可能比本轮本身更早。
  const noted = join(dir, "orphan.pid");
  const parent = started(
    `const c=require("node:child_process").spawn(process.execPath,["-e","${SLEEP}"],{detached:true,stdio:"ignore"});` +
      `require("node:fs").writeFileSync(${JSON.stringify(noted)},String(c.pid));c.unref();${SLEEP}`,
  );
  t.after(() => {
    terminate(parent.pid, true);
    if (existsSync(noted)) terminate(Number(readFileSync(noted, "utf8")), true);
  });
  await until("它起来了", () => running(parent.pid!));
  const parentBorn = bornAt(parent.pid);
  assert.match(String(parentBorn), /^\d+$/);

  forgetProcesses();
  const table = join(dir, "launch-tree.json");
  writeFileSync(table, JSON.stringify({ pid: parent.pid, born: parentBorn }));
  await until("孩子起来了", () => treeAlive(parent.pid, table));

  // 父没了，孩子还在：这是真的孤儿，还算这一轮的树。只杀父亲一个——terminate 的 /T 会连孩子一起带走。
  process.kill(parent.pid!);
  await until("父没了", () => running(parent.pid!) === false || null);
  forgetProcesses();
  assert.equal(treeAlive(parent.pid, table), true, "比这一轮晚出生的孩子，是这一轮留下的");

  // 同一张机器状态，只把「这一轮什么时候开始」挪到孩子出生之后：那孩子就不可能是这一轮起的，树是空的。
  const later = String(BigInt(parentBorn!) + 10_000_000_000n);
  writeFileSync(table, JSON.stringify({ pid: parent.pid, born: later }));
  assert.equal(treeAlive(parent.pid, table), false, "残留的父号不算活着，这一轮才能交 cancelled");
  // 而且没有谁被杀掉：孤儿是机器上一个真进程，这里只是不再把它算成这一轮的。
  assert.equal(running(Number(readFileSync(noted, "utf8"))), true, "那个孤儿还在跑着，没有被连带杀掉");
});

test("号被别人捡走就不是这个 run 了：比对 launch-N.json 记下的创建时刻", ONLY_WINDOWS, async (t) => {
  const child = started(SLEEP);
  t.after(() => terminate(child.pid, true));
  await until("it started", () => running(child.pid!));
  const born = bornAt(child.pid);
  assert.match(String(born), /^\d+$/, "这台机器说得出这个号是什么时候来的");

  const record = join(dir, "launch-1.json");
  // 先问不对的：一个同号、但创建时刻是别人的记录。tasklist 只会说「这个号是个 node.exe」，那还不够。
  writeFileSync(record, JSON.stringify({ pid: child.pid, startedAt: 0, marker: "x", born: "1" }));
  assert.equal(alive(child.pid, "", record), false, "创建时刻对不上，这个号已经是别人的了");

  forgetProcesses();
  writeFileSync(record, JSON.stringify({ pid: child.pid, startedAt: 0, marker: "x", born }));
  assert.equal(alive(child.pid, "", record), true, "对得上就是它");

  // 旧版本写下的记录没有这一项，记错号的记录说的也不是这个 run：两者都不能当成「它没了」。
  forgetProcesses();
  writeFileSync(record, JSON.stringify({ pid: child.pid, startedAt: 0, marker: "x" }));
  assert.equal(alive(child.pid, "", record), true);
  writeFileSync(record, JSON.stringify({ pid: child.pid! + 100000, born: "1" }));
  assert.equal(alive(child.pid, "", record), true);
  // 没有记录可读时，和改动前一样只看号与映像名。
  assert.equal(alive(child.pid, "", join(dir, "没有这个文件")), true);

  // 确认过的事记的是「这个号配这个时刻」，不是「这个号」。只按号记的话，号被还回去又被捡走之后，这里会一直说还是它。
  forgetProcesses();
  writeFileSync(record, JSON.stringify({ pid: child.pid, born }));
  assert.equal(alive(child.pid, "", record), true, "对得上，记下来");
  writeFileSync(record, JSON.stringify({ pid: child.pid, born: "1" }));
  assert.equal(alive(child.pid, "", record), false, "同一个号、另一个时刻，记下的那次不算数");
});

test("问一个号的创建时刻，用不着列整张进程表，也不扔掉这个 tick 已经问到的", ONLY_WINDOWS, async (t) => {
  const nobody = 0x7ffffff0;
  const child = started(SLEEP);
  t.after(() => terminate(child.pid, true));
  await until("它起来了", () => running(child.pid!));

  // 整张表要等机器列完，这是 worker 每个 tick 的代价；bornAt 每次 launch 又要再付一次，而且以前还要先把表扔掉。
  forgetProcesses();
  const listing = Date.now();
  assert.notEqual(treeAlive(nobody), true);
  const whole = Date.now() - listing;

  const one = Date.now();
  const born = bornAt(child.pid);
  const asked = Date.now() - one;
  assert.match(String(born), /^\d+$/, "问得出来");
  assert.ok(asked < whole, `问一个号要 ${asked}ms，列整张表要 ${whole}ms`);

  // 这个 tick 已经问到的还在：launch 之后再问树，不该让机器把整张表再列一遍。
  const again = Date.now();
  assert.notEqual(treeAlive(nobody), true);
  assert.ok(Date.now() - again < Math.max(whole / 2, 400), "bornAt 把这个 tick 的进程表扔掉了");

  // 而且那张表还多知道了刚问的那个号：它被列出来的时候，这个进程还不存在。
  const record = join(dir, "launch-born.json");
  writeFileSync(record, JSON.stringify({ pid: child.pid, born }));
  assert.equal(alive(child.pid, "", record), true, "就是它");
  writeFileSync(record, JSON.stringify({ pid: child.pid, born: "1" }));
  assert.equal(alive(child.pid, "", record), false, "别的时刻就不是它");
});
