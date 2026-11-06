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
import {
  alive,
  bornAt,
  forgetProcesses,
  leftBehind,
  running,
  sampleTree,
  terminate,
  treeAlive,
} from "../worker/process.ts";

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

test("根没了、孙子还在：硬杀要逐个杀掉它们，否则这一轮永远交不出 cancelled", ONLY_WINDOWS, async (t) => {
  // launcher 可以先死，而它起的东西还在跑。那个号这时谁都不是，`taskkill /PID <号> /T /F` 从它往下走，
  // 走到的是空的（或者是别人的树，所以才有那道身份确认）。以前 terminate 在这里直接返回：树还活着，
  // treeAlive 一直说 true，worker 于是永远等不到「组内没有活进程」，一轮被 stop 的运行只会变成 failed。
  const noted = join(dir, "left-behind.pid");
  const parent = started(
    `const c=require("node:child_process").spawn(process.execPath,["-e","${SLEEP}"],{detached:true,stdio:"ignore"});` +
      `require("node:fs").writeFileSync(${JSON.stringify(noted)},String(c.pid));c.unref();${SLEEP}`,
  );
  t.after(() => {
    terminate(parent.pid, true);
    if (existsSync(noted)) terminate(Number(readFileSync(noted, "utf8")), true);
  });
  await until("它起来了", () => running(parent.pid!));
  const born = bornAt(parent.pid);
  const record = join(dir, "launch-left.json");
  writeFileSync(record, JSON.stringify({ pid: parent.pid, born }));
  await until("孙子起来了", () => treeAlive(parent.pid, record));
  const orphan = Number(readFileSync(noted, "utf8"));

  // 只杀父亲一个，不带 /T：这就是 launcher 先死的样子。
  process.kill(parent.pid!);
  await until("父没了", () => running(parent.pid!) === false || null);
  forgetProcesses();
  assert.equal(alive(parent.pid, "", record), false, "那个号已经不是这一轮的了");
  assert.equal(treeAlive(parent.pid, record), true, "可是它留下的那个还在跑");

  terminate(parent.pid, true, record);
  await until("留下的那个也走了", () => running(orphan) === false || null);
  assert.equal(running(orphan), false);
  forgetProcesses();
  assert.equal(treeAlive(parent.pid, record), false, "组内没有活进程了，这一轮才交得出 cancelled");
});

test("往下走到底，不是只看一层：孙子也算这一轮留下的", ONLY_WINDOWS, async (t) => {
  // 真实的一轮就是三层：launcher 起智能体，智能体再起它自己的东西。只按「根的孩子」展开，中间那层一没，
  // 它下面还在跑的就一个都找不着——树看起来是空的，这一轮交出 cancelled，而活儿还在干。
  const kids = join(dir, "three-deep.json");
  // 孙子那一层：起一个长命的，把它的号写下来，自己也不走。外面那一层用 JSON.stringify 整段塞进去，引号自己就对了。
  const middle =
    `const c=require("node:child_process").spawn(process.execPath,["-e","${SLEEP}"],{detached:true,stdio:"ignore"});` +
    `c.unref();require("node:fs").writeFileSync(${JSON.stringify(kids)},String(c.pid));${SLEEP}`;
  const root = started(
    `const c=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(middle)}],{detached:true,stdio:"ignore"});c.unref();${SLEEP}`,
  );
  const noted = () => (existsSync(kids) ? Number(readFileSync(kids, "utf8")) : 0);
  t.after(() => {
    terminate(root.pid, true);
    if (noted()) terminate(noted(), true);
  });
  await until("根起来了", () => running(root.pid!));
  const born = bornAt(root.pid);
  const record = join(dir, "launch-deep.json");
  writeFileSync(record, JSON.stringify({ pid: root.pid, born }));
  await until("孙子起来了", () => noted() !== 0 && running(noted()));

  // 根没了：这时才要去找它留下什么。孩子和孙子都还在，两个号都得找出来。
  process.kill(root.pid!);
  await until("根没了", () => running(root.pid!) === false || null);
  forgetProcesses();
  const left = leftBehind(root.pid!, record);
  assert.ok(Array.isArray(left), `根已经不在了，该给号而不是 ${left}`);
  assert.ok(left.length >= 2, `只找着 ${left.length} 个号：这还是只看了一层`);
  assert.ok(left.includes(noted()), "孙子的号不在里面：只看一层就只看得见中间那层");
  assert.equal(treeAlive(root.pid, record), true);

  // 硬杀是逐个杀这些号，所以孙子也走得掉，不靠 /T 去走一棵随时会掉一截的树。
  terminate(root.pid, true, record);
  await until("孙子也走了", () => running(noted()) === false || null);
  forgetProcesses();
  assert.equal(treeAlive(root.pid, record), false, "组内没有活进程了，这一轮才交得出 cancelled");
});

test("中间那层也没了以后，孙子还找得着：走到过的后代都记进 launch-N.json", ONLY_WINDOWS, async (t) => {
  // 上一条是「根没了、中间层还在」。真正漏掉的是中间层随后也走了：Windows 把父号永久留在孙子身上，而那个号这时
  // 谁都不是——从根往下走只走得到「根的孩子」，中间层已经不在表里，孙子于是一个都找不着。树看起来是空的，被 stop
  // 的一轮交出 cancelled，活儿还在干。所以每一次走树都把走到的后代连同创建时刻记回 launch-N.json：那一层还看得见
  // 的时候就写下来，之后它没了，记下的号加上创建时刻仍然验明得出孙子是这一轮的。
  const kids = join(dir, "both-gone.json");
  const middle =
    `const c=require("node:child_process").spawn(process.execPath,["-e","${SLEEP}"],{detached:true,stdio:"ignore"});` +
    `c.unref();require("node:fs").writeFileSync(${JSON.stringify(kids)},JSON.stringify({middle:process.pid,grand:c.pid}));${SLEEP}`;
  const root = started(
    `const c=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(middle)}],{detached:true,stdio:"ignore"});c.unref();${SLEEP}`,
  );
  const noted = () => (existsSync(kids) ? (JSON.parse(readFileSync(kids, "utf8")) as Record<string, number>) : null);
  t.after(() => {
    terminate(root.pid, true);
    for (const pid of Object.values(noted() ?? {})) terminate(pid, true);
  });
  await until("根起来了", () => running(root.pid!));
  const born = bornAt(root.pid);
  const record = join(dir, "launch-both-gone.json");
  writeFileSync(record, JSON.stringify({ pid: root.pid, born }));
  await until("孙子起来了", () => noted() !== null && running(noted()!.grand!));
  const { middle: middlePid, grand } = noted()!;

  // 根没了：这一拍走了一次树，走到了中间层和孙子。
  process.kill(root.pid!);
  await until("根没了", () => running(root.pid!) === false || null);
  forgetProcesses();
  const first = leftBehind(root.pid!, record);
  assert.ok(Array.isArray(first) && first.includes(middlePid!) && first.includes(grand!), `只走到 ${first}`);
  const written = JSON.parse(readFileSync(record, "utf8")) as { tree?: Record<string, string> };
  assert.ok(written.tree, "走到的后代没有记下来：下一拍中间层一没，孙子就再也找不着了");
  assert.match(String(written.tree[String(middlePid)]), /^\d+$/, "中间层的创建时刻要一起记下，否则验不明它是谁");
  assert.match(String(written.tree[String(grand)]), /^\d+$/);

  // 中间那层也走了，只杀它一个：这就是 round2 原文说的「根与中间层同死」之后的样子。
  process.kill(middlePid!);
  await until("中间层没了", () => running(middlePid!) === false || null);
  forgetProcesses();
  const later = leftBehind(root.pid!, record);
  assert.ok(Array.isArray(later) && later.includes(grand!), `中间层一没就找不着孙子了：${later}`);
  assert.equal(treeAlive(root.pid, record), true, "孙子还在跑着，这一轮还不能交 cancelled");

  // 而且硬杀真的杀得到它：这才是「确认组内没有活进程后才交 cancelled」成立的那一步。
  terminate(root.pid, true, record);
  await until("孙子也走了", () => running(grand!) === false || null);
  forgetProcesses();
  assert.equal(treeAlive(root.pid, record), false, "组内没有活进程了，这一轮才交得出 cancelled");
});

test("记不下来的不认：被回收的号和它的孩子都不算这一轮的", ONLY_WINDOWS, async (t) => {
  // 记下来的那一层，号被还回去又被别人捡走：创建时刻对不上，它就不是这一轮的后代了。它自己不能算活着，
  // 它的孩子也不能——否则一棵无关的树会被每个 tick 硬杀一次，而这一轮永远交不出 cancelled。
  const noted = join(dir, "seed-taken.pid");
  const holder = started(
    `const c=require("node:child_process").spawn(process.execPath,["-e","${SLEEP}"],{detached:true,stdio:"ignore"});` +
      `require("node:fs").writeFileSync(${JSON.stringify(noted)},String(c.pid));c.unref();${SLEEP}`,
  );
  t.after(() => {
    terminate(holder.pid, true);
    if (existsSync(noted)) terminate(Number(readFileSync(noted, "utf8")), true);
  });
  await until("它起来了", () => running(holder.pid!));
  const born = bornAt(holder.pid);
  await until("它的孩子起来了", () => existsSync(noted) && running(Number(readFileSync(noted, "utf8"))));
  const child = Number(readFileSync(noted, "utf8"));

  // 一个谁都不是的根号，加上一条「这个号是这一轮的后代」的记录，但记下的创建时刻是别人的。
  const record = join(dir, "launch-seed-taken.json");
  const nobody = 0x7ffffff0;
  forgetProcesses();
  writeFileSync(record, JSON.stringify({ pid: nobody, born: "1", tree: { [String(holder.pid)]: "1" } }));
  const left = leftBehind(nobody, record);
  assert.ok(Array.isArray(left), `这个号谁都不是，该给号而不是 ${left}`);
  assert.ok(!left.includes(holder.pid!), "创建时刻对不上，这个号已经是别人的了，不算这一轮的后代");
  assert.ok(!left.includes(child), "它的孩子比它晚出生，是新持有者自己的");

  // 对得上就认：同一条记录，只把创建时刻写对。
  forgetProcesses();
  writeFileSync(record, JSON.stringify({ pid: nobody, born: "1", tree: { [String(holder.pid)]: born } }));
  const mine = leftBehind(nobody, record);
  assert.ok(Array.isArray(mine) && mine.includes(holder.pid!), `记下的那一层对得上就该认：${mine}`);
  assert.ok(mine.includes(child), "它下面的也一起算这一轮的");
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

test("号被回收以后：别人的树不算这一轮的，也不会每个 tick 被硬杀", ONLY_WINDOWS, async (t) => {
  // 这一轮的 launcher 没了，号还回去，机器又把它给了另一个 node.exe（下面用「记录里的创建时刻比机器说的更早」
  // 来摆出同一个局面：号活着，但不是记录里那一个）。以前这里还是按本轮 born 当下界去走孩子——新持有者的孩子
  // 一定比本轮晚，于是树永远活着，被 stop 的一轮永远不变 cancelled，而且每个 tick 还要对那棵无关的树 taskkill /T /F。
  const noted = join(dir, "taken-over.pid");
  const holder = started(
    `const c=require("node:child_process").spawn(process.execPath,["-e","${SLEEP}"],{detached:true,stdio:"ignore"});` +
      `require("node:fs").writeFileSync(${JSON.stringify(noted)},String(c.pid));c.unref();${SLEEP}`,
  );
  t.after(() => {
    terminate(holder.pid, true);
    if (existsSync(noted)) terminate(Number(readFileSync(noted, "utf8")), true);
  });
  await until("新持有者起来了", () => running(holder.pid!));
  const born = bornAt(holder.pid);
  assert.match(String(born), /^\d+$/);

  const record = join(dir, "launch-taken.json");
  // 对得上的记录：孩子算这一轮的，树还活着——这是没被回收时的样子，不能一起改掉。
  writeFileSync(record, JSON.stringify({ pid: holder.pid, born }));
  await until("孩子起来了", () => treeAlive(holder.pid, record));
  const orphan = Number(readFileSync(noted, "utf8"));

  // 同一张机器状态，只把记录的创建时刻挪到这个号出生之前：这个号已经是别人的了。
  const earlier = String(BigInt(born!) > 10_000_000n ? BigInt(born!) - 10_000_000n : 1n);
  forgetProcesses();
  writeFileSync(record, JSON.stringify({ pid: holder.pid, born: earlier }));
  assert.equal(treeAlive(holder.pid, record), false, "新持有者的孩子不是这一轮的，这一轮才能交 cancelled");

  // 而且硬杀会先确认身份：那棵无关的树一个都不能少。
  terminate(holder.pid, true, record);
  await pause(300);
  assert.equal(running(holder.pid!), true, "号已经是别人的，不该被 taskkill /T /F 带走");
  assert.equal(running(orphan), true, "它的孩子也不该被带走");

  // 没有记录可读时，和改动前一样照杀：这是旧版本写下的那种记录。
  terminate(holder.pid, true, join(dir, "没有这个文件"));
  await until("照杀的那条路还在", () => running(holder.pid!) === false || null);
  assert.equal(running(holder.pid!), false);
});

test("根和中间层同时没了，孙子还找得着：一轮跑着的时候就把树取样记下来", ONLY_WINDOWS, async (t) => {
  // 上面那一条是「根先没、中间层后没」：根一没就走了一次树，中间层那时还看得见，于是被记了下来。真正剩下的窗口是
  // 根还活着的时候一次树都没走过——orphans 在「根活着而且还是启动的那一个」时直接答 true，launch-N.json 于是整轮
  // 都是空的。根和中间层在两拍之间一起没了，孙子身上那个父号这时谁都不是，机器上和记录里都没有一句话说它曾经是这
  // 一轮的：树看起来是空的，被 stop 的一轮交出 cancelled，而活儿还在干。所以跑着的时候也要隔一阵走一次树。
  process.env.AGENT_AUTOLOOP_TREE_SAMPLE = "300";
  t.after(() => {
    delete process.env.AGENT_AUTOLOOP_TREE_SAMPLE;
  });
  const kids = join(dir, "sampled.json");
  const middle =
    `const c=require("node:child_process").spawn(process.execPath,["-e","${SLEEP}"],{detached:true,stdio:"ignore"});` +
    `c.unref();require("node:fs").writeFileSync(${JSON.stringify(kids)},JSON.stringify({middle:process.pid,grand:c.pid}));${SLEEP}`;
  const root = started(
    `const c=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(middle)}],{detached:true,stdio:"ignore"});c.unref();${SLEEP}`,
  );
  const noted = () => (existsSync(kids) ? (JSON.parse(readFileSync(kids, "utf8")) as Record<string, number>) : null);
  t.after(() => {
    terminate(root.pid, true);
    for (const pid of Object.values(noted() ?? {})) terminate(pid, true);
  });
  await until("根起来了", () => running(root.pid!));
  const born = bornAt(root.pid);
  const record = join(dir, "launch-sampled.json");
  writeFileSync(record, JSON.stringify({ pid: root.pid, born }));
  await until("孙子起来了", () => noted() !== null && running(noted()!.grand!));
  const { middle: middlePid, grand } = noted()!;
  const written = () => JSON.parse(readFileSync(record, "utf8")) as { tree?: Record<string, string> };

  // 三层都在跑着：问树只答 true，没有谁去走它，记录里也还是空的。
  forgetProcesses();
  assert.equal(leftBehind(root.pid!, record), true, "根还活着而且就是启动的那一个，答案就是 true");
  assert.equal(written().tree, undefined, "根活着的时候没有谁会去走树——这就是那个窗口");

  // 等一个取样周期，取样走一次：答案照旧，但走到的每一层都记下来了。
  await pause(400);
  forgetProcesses();
  sampleTree(root.pid, record);
  assert.match(String(written().tree?.[String(middlePid)]), /^\d+$/, "中间层没被记下来");
  assert.match(String(written().tree?.[String(grand)]), /^\d+$/, "孙子没被记下来");

  // 同一个周期里再叫一次不会再走一遍：整张进程表是将近一秒的机器时间，每一拍都付一次谁都受不了。
  writeFileSync(record, JSON.stringify({ pid: root.pid, born }));
  sampleTree(root.pid, record);
  assert.equal(written().tree, undefined, "同一个取样周期里又把整张表走了一遍");
  await pause(400);
  forgetProcesses();
  sampleTree(root.pid, record);
  assert.ok(written().tree, "下一个周期该再走一次");

  // 这才是这一条要的那一幕：根和中间层同时没了，孙子还在跑。
  process.kill(root.pid!);
  process.kill(middlePid!);
  await until("根没了", () => running(root.pid!) === false || null);
  await until("中间层也没了", () => running(middlePid!) === false || null);
  forgetProcesses();
  const left = leftBehind(root.pid!, record);
  assert.ok(Array.isArray(left) && left.includes(grand!), `根和中间层同时没了就找不着孙子了：${left}`);
  assert.equal(treeAlive(root.pid, record), true, "孙子还在跑着，这一轮还不能交 cancelled");

  // 而且硬杀真的杀得到它：这才是「确认组内没有活进程后才交 cancelled」成立的那一步。
  terminate(root.pid, true, record);
  await until("孙子也走了", () => running(grand!) === false || null);
  forgetProcesses();
  assert.equal(treeAlive(root.pid, record), false, "组内没有活进程了，这一轮才交得出 cancelled");
});
