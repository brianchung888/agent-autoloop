// Keeping it running, and letting go of it, on this machine. The parts that are only words — what goes into a scheduled
// task — are checked everywhere; the parts that are the operating system answering are run for real on Windows and
// skipped elsewhere, with the reason written down rather than left to be guessed at.
//
// Failure cases: a path with a space in it arrives as two arguments, or one with a quote in it is written out as if it
// could not break the quoting; the trigger that comes round again can start a second hub beside the first; a task
// somebody else registered under the same name is taken for ours and deleted; `up` is said to be running because its
// number is a number, or said not to be because `ps` is not there to ask; what `up` leaves behind stops the next one.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const WINDOWS = process.platform === "win32";
/** POSIX keeps launchd and systemd, which these tests do not install; what is checked here is only what Windows adds. */
const notWindows = {
  skip: WINDOWS
    ? false
    : "只有 Windows 走计划任务这条路；launchd 与 systemd 的分支由 service.test.ts 和 service-running.test.ts 覆盖",
};

const home = setup("platform-service");
const { claimUp, runningUp, stopFile, stopUp } = await import("../host/service.ts");
const { environment, installMark, installTask, registeredXml, removeTask, taskEnabled, taskOwned, taskXml } =
  await import("../host/service-win.ts");

const ordinary = {
  label: "agent-autoloop-test",
  home: String.raw`C:\Users\me\Agent Work\.agent-autoloop`,
  executable: String.raw`C:\Program Files\nodejs\node.exe`,
  program: String.raw`C:\Users\me\Agent Work\.agent-autoloop\app\bin\agent-autoloop.ts`,
  startBoundary: "2026-01-01T00:00:00",
};

test("a task runs this node with this program, each path one argument", () => {
  const written = taskXml(ordinary);
  assert.ok(written.includes(`<Command>${ordinary.executable}</Command>`));
  assert.ok(
    written.includes(
      `<Arguments>&quot;--env-file=${ordinary.home}\\service.env&quot;` +
        ` &quot;--disable-warning=ExperimentalWarning&quot; &quot;${ordinary.program}&quot; &quot;up&quot;</Arguments>`,
    ),
    written,
  );
  assert.ok(written.includes(`<WorkingDirectory>${ordinary.home}</WorkingDirectory>`));
  // And it carries what this install knows itself by, in characters that survive every console code page.
  const mark = installMark(ordinary.home, ordinary.program);
  assert.match(mark, /^install:[0-9a-f]{16}$/);
  assert.ok(written.includes(`[${mark}]</Description>`), written);
  assert.notEqual(mark, installMark(String.raw`C:\another\home`, ordinary.program), "另一个 HOME 是另一个安装");
  assert.notEqual(mark, installMark(ordinary.home, String.raw`C:\another\program.ts`), "另一个程序也是");
});

test("the trigger comes round again and never starts a second one", () => {
  const written = taskXml(ordinary);
  assert.ok(written.includes("<Interval>PT5M</Interval>"), "it is tried again while it isn't there");
  assert.ok(
    written.includes("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"),
    "and never twice at once",
  );
  assert.ok(written.includes("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"), "and is never stopped for taking long");
  assert.ok(written.includes("<StartBoundary>2026-01-01T00:00:00</StartBoundary>"));
});

test("a logon trigger is asked for, and the task is whole without one", () => {
  assert.ok(taskXml({ ...ordinary, atLogon: true }).includes("<LogonTrigger>"));
  assert.ok(!taskXml({ ...ordinary, atLogon: false }).includes("<LogonTrigger>"));
  // Either way the repeat is there: that is what brings the hub back, and the logon is only sooner.
  assert.ok(taskXml({ ...ordinary, atLogon: false }).includes("<TimeTrigger>"));
});

test("a path that could break the quoting is refused rather than written out", () => {
  for (const bad of ['C:\\say"hi"\\node.exe', "C:\\one\ttwo", "C:\\one\ntwo"]) {
    assert.throws(() => taskXml({ ...ordinary, program: bad }), /引号或控制字符/);
  }
  // The env file is a value, not a line: a newline in it would be a second setting.
  assert.throws(() => environment("C:\\one\nAGENT_AUTOLOOP_HOME=C:\\two"), /换行/);
  assert.equal(environment(ordinary.home), `AGENT_AUTOLOOP_HOME="${ordinary.home}"\n`);
});

test("a task of ours is registered, found, and taken away again", notWindows, () => {
  const where = join(home, "task");
  mkdirSync(where, { recursive: true });
  const options = { ...ordinary, label: "agent-autoloop-platform-test", home: where, executable: process.execPath };
  try {
    installTask(options);
    assert.notEqual(registeredXml(options.label), null, "it is registered");
    assert.equal(taskOwned(options.label, where, options.program), true, "and it is the one this install wrote");
    assert.equal(
      taskOwned(options.label, where, String.raw`C:\somewhere\else\agent-autoloop.ts`),
      false,
      "not anyone's",
    );
    // 另一个安装（另一个 HOME）用同一个名字注册的任务，不是这一个的。只要「同名任务存在」加「本机 service.xml 提到
    // 自己的 program」就算自己的话，这两件事同时成立太容易了，uninstall 会把别人的常驻删掉。
    assert.equal(taskOwned(options.label, join(home, "另一个安装"), options.program), false, "别的安装写的不是自己的");
    assert.equal(taskEnabled(options.label), true);
    assert.ok(existsSync(join(where, "service.env")), "the home it runs with is beside it");

    // Somebody else's task by that name stays: nothing but the mark in its description says it is ours.
    removeTask(options.label, where, String.raw`C:\somewhere\else\agent-autoloop.ts`);
    assert.notEqual(registeredXml(options.label), null, "a task that names another program is left alone");

    removeTask(options.label, where, options.program);
    assert.equal(registeredXml(options.label), null, "ours is gone");
    assert.equal(existsSync(join(where, "service.env")), false);
  } finally {
    removeTask(options.label, where, options.program);
  }
});

test("安装路径里有中文时，卸载照样认得出这个任务是自己的", notWindows, () => {
  // Through the console's code page a path with characters like these in it comes back as something else, so nothing
  // in the registered XML matches what this install knows itself by, and `uninstall` leaves a scheduled task behind
  // for good. What says whose the task is has to be something written in an encoding this program chose.
  const where = join(home, "我的文件 任务");
  mkdirSync(where, { recursive: true });
  const options = {
    ...ordinary,
    label: "agent-autoloop-platform-test-cn",
    home: where,
    executable: process.execPath,
    program: join(where, "app", "bin", "agent-autoloop.ts"),
  };
  try {
    installTask(options);
    assert.notEqual(registeredXml(options.label), null, "it is registered");
    assert.equal(taskOwned(options.label, where, options.program), true, "中文路径也认得出来");
    removeTask(options.label, where, options.program);
    assert.equal(registeredXml(options.label), null, "拿掉了，没有留下计划任务");
  } finally {
    // Whatever went wrong above, nothing of this test may be left registered on the machine.
    spawnSync("schtasks", ["/Delete", "/TN", options.label, "/F"], { stdio: "ignore", timeout: 60_000 });
  }
});

test("`up` is running only when its number is a live process that left a token", () => {
  const pid = join(home, "up.pid");
  const token = join(home, "up.token");
  rmSync(pid, { force: true });
  rmSync(token, { force: true });
  assert.equal(runningUp(), null, "nothing written down, nothing running");

  // A number that is not a number, and one nobody could hold.
  writeFileSync(pid, "not a number\n");
  assert.equal(runningUp(), null);
  writeFileSync(pid, "0\n");
  assert.equal(runningUp(), null);

  const release = claimUp();
  const claim = JSON.parse(readFileSync(pid, "utf8")) as {
    pid: number;
    token: string;
    born: string | null;
    startedAt: string;
  };
  assert.equal(claim.pid, process.pid, "the number stays readable by a person");
  assert.equal(claim.token, readFileSync(token, "utf8").trim(), "and a token says who left it");
  assert.ok(Date.parse(claim.startedAt) > 0, "and when");
  if (WINDOWS) assert.match(String(claim.born), /^\d+$/, "连这个号是什么时候来的也记下来，不然留下的文件认不出来");
  assert.equal(runningUp(), process.pid);
  release();
  assert.equal(existsSync(pid), false, "letting go takes both away");
  assert.equal(existsSync(token), false);
  assert.equal(runningUp(), null);
});

test("what a killed `up` leaves behind never stops the next one", notWindows, async (t) => {
  const pid = join(home, "up.pid");
  const token = join(home, "up.token");
  // Exactly what a forced stop leaves: both files, and a number that something else holds by now. A whole number is
  // the one thing that cannot be taken as proof, or a hub stops coming back for as long as that number is in use.
  const other = spawn("cmd.exe", ["/c", "ping -n 30 127.0.0.1 > NUL"], { stdio: "ignore" });
  t.after(() => other.kill());
  await new Promise((resolve) => setTimeout(resolve, 200));
  writeFileSync(token, "left-behind");
  writeFileSync(pid, JSON.stringify({ pid: other.pid, token: "left-behind", startedAt: new Date().toISOString() }));
  assert.equal(runningUp(), null, "somebody else's number, token or no token");

  // And this very process, which is this program's runtime, with a token that does not go with the one beside it.
  writeFileSync(pid, JSON.stringify({ pid: process.pid, token: "another run's", startedAt: "2020-01-01T00:00:00Z" }));
  assert.equal(runningUp(), null, "a token that doesn't match is nobody's lock");
  writeFileSync(pid, String(process.pid));
  assert.equal(runningUp(), null, "and a bare number from an older version is not a lock on Windows either");

  // 而且那个号可以是一个真正的 node.exe：`uninstall --yes` 自己就会留下这两个文件（硬杀在 release 之前），等机器上
  // 随便哪个 node 捡到这个号，「活着」「是本程序的运行时」「token 也对」就全都成立——锁于是黏住，hub 再也起不来。
  const node = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => node.kill());
  await new Promise((resolve) => setTimeout(resolve, 500));
  writeFileSync(pid, JSON.stringify({ pid: node.pid, token: "left-behind", born: "1" }));
  assert.equal(runningUp(), null, "号是个真 node.exe、token 也对，但这个号不是那时候来的");

  // Taking the lock is what replaces all of it, so nothing has to be cleaned up by hand first.
  const release = claimUp();
  t.after(release);
  assert.equal(runningUp(), process.pid);
});

test("记录里没有创建时刻，这把锁就是看不清，不是空的", notWindows, async (t) => {
  const pid = join(home, "up.pid");
  const token = join(home, "up.token");
  // 机器不肯说这个号是什么时候来的（bornAt 吞掉回 null），claimUp 就写下 born:null。少了这一项，留下的文件和真正
  // 在跑的 up 长得一模一样：号活着、是本程序的运行时、token 也对。以前这里按「对不上」算，锁当成空的，第二个 hub
  // 于是开同一个 SQLite 文件。
  const node = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  t.after(() => node.kill());
  await new Promise((resolve) => setTimeout(resolve, 500));
  writeFileSync(token, "no-born");
  writeFileSync(pid, JSON.stringify({ pid: node.pid, token: "no-born", born: null }));
  assert.equal(runningUp(), "unknown", "认不出来就不是「没人在跑」");

  // 有这一项、而且对不上，才是真的不是它。
  writeFileSync(pid, JSON.stringify({ pid: node.pid, token: "no-born", born: "1" }));
  assert.equal(runningUp(), null, "写下了创建时刻、又对不上，这才是留下的文件");
  rmSync(pid, { force: true });
  rmSync(token, { force: true });
});

test("列不出进程的时候，这把锁谁都不许抢", notWindows, (t) => {
  const release = claimUp();
  t.after(release);
  assert.equal(runningUp(), process.pid, "先真的有人持锁");

  // tasklist 在 System32 里。把它从 PATH 上拿掉，机器就只能回「看不出来」。以前这被当成「没人在跑」，第二个 up 于是
  // 覆盖掉第一个的锁，两个 hub 开同一个 SQLite 文件——计划任务的 IgnoreNew 本来就挡掉了重复触发，宁可不抢。
  const was = process.env.PATH;
  t.after(() => {
    process.env.PATH = was;
  });
  process.env.PATH = join(home, "这里什么都没有");
  assert.equal(runningUp(), "unknown", "看不清就不是「没人在跑」");

  process.env.PATH = was;
  assert.equal(runningUp(), process.pid, "看得见了，还是这把锁");
});

test("stopping nothing writes nothing and leaves nothing", () => {
  rmSync(join(home, "up.pid"), { force: true });
  stopUp();
  assert.equal(existsSync(stopFile()), false, "nobody is being asked");
});
