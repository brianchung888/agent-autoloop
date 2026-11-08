// How the Skill gets into an Agent's folder, and how `uninstall` takes it back out, on this machine. A plain link to a
// folder is not everyone's to make on Windows, so the install makes a junction, and where even that is refused it
// copies the folder and writes down which of the two it did. All three paths are run here for real: a link that the
// file system really made, a copy that really has the files in it, and an `uninstall` that really has to tell its own
// from somebody else's.
//
// Failure cases: the junction is never made and nobody notices, so an Agent is never told what this program can do; a
// refusal fails the whole install; a copy is left behind for ever because `uninstall` looks for a link; a folder
// somebody has made their own is deleted because it sits where ours would.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const WINDOWS = process.platform === "win32";
const ONLY_WINDOWS = {
  skip: !WINDOWS && "只有 Windows 会退回复制：别的平台做不出链接就是做不出，照原样抛出去",
};

const root = join(import.meta.dirname, "..");
const bin = join(root, "bin", "agent-autoloop.ts");
const skill = join(root, "skills", "agent-autoloop");

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-skill-link-"));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));

/** A port nothing is on, so `init` writes a hub address that is this install's own. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

/**
 * The program, run as a person would run it: with a home of its own and no AGENT_AUTOLOOP_HOME, which is the one case
 * linkSkill does anything in — it never puts a link in somebody's Agent folder for an install they pointed elsewhere.
 */
function run(person: string, args: string[], extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: person, HOME: person, ...extra };
  for (const name of ["AGENT_AUTOLOOP_HOME", "AGENT_AUTOLOOP_RULES", "AGENT_AUTOLOOP_PUBLIC_URL"]) delete env[name];
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", bin, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env,
  });
}

let people = 0;
/** Somebody's home folder, with the Agent folders they are said to have and nothing else. */
function person(agents: string[]) {
  const where = join(dir, `person-${people++}`);
  for (const agent of agents) mkdirSync(join(where, agent), { recursive: true });
  return where;
}

const ways = (person: string) =>
  JSON.parse(readFileSync(join(person, ".agent-autoloop", "skill-link.json"), "utf8")) as Record<string, string>;
const skillIn = (person: string, agent: string) => join(person, agent, "skills", "agent-autoloop");

test("正體装的时候，Agent 接到的是写出来的那一份正體手册", async () => {
  // 树里的 `SKILL.md` 是简体的，所以正體装好之后 Agent 读的不能是它：host/skill.ts 把正體那一份写到这个安装
  // 自己的 HOME 下，链接也就指到那里。失败的情形是最容易漏的那一种——默认语言装好，手册整本是另一种中文。
  const me = person([".claude"]);
  const started = run(
    me,
    ["init", "--no-service", "--command", "node nothing {prompt}", "--port", String(await freePort())],
    { AGENT_AUTOLOOP_LANG: "zh-TW" },
  );
  assert.equal(started.status, 0, started.stderr);

  const link = skillIn(me, ".claude");
  const written = join(me, ".agent-autoloop", "skills", "agent-autoloop");
  assert.equal(realpathSync(link), realpathSync(written), "链接没指到写出来的那一份");
  assert.equal(
    readFileSync(join(link, "SKILL.md"), "utf8"),
    readFileSync(join(root, "skills", "agent-autoloop", "SKILL.zh-TW.md"), "utf8"),
    "Agent 读到的不是正體那一份",
  );

  // 卸载按同一个答案拿掉链接。写出来的那一份留在数据目录里：源码安装的卸载不碰 HOME（cli/uninstall.ts），
  // 而这个目录整个是保留的那一类东西。
  const gone = run(me, ["uninstall", "--yes"], { AGENT_AUTOLOOP_LANG: "zh-TW" });
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined, "链接拿掉了");
});

test("装好之后 Agent 的文件夹里是一个链接，卸载时按记录拿掉", async () => {
  const me = person([".claude"]);
  const started = run(me, ["init", "--no-service", "--command", "node nothing {prompt}", "--port", String(await freePort())]); // prettier-ignore
  assert.equal(started.status, 0, started.stderr);

  const link = skillIn(me, ".claude");
  // A junction is what Windows reports as a link here, and it leads to the same folder a link would.
  assert.equal(lstatSync(link).isSymbolicLink(), true, "放进去的是链接，不是复制");
  assert.equal(realpathSync(link), realpathSync(skill), "而且指向这份安装的 skill");
  assert.ok(existsSync(join(link, "SKILL.md")));
  assert.deepEqual(ways(me), { ".claude": "link" }, "写下了用的是哪种方式");

  const gone = run(me, ["uninstall", "--yes"]);
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(lstatSync(link, { throwIfNoEntry: false }), undefined, "链接拿掉了");
  assert.equal(existsSync(join(me, ".agent-autoloop", "skill-link.json")), false);
  assert.ok(existsSync(join(skill, "SKILL.md")), "链接指向的 skill 本身没动");
});

/**
 * 卸载认不认自己放的那份复制，靠的是逐字节比对 `SKILL.md`（cli/uninstall.ts: removeCopiedSkill）。手册有两份，
 * 一份正體一份简体，所以「当时放出去的那一份」是跟着语言的——比错了一份，卸载就把它当成人家自己改过的，于是那个
 * 目录永远留在那里。两种语言各走一遍。
 */
for (const which of ["zh-CN", "zh-TW"] as const) {
  test(`做不出链接就复制，而且 init 不会因此失败（${which}）`, ONLY_WINDOWS, async () => {
    // Nothing on a test machine refuses a junction, so the refusal is put there: the same error a locked-down or
    // non-NTFS place gives, raised from the one call that would have made the link.
    const refuse = join(dir, `refuse-links-${which}.cjs`);
    writeFileSync(
      refuse,
      'require("node:fs").symlinkSync = () => {\n  throw new Error("这台机器不让做链接（测试装的）");\n};\n',
    );
    const me = person([".claude", ".codex"]);
    const started = run(
      me,
      ["init", "--no-service", "--command", "node nothing {prompt}", "--port", String(await freePort())],
      { NODE_OPTIONS: `--require ${refuse}`, AGENT_AUTOLOOP_LANG: which },
    );
    assert.equal(started.status, 0, started.stderr);

    // 这一次该放出去的是哪一份：简体的源码安装就是树里那一个目录，正體的是写到 HOME 下的那一份。
    const placed =
      which === "zh-CN" ? join(skill, "SKILL.md") : join(me, ".agent-autoloop", "skills", "agent-autoloop", "SKILL.md");
    const manual = join(root, "skills", "agent-autoloop", which === "zh-CN" ? "SKILL.md" : "SKILL.zh-TW.md");
    assert.equal(readFileSync(placed, "utf8"), readFileSync(manual, "utf8"), "放出去的不是这个语言那一份");

    for (const agent of [".claude", ".codex"]) {
      const copied = skillIn(me, agent);
      assert.equal(lstatSync(copied).isSymbolicLink(), false, "这回是复制");
      assert.equal(lstatSync(copied).isDirectory(), true);
      assert.equal(readFileSync(join(copied, "SKILL.md"), "utf8"), readFileSync(placed, "utf8"));
    }
    assert.deepEqual(ways(me), { ".claude": "copy", ".codex": "copy" }, "复制也要写下来，否则卸载不掉");

    // Somebody who has made the copy their own keeps it: a copy leads nowhere, so the only thing that can say whose it
    // is, is what is in it.
    writeFileSync(join(skillIn(me, ".codex"), "SKILL.md"), "这份我自己改过了\n");
    const gone = run(me, ["uninstall", "--yes"], { AGENT_AUTOLOOP_LANG: which });
    assert.equal(gone.status, 0, gone.stderr);
    assert.equal(existsSync(skillIn(me, ".claude")), false, "我们放的复制拿掉了");
    assert.equal(readFileSync(join(skillIn(me, ".codex"), "SKILL.md"), "utf8"), "这份我自己改过了\n", "人家改过的留下");
    assert.equal(existsSync(join(me, ".agent-autoloop", "skill-link.json")), false);
  });
}
