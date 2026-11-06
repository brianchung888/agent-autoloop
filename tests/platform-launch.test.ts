// Starting an agent where there is no shell to start it: worker/launcher.ts, and the lookup that decides what it is
// handed (worker/agents.ts findProgram). Both run for real here — a real wrapper process, a real program, the real
// where.exe — because what is being tested is what the operating system does with a name.
//
// Failure cases: the exit code never appears, so the worker waits out the whole timeout for a run that already ended;
// half a number is read out of the exit file; a program that cannot be started is not reported as one, which on Windows
// is what a .cmd shim is; the lookup hands back such a shim, so every turn either dies on spawn or ends in 127 while a
// real executable sat in the places `elsewhere` names.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { findProgram } from "../worker/agents.ts";

const WINDOWS = process.platform === "win32";
const LAUNCHER = join(import.meta.dirname, "..", "worker", "launcher.ts");
const ONLY_WINDOWS = {
  skip: !WINDOWS && "这几条讲的是 Windows 上没有 shell 时的启动与 where.exe 查找，别的平台没有这回事",
};

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-launch-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

let counter = 0;
/** One launch of the wrapper, waited for: its own exit code, and the three files a turn leaves behind. */
function launched(argv: string[]) {
  const where = join(dir, `turn-${counter++}`);
  mkdirSync(where, { recursive: true });
  const files = { out: join(where, "out"), err: join(where, "err"), exit: join(where, "exit") };
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", LAUNCHER, files.out, files.err, files.exit, "--", ...argv],
    { stdio: "ignore" },
  );
  return new Promise<{ wrapper: number | null; exit: string | null; out: string; err: string }>((resolve) => {
    child.once("exit", (wrapper) =>
      resolve({
        wrapper,
        exit: existsSync(files.exit) ? readFileSync(files.exit, "utf8") : null,
        out: existsSync(files.out) ? readFileSync(files.out, "utf8") : "",
        err: existsSync(files.err) ? readFileSync(files.err, "utf8") : "",
      }),
    );
  });
}

test("what the agent printed lands in the files, and its exit code appears whole", async () => {
  const done = await launched([process.execPath, "-e", 'process.stdout.write("说完了");process.exit(0)']);
  assert.equal(done.wrapper, 0);
  assert.equal(done.exit, "0\n", "一个完整的数字，后面带换行");
  assert.equal(done.out, "说完了");
  assert.equal(done.err, "");
});

test("a non-zero exit code is the agent's own, not the wrapper's", async () => {
  const done = await launched([process.execPath, "-e", 'process.stderr.write("不行");process.exit(3)']);
  assert.equal(done.wrapper, 0, "包装自己没出错");
  assert.equal(done.exit, "3\n");
  assert.equal(done.err, "不行");
});

test("a program that isn't there is 127, the way a shell says it", async () => {
  const done = await launched([join(dir, "没有这个程序")]);
  assert.equal(done.exit, "127\n");
  assert.match(done.err, /启动不了/);
});

test("包装是这个程序的一个子命令，走那条路得到的是同一件事", async () => {
  // worker 现在起的不是 worker/launcher.ts 这个文件，而是 `<本程序> internal:launch`（host/self.ts 的
  // selfExecutable 决定前面那几个词）。打包版里没有 .ts 文件可以指，而以前指的就是一个文件——那一轮因此根本
  // 跑不起来。这条走真正的那条路，拿到的三个文件和退出码要和上面逐字相同。
  const where = join(dir, `subcommand-${counter++}`);
  mkdirSync(where, { recursive: true });
  const files = { out: join(where, "out"), err: join(where, "err"), exit: join(where, "exit") };
  const child = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      join(import.meta.dirname, "..", "bin", "agent-autoloop.ts"),
      "internal:launch",
      files.out,
      files.err,
      files.exit,
      "--",
      process.execPath,
      "-e",
      'process.stdout.write("走子命令这条路");process.exit(0)',
    ],
    { stdio: "ignore" },
  );
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  assert.equal(code, 0);
  assert.equal(readFileSync(files.exit, "utf8"), "0\n", "退出码还是整个出现");
  assert.equal(readFileSync(files.out, "utf8"), "走子命令这条路");
  assert.equal(readFileSync(files.err, "utf8"), "");
});

test("internal:launch 不出现在帮助里：它不是给人打的", () => {
  const help = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", join(import.meta.dirname, "..", "bin", "agent-autoloop.ts"), "help"],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /internal:/, "内部子命令进了帮助");
});

test("the wrapper refuses a command line it can't make sense of", async () => {
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", LAUNCHER, "只有一个参数"], {
    stdio: "ignore",
  });
  const [code] = await new Promise<[number | null]>((resolve) => child.once("exit", (status) => resolve([status])));
  assert.equal(code, 2);
});

test("a .cmd shim is 127, not a wrapper that dies without saying anything", ONLY_WINDOWS, async () => {
  // npm writes exactly this for a package's command, and Windows refuses to start it as a program — by throwing from
  // spawn itself, with no `error` event to follow. Unanswered, the wrapper dies here: no exit file ever appears and the
  // run sits until its timeout.
  const shim = join(dir, "shim.cmd");
  writeFileSync(shim, "@echo off\r\necho 我是个批处理\r\n");
  const done = await launched([shim]);
  assert.equal(done.exit, "127\n", "退出码还是出现了");
  assert.match(done.err, /启动不了/);
});

test("只有 .cmd 在 PATH 上时，查找当作没找到，去看 elsewhere 给的位置", ONLY_WINDOWS, () => {
  const onlyShim = join(dir, "bin");
  mkdirSync(onlyShim, { recursive: true });
  writeFileSync(join(onlyShim, "agent-autoloop-fake.cmd"), "@echo off\r\n");
  const realPath = process.env.PATH;
  try {
    process.env.PATH = `${onlyShim};${realPath}`;
    // The shim is the nearest thing on PATH and the only one. A real executable elsewhere is what must come back.
    assert.equal(
      findProgram("agent-autoloop-fake", () => [process.execPath]),
      process.execPath,
    );
    // And with nowhere else to look, not finding it is the answer — never the shim.
    assert.throws(() => findProgram("agent-autoloop-fake-2"), /找不到/);
  } finally {
    process.env.PATH = realPath;
  }
});
