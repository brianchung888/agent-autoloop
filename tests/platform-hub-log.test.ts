// What the hub says about itself, under the thing that really keeps it up on Windows. A scheduled task carries no
// console: its stdout and its stderr go nowhere at all, and nothing anywhere keeps them. So every sentence the hub
// means a person to read has to reach the file this program writes itself (host/up.ts: up.log).
//
// Failure case, measured: a webhook named a source whose adapter could not be loaded. Whoever sent it got a 404 with
// the plugin's name, the errno and «中台日志里写了是什么» — and the sentence that says which entry is missing, and
// which folder a plugin.json would go in, was written with `console.error` to a stderr that had nowhere to go. It was
// in no log on the machine, so the one thing the 404 told them to read did not exist
// (phase3-verification-round3.md F).
//
// Nothing here is faked: a real task is registered with schtasks, really started by Task Scheduler, really asked over
// HTTP, and the file it wrote is really read. It is taken away again whatever happens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skipUnless } from "./helpers.ts";

const test = skipUnless(
  process.platform === "win32",
  "计划任务是 Windows 独有的那条常驻；launchd 和 systemd 把 stderr 接到文件或 journal，这个毛病在那里不成立",
);

const repo = join(import.meta.dirname, "..");
const program = join(repo, "bin", "agent-autoloop.ts");
const LABEL = "agent-autoloop-test-hub-log";

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("计划任务起的中台，把 webhook 装不起插件的那一整句写进 up.log", async (t) => {
  const { installTask, removeTask } = await import("../host/service-win.ts");
  const home = mkdtempSync(join(tmpdir(), "agent-autoloop-hub-log-"));
  // Whatever happens below, nothing of this test stays registered on this machine and no hub of its own stays up.
  t.after(async () => {
    writeFileSync(join(home, "stop"), `${new Date().toISOString()}\n`);
    await wait(2000);
    removeTask(LABEL, home, program);
    spawnSync("schtasks", ["/End", "/TN", LABEL], { stdio: "ignore", timeout: 60_000 });
    spawnSync("schtasks", ["/Delete", "/TN", LABEL, "/F"], { stdio: "ignore", timeout: 60_000 });
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  });

  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_AUTOLOOP_HOME: home };
  // The task hands the program a home and nothing else, so the install has to be the one a bare home describes.
  delete env.AGENT_AUTOLOOP_RULES;
  delete env.AGENT_AUTOLOOP_PUBLIC_URL;
  const port = await freePort();
  const init = spawnSync(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      program,
      "init",
      "--no-service",
      "--command",
      "cmd /c echo {prompt}",
      "--port",
      String(port),
    ],
    { env, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(init.status, 0, init.stderr + init.stdout);

  // A source that takes webhooks through an adapter that is not on this machine: the one case whose whole answer is a
  // sentence in the hub's own log.
  const rulesFile = join(home, "rules.json");
  const rules = JSON.parse(readFileSync(rulesFile, "utf8"));
  rules.sources = { ...rules.sources, hooked: { name: "外部", adapter: "no-such-plugin-here" } };
  writeFileSync(rulesFile, `${JSON.stringify(rules, null, 2)}\n`);

  installTask({ label: LABEL, home, executable: process.execPath, program });
  const url = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    up = await fetch(`${url}/healthz`).then(
      (answer) => answer.ok,
      () => false,
    );
    if (!up) await wait(200);
  }
  assert.ok(up, `计划任务没把中台起起来；任务 XML：\n${readFileSync(join(home, "service.xml"), "utf16le")}`);

  const answer = await fetch(`${url}/v1/in/hooked`, { method: "POST", body: "{}" });
  assert.equal(answer.status, 404);
  const said = (await answer.json()) as { error?: string };
  // What goes over the wire stays what it was: the plugin's name, an errno, and where the rest of it is written down.
  assert.match(String(said.error), /no-such-plugin-here.*装不起来.*中台日志/s);

  // And that is where the rest of it really is. The hub writes the line as it answers, so it is looked for rather
  // than assumed to be there the moment the answer arrives.
  const logFile = join(home, "logs", "up.log");
  let wrote = "";
  for (let i = 0; i < 100; i++) {
    wrote = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    if (/no-such-plugin-here/.test(wrote)) break;
    await wait(100);
  }
  assert.match(
    wrote,
    /webhook hooked：没有 no-such-plugin-here 的插件（plugins\/no-such-plugin-here\/source\.ts）/,
    `404 叫人去读中台日志，而日志里没有这一句：\n${wrote}`,
  );
});
