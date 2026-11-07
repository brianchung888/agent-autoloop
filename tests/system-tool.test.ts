// The Windows programs this one runs are found by their full path and not along `PATH`. Failure cases: a machine whose
// `PATH` has no `System32` in it answers `null` from `bornAt`, and `null` is「看不清」rather than「不在」— so the
// single-instance lock holds a claim nothing can be compared against, Task Scheduler cannot bring the hub back, and
// `update` and `uninstall` cannot tell whether a hub is running (phase3-verification-round4.md 1); or the full path is
// used where there is none to use, and a machine that keeps its tools elsewhere loses them altogether.
//
// The trimmed `PATH` is given to a real child process rather than set on this one: `PATH` is read by the runtime when
// it starts a process, and a test that put it back wrong would take `git`, `node` and `schtasks` away from every test
// that runs after it in this same process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { system32, systemTool } from "../host/system-tool.ts";
import { skipOn, skipUnless } from "./helpers.ts";

const root = join(import.meta.dirname, "..");
const WINDOWS = process.platform === "win32";
const onWindows = skipUnless(WINDOWS, "这五个程序是 Windows 自己的，别的平台上裸名就是对的");
const elsewhere = skipOn(["win32"], "这一条问的是「不是 Windows 的时候」，所以不在 Windows 上问");

/** The five, as the three callers ask for them: worker/process.ts, host/service-win.ts, host/permissions.ts. */
const FIVE = ["powershell", "tasklist", "taskkill", "schtasks", "icacls"] as const;

/** One expression, in a child process whose environment is exactly what this case says. */
function inChild(code: string, environment: Record<string, string>) {
  const ran = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: environment,
    },
  );
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}${ran.error?.message ?? ""}`);
  return ran.stdout.trim();
}

onWindows("五个程序都用 System32 的绝对路径，而且那个文件真的在", () => {
  const folder = system32();
  assert.ok(folder, "这台 Windows 没说 SystemRoot，那是不可能的");
  for (const name of FIVE) {
    const full = systemTool(name);
    assert.notEqual(full, name, `${name} 还是裸名，没走 System32`);
    assert.ok(full.startsWith(folder!), `${name} 不在 System32 底下：${full}`);
    assert.ok(full.endsWith(".exe"), `${name} 的路径不是一个程序：${full}`);
  }
  // PowerShell 不是散在 System32 里的那种，它在自己的文件夹底下。
  assert.ok(systemTool("powershell").includes(join("WindowsPowerShell", "v1.0")), systemTool("powershell"));
});

elsewhere("不是 Windows 的时候，裸名就是答案", () => {
  for (const name of FIVE) assert.equal(systemTool(name), name);
});

test("SystemRoot 和 windir 都没说的时候退回裸名，而不是猜一个 Windows 文件夹", () => {
  // 这两个变量在这个进程里改、当场改回来：system32() 每次问那一刻才读它们。摆到子进程里问是问
  // 不到的：Windows 上 CreateProcess 本身要 SystemRoot，运行时会自己把它装回子进程的环境里。
  const was = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
  try {
    delete process.env.SystemRoot;
    delete process.env.windir;
    assert.equal(system32(), null);
    assert.equal(systemTool("schtasks"), "schtasks");
    assert.equal(systemTool("icacls"), "icacls");
    // 设成空字符串或者几个空格也算没说：一个 env 文件里 `SystemRoot=` 后面什么都没写就是这样。
    process.env.SystemRoot = "   ";
    process.env.windir = "";
    assert.equal(system32(), null);
    // 只剩 windir 的那台机器也找得到。
    process.env.windir = was.windir ?? "";
    if (was.windir) assert.equal(system32(), join(was.windir, "System32"));
  } finally {
    if (was.SystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = was.SystemRoot;
    if (was.windir === undefined) delete process.env.windir;
    else process.env.windir = was.windir;
  }
});

onWindows("把 PATH 裁掉之后 bornAt 仍然有值：这正是第 4 轮那个问题", () => {
  // PATH 整个空掉——不是少了 System32，是一个都不剩。SystemRoot 还在，因为 Windows 自己总会设它，而这条
  // 测试要问的就是「只剩 SystemRoot 的时候还找不找得到 powershell」。
  const said = inChild(
    'import { bornAt } from "./worker/process.ts";console.log(JSON.stringify(bornAt(process.pid)));',
    {
      PATH: "",
      SystemRoot: process.env.SystemRoot ?? "",
      windir: process.env.windir ?? "",
      TEMP: process.env.TEMP ?? "",
      // 说一句话就会加载 host/i18n.ts，而它要知道这个 HOME；这里给它一个不存在的，免得读到真的那一份。
      AGENT_AUTOLOOP_HOME: join(root, "tests", "no-such-home"),
    },
  );
  const born = JSON.parse(said) as string | null;
  assert.notEqual(born, null, "PATH 裁掉之后 bornAt 又回 null 了，锁会永久「看不清」");
  assert.match(String(born), /^\d+$/, String(born));
});

onWindows("裁掉 PATH 之后 tasklist 也还答得出这个进程是活的", () => {
  const said = inChild(
    'import { running } from "./worker/process.ts";console.log(JSON.stringify(running(process.pid)));',
    {
      PATH: "",
      SystemRoot: process.env.SystemRoot ?? "",
      windir: process.env.windir ?? "",
      TEMP: process.env.TEMP ?? "",
      AGENT_AUTOLOOP_HOME: join(root, "tests", "no-such-home"),
    },
  );
  assert.equal(JSON.parse(said), true, "PATH 裁掉之后 running() 回的不是 true，锁和 doctor 都会看错");
});

test("那五个名字都没有被哪个调用方漏下来：代码里不许再有裸名的那五个", async () => {
  const { readFileSync } = await import("node:fs");
  const bare = [];
  for (const file of ["worker/process.ts", "host/service-win.ts", "host/permissions.ts"]) {
    const text = readFileSync(join(root, file), "utf8");
    for (const name of FIVE) {
      // 裸名当第一个参数传给 execFileSync / spawnSync 的那种写法，一个都不许剩。
      if (new RegExp(`(execFileSync|spawnSync)\\(\\s*"${name}"`).test(text)) bare.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(bare, [], `这几处还在按 PATH 找程序：\n${bare.join("\n")}`);
});
