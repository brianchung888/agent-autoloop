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
  assert.deepEqual(translate({ headers: { "x-sig": "k" }, body: '{"no":7}', secret: "k" }), [
    { id: "order-7", type: "shop.order" },
  ]);
  // 插件自己挂了、一句话没留下，那还是一个要抛出去的毛病：host/server.ts 把它变成「验签没过」。
  assert.throws(() => translate({ headers: {}, body: "{}", secret: "k" }), /插件对 translate 什么都没答/);
  // 进来的东西选不了这是哪一个 call：webhook 的字段是摊进这个请求里的，`call` 要压在最后。
  assert.deepEqual(
    translate({ headers: { "x-sig": "k" }, body: '{"no":7}', secret: "k", call: "describe" }),
    [{ id: "order-7", type: "shop.order" }],
    "请求自带的 call 盖掉了 translate",
  );
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
  assert.deepEqual(first({ headers: {}, body: "{}", secret: "" }), [{ id: "e", type: "t" }]);
  assert.equal(runs(), 2);
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
