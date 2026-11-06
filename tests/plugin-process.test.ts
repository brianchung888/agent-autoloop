// A plugin that is a program of its own: `runtime: "process"`, one line of JSON in, one line of JSON out. Real
// processes, really started — a stand-in for the program would be standing in for the whole of what this is.
//
// Failure cases: a plugin that does not say it has `link` or `check` is given one anyway, so the hub reads a session
// link that goes nowhere and a check that answers for nothing; what the plugin says went wrong is swallowed and the
// turn fails for no stated reason; a plugin's `plugin.json` overrides the `.ts` file beside it, changing which plugin
// an install already working has; a channel is let through, where nothing can carry its loop.
import assert from "node:assert/strict";
import { copyFileSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("plugin-process");
const { loadPlugin } = await import("../host/plugins.ts");

const WINDOWS = process.platform === "win32";

/**
 * A plugin whose program is this runtime running `handler.mjs`. What may be started at all differs by platform: on
 * Windows only a real executable may, and the manifest's `entry` has to be inside the plugin's own folder — so this
 * runtime is linked into it (copied where a link cannot cross the volume). Elsewhere a `#!/bin/sh` wrapper does it.
 */
function plugin(name: string, body: string) {
  const folder = join(home, "plugins", name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "handler.mjs"), body);
  let manifest: { runtime: string; entry: string; args: string[] };
  if (WINDOWS) {
    const runtime = join(folder, "runtime.exe");
    try {
      linkSync(process.execPath, runtime);
    } catch {
      copyFileSync(process.execPath, runtime);
    }
    // 相对路径：插件程序的 cwd 就是它自己的目录，否则插件没办法指到自己的文件。
    manifest = {
      runtime: "process",
      entry: "runtime.exe",
      args: ["--disable-warning=ExperimentalWarning", "handler.mjs"],
    };
  } else {
    // 这一行真的是 shell，所以两个路径都加引号。写出来的是 handler.mjs 的路径，不是这个文件里那个同名的函数。
    const wrapper = join(folder, "run");
    const script = `#!/bin/sh\nexec "${process.execPath}" "${join(folder, "handler.mjs")}" "$@"\n`;
    writeFileSync(wrapper, script, { mode: 0o755 });
    manifest = { runtime: "process", entry: "run", args: [] };
  }
  writeFileSync(join(folder, "plugin.json"), JSON.stringify(manifest));
  return folder;
}

/** A handler that answers the calls it is given here, and says it has exactly those. */
const handler = (answers: Record<string, string>) => `
import { readFileSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
const answers = {
${Object.entries(answers)
  .map(([call, body]) => `  ${call}: (request) => ${body},`)
  .join("\n")}
};
if (request.call === "describe") console.log(JSON.stringify({ ok: true, value: { calls: Object.keys(answers) } }));
else if (answers[request.call]) console.log(JSON.stringify({ ok: true, value: answers[request.call](request) }));
else console.log(JSON.stringify({ ok: false, error: "不认识 " + request.call }));
`;

test("agent 的四个函数，一问一答地走完一圈", async () => {
  plugin(
    "outside-agent",
    handler({
      command: '["printf", "%s", request.turn.prompt]',
      read: '({ text: request.stdout.trim(), finished: request.code === 0, session: "s-1" })',
      link: '"https://example.test/" + request.session',
      check: "null",
    }),
  );
  const adapter = await loadPlugin("outside-agent", "agent");
  assert.deepEqual(adapter.command({ prompt: "做这件事", session: "s", resume: null }), ["printf", "%s", "做这件事"]);
  assert.deepEqual(adapter.read("  说完了  \n", 0, ""), { text: "说完了", finished: true, session: "s-1" });
  assert.deepEqual(adapter.read("还在跑", null, ""), { text: "还在跑", finished: false, session: "s-1" });
  assert.equal(adapter.link("s-1"), "https://example.test/s-1");
  assert.equal(adapter.check(), null);
});

test("没声明 link 和 check 的插件就没有这两个：中台读的是「有没有」", async () => {
  plugin("plain-agent", handler({ command: '["printf", "hi"]', read: "({ text: request.stdout })" }));
  const adapter = await loadPlugin("plain-agent", "agent");
  assert.equal(typeof adapter.command, "function");
  assert.equal(typeof adapter.read, "function");
  assert.equal(adapter.link, undefined, "凭空给一个 link，中台就会报一个打不开的会话链接");
  assert.equal(adapter.check, undefined);
});

test("source 是一次纯翻译，返回事件数组", async () => {
  plugin(
    "outside-source",
    handler({
      translate:
        'request.secret && request.headers["x-sig"] === request.secret' +
        ' ? [{ id: "order-" + JSON.parse(request.body).no, type: "shop.order" }]' +
        ' : (() => { throw new Error("验签没过"); })()',
    }),
  );
  const translate = await loadPlugin("outside-source", "source");
  // 这一个 call 不阻塞：webhook 那头（host/server.ts 的 adaptWebhook）本来就是 async，等的时候中台照旧转。
  assert.deepEqual(await translate({ headers: { "x-sig": "k" }, body: '{"no":7}', secret: "k" }), [
    { id: "order-7", type: "shop.order" },
  ]);
  // 插件自己挂了、一句话没留下，那还是一个要抛出去的毛病：host/server.ts 把它变成「验签没过」。
  await assert.rejects(() => translate({ headers: {}, body: "{}", secret: "k" }), /插件对 translate 什么都没答/);
  // 进来的东西选不了这是哪一个 call：webhook 的字段是摊进这个请求里的，`call` 要压在最后。
  assert.deepEqual(
    await translate({ headers: { "x-sig": "k" }, body: '{"no":7}', secret: "k", call: "describe" }),
    [{ id: "order-7", type: "shop.order" }],
    "请求自带的 call 盖掉了 translate",
  );
});

test("事件插件那一个调用不占着中台：等它的时候事件循环照旧转", async () => {
  // 睡 400 毫秒才答。如果这一个调用是 spawnSync，这 400 毫秒里整个进程一动不动，下面那个计时器一次都不会响。
  plugin(
    "slow-source",
    `
import { readFileSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
if (request.call === "describe") console.log(JSON.stringify({ ok: true, value: { calls: ["translate"] } }));
else {
  await new Promise((done) => setTimeout(done, 400));
  console.log(JSON.stringify({ ok: true, value: [{ id: "slow", type: "t" }] }));
}
`,
  );
  const translate = await loadPlugin("slow-source", "source");
  let ticks = 0;
  const beat = setInterval(() => ticks++, 20);
  try {
    assert.deepEqual(await translate({ headers: {}, body: "{}", secret: "" }), [{ id: "slow", type: "t" }]);
  } finally {
    clearInterval(beat);
  }
  assert.ok(ticks > 3, `等插件的时候事件循环停了（只跳了 ${ticks} 次）：这一个调用又变成同步的了`);
});

test("事件插件第一次被取的时候也不占着中台：describe 等的时候事件循环照旧转", async () => {
  // 第一次取这个插件就是这个插件的程序第一次跑，而第一次是最慢的那一次（它可能要起自己的运行时）。那一句
  // describe 要是同步问的，中台整个——连 /healthz 一起——在它答话之前一动不动，最坏一直到 30 秒的调用上限。
  plugin(
    "slow-describe",
    `
import { readFileSync } from "node:fs";
const request = JSON.parse(readFileSync(0, "utf8"));
if (request.call === "describe") {
  await new Promise((done) => setTimeout(done, 400));
  console.log(JSON.stringify({ ok: true, value: { calls: ["translate"] } }));
} else console.log(JSON.stringify({ ok: true, value: [{ id: "e", type: "t" }] }));
`,
  );
  let ticks = 0;
  const beat = setInterval(() => ticks++, 20);
  let translate: (input: unknown) => Promise<unknown>;
  try {
    translate = await loadPlugin("slow-describe", "source");
  } finally {
    clearInterval(beat);
  }
  assert.ok(ticks > 3, `问 describe 的时候事件循环停了（只跳了 ${ticks} 次）：这一句又变成同步的了`);
  assert.deepEqual(await translate({ headers: {}, body: "{}", secret: "" }), [{ id: "e", type: "t" }]);
});

test("两个 webhook 同时撞上第一次加载：describe 还是只问一次", async () => {
  // 记着的是「正在做成」而不是「做成的东西」。否则第一个还在等 describe 的时候第二个进来，缓存里什么都没有，
  // 于是又起一个进程去问同一句话——一个请求两个进程，而且两次答复谁赢说不准。
  const folder = plugin(
    "raced-source",
    `
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync("ran.log", "x\\n");
const request = JSON.parse(readFileSync(0, "utf8"));
if (request.call === "describe") {
  await new Promise((done) => setTimeout(done, 200));
  console.log(JSON.stringify({ ok: true, value: { calls: ["translate"] } }));
} else console.log(JSON.stringify({ ok: true, value: [{ id: "e", type: "t" }] }));
`,
  );
  const [first, second] = await Promise.all([
    loadPlugin("raced-source", "source"),
    loadPlugin("raced-source", "source"),
  ]);
  assert.equal(first, second, "两边拿到的不是同一个插件");
  const runs = readFileSync(join(folder, "ran.log"), "utf8").trimEnd().split("\n").length;
  assert.equal(runs, 1, `describe 跑了 ${runs} 次：同时来的两个 webhook 各起了一个进程`);
});

test("答不出一行 JSON、或者什么都不答，都说得明明白白", async () => {
  plugin("mute", "");
  await assert.rejects(() => loadPlugin("mute", "agent"), /什么都没答/);
  plugin("babbling", 'console.log("我不会说 JSON");');
  await assert.rejects(() => loadPlugin("babbling", "agent"), /答的不是一行 JSON/);
  plugin("grumbling", `console.log(JSON.stringify({ ok: false, error: "先运行 gh auth login" }));`);
  await assert.rejects(() => loadPlugin("grumbling", "agent"), /插件说：先运行 gh auth login/);
});

test(
  "Windows 上 entry 得是真正的可执行文件：.cmd 和 sh 脚本都起不来，而且说得出是哪个程序",
  { skip: !WINDOWS && "docs/plugins.md 的这一段讲的是 Windows；POSIX 上 sh 脚本正是上面几条走的那条路" },
  async () => {
    // 这里不经过 shell，所以 CreateProcess 认什么就是什么。docs/plugins.md 说的就是这件事。
    const folder = join(home, "plugins", "wrapped");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "run.cmd"), '@echo {"ok":true,"value":{"calls":[]}}\r\n');
    writeFileSync(join(folder, "plugin.json"), JSON.stringify({ runtime: "process", entry: "run.cmd" }));
    await assert.rejects(() => loadPlugin("wrapped", "agent"), /插件的程序起不来（.*run\.cmd）/);

    const shell = join(home, "plugins", "shelled");
    mkdirSync(shell, { recursive: true });
    writeFileSync(join(shell, "run"), '#!/bin/sh\necho \'{"ok":true,"value":{"calls":[]}}\'\n');
    writeFileSync(join(shell, "plugin.json"), JSON.stringify({ runtime: "process", entry: "run" }));
    await assert.rejects(() => loadPlugin("shelled", "agent"), /插件的程序起不来（.*run）/);
  },
);

test("通道还不能这样跑，而且说清楚该怎么办", async () => {
  plugin("outside-channel", handler({ command: "[]" }));
  await assert.rejects(() => loadPlugin("outside-channel", "channel"), /通道是和中台一样长命的循环/);
});

test("describe 只问一次：中台每个请求、worker 每一拍都要取这个插件", async () => {
  // 每被起一次就往这个文件里加一行，于是数行数就是数进程。
  const folder = plugin(
    "counted-source",
    `
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync("ran.log", "x\\n");
const request = JSON.parse(readFileSync(0, "utf8"));
if (request.call === "describe") console.log(JSON.stringify({ ok: true, value: { calls: ["translate"] } }));
else console.log(JSON.stringify({ ok: true, value: [{ id: "e", type: "t" }] }));
`,
  );
  const runs = () => readFileSync(join(folder, "ran.log"), "utf8").trimEnd().split("\n").length;
  const first = await loadPlugin("counted-source", "source");
  assert.equal(runs(), 1, "describe");
  // 再取两次：源码插件这时拿到的是已经 import 过的那个模块，process 插件也要是同一个。
  assert.equal(await loadPlugin("counted-source", "source"), first);
  assert.equal(await loadPlugin("counted-source", "source"), first);
  assert.equal(runs(), 1, "describe 又跑了一次：每个 webhook 就多起一个进程");
  // 而真的调用照旧一次一个进程：那是协议说的，不是可以省掉的。
  assert.deepEqual(await first({ headers: {}, body: "{}", secret: "" }), [{ id: "e", type: "t" }]);
  assert.equal(runs(), 2);

  // 代价就在这里，docs/plugins.md 写明的那一条：插件改了要重启中台才算数。换掉 entry 指的那个程序，
  // 跑着的这个中台拿到的还是记下来的那一个——连它声明过有哪几个 call 都还是旧的。
  plugin("counted-source", `console.log(JSON.stringify({ ok: true, value: [{ id: "新的", type: "t" }] }));`);
  assert.equal(await loadPlugin("counted-source", "source"), first, "改了插件，中台里还是记下来的那一个");
  assert.deepEqual(await first({ headers: {}, body: "{}", secret: "" }), [{ id: "新的", type: "t" }]);
  assert.equal(runs(), 2, "describe 没有再问一次：换了程序也不会重新问它有哪几个 call");
});

test("没做成的插件不进缓存：修好了不必重启中台", async () => {
  plugin("fixable", 'console.log(JSON.stringify({ ok: false, error: "先运行 gh auth login" }));');
  await assert.rejects(() => loadPlugin("fixable", "agent"), /先运行 gh auth login/);
  plugin("fixable", handler({ command: '["printf", "hi"]', read: "({ text: request.stdout })" }));
  assert.equal(typeof (await loadPlugin("fixable", "agent")).command, "function");
});

test("同一个目录里既有 .ts 又有 plugin.json，那个 .ts 还是赢：装好的插件不会被改掉", async () => {
  const folder = plugin("both", handler({ command: '["printf", "process"]', read: "({})" }));
  writeFileSync(join(folder, "agent.ts"), 'export default { command: () => ["printf", "source"], read: () => ({}) };');
  const adapter = await loadPlugin("both", "agent");
  assert.deepEqual(adapter.command({}), ["printf", "source"]);
});
