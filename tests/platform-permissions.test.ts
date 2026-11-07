// Keeping this install's files to the person whose they are, asked of the file system itself. The access list is read
// back with icacls on Windows and with the mode on POSIX: a stand-in would be answering the one question worth asking.
//
// Failure cases: a folder is left with what it inherited, so anybody with an account on the machine can read the master
// key; a refusal throws into `init` instead of being reported; a refusal is forgotten, so `doctor` says all is well; the
// POSIX mode changes, which is the whole of this on three platforms out of four.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const WINDOWS = process.platform === "win32";
const onlyWindows = { skip: WINDOWS ? false : "只有 Windows 用 icacls；POSIX 这边看的是 mode，由下面那条检查" };
const onlyPosix = { skip: WINDOWS ? "POSIX 的 mode 在 Windows 上没有意义：chmod 只动一个只读位" : false };

const home = setup("platform-permissions");
const { permissionTrouble, secureDir, secureFile } = await import("../host/permissions.ts");

/** Who the file system says may do what, as icacls prints it: one line per entry. */
const accessList = (target: string) =>
  execFileSync("icacls", [target], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    .split(/\r?\n/)
    .map((line) => line.replace(target, "").trim())
    .filter((line) => line.includes(":"));

test("a secured folder is made, and the mode is still the mode", onlyPosix, () => {
  const dir = join(home, "posix-folder");
  secureDir(dir);
  assert.ok(existsSync(dir));
  assert.equal(statSync(dir).mode & 0o777, 0o700, "nobody else may look inside");
  // Nothing is run on POSIX, so there is nothing that can have been refused.
  assert.equal(permissionTrouble(), null);
});

test("a secured folder grants this user and nobody else, and what is written inside inherits it", onlyWindows, () => {
  const dir = join(home, "windows-folder");
  secureDir(dir);
  const granted = accessList(dir);
  assert.equal(granted.length, 1, `only one entry, got: ${granted.join(" | ")}`);
  assert.ok(granted[0]!.includes(process.env.USERNAME!), granted[0]);
  assert.ok(granted[0]!.includes("(OI)(CI)"), `what is written inside inherits it: ${granted[0]}`);

  const inside = join(dir, "master.key");
  writeFileSync(inside, "a key\n", { mode: 0o600 });
  const onFile = accessList(inside);
  assert.equal(onFile.length, 1, `a file written inside is the same: ${onFile.join(" | ")}`);
  assert.ok(onFile[0]!.includes(process.env.USERNAME!), onFile[0]);

  // And said of the one file that matters, whether or not it was inherited.
  secureFile(inside);
  assert.equal(accessList(inside).length, 1);
});

test("先有别人的显式权限条目，锁过之后也只剩当前用户", onlyWindows, () => {
  // 这条是 GitHub 的 windows runner 上红的那一条，本机重现出来的：`/inheritance:r` 只拿掉「继承来的」，`/grant:r`
  // 只替换它点名那个用户自己的，谁都没碰到 SYSTEM 和 Administrators 在这个文件夹上「自己持有」的条目。普通用户的
  // profile 底下这两条是继承来的，所以一直没看出来；用 token 的 default DACL 建出来的文件夹（CI runner 的 TEMP、
  // 管理员账号）这两条是显式的，`/inheritance:r` 原封不动地留着。所以这里先把那种清单做出来再锁。
  const dir = join(home, "already-granted-to-others");
  mkdirSync(dir, { recursive: true });
  // 用 SID 而不是名字：`NT AUTHORITY\SYSTEM` 这种写法随机器语言变，S-1-5-18 和 S-1-5-32-544 不会。
  execFileSync(
    "icacls",
    [
      dir,
      "/inheritance:r",
      "/grant:r",
      "*S-1-5-18:(OI)(CI)F",
      "*S-1-5-32-544:(OI)(CI)F",
      `${process.env.USERNAME}:(OI)(CI)F`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(accessList(dir).length, 3, `先摆出三条显式的：${accessList(dir).join(" | ")}`);

  secureDir(dir);
  const granted = accessList(dir);
  assert.equal(granted.length, 1, `锁过之后只剩当前用户，却是：${granted.join(" | ")}`);
  assert.ok(granted[0]!.includes(process.env.USERNAME!), granted[0]);
  assert.ok(granted[0]!.includes("(OI)(CI)"), `里面写出来的东西照样继承这一条：${granted[0]}`);
  assert.equal(permissionTrouble(), null, "这不是降级，是本来就该做到的");
});

test("it is written down that it was done, so doctor can say so", onlyWindows, () => {
  secureDir(join(home, "another-folder"));
  const mark = JSON.parse(readFileSync(join(home, "permissions.json"), "utf8"));
  assert.equal(typeof mark.at, "string");
  assert.equal(mark.trouble, null, "nothing was refused on a local NTFS folder");
  assert.equal(permissionTrouble(), null, "so doctor has nothing to report");
});

test("上一次锁不上不会粘着：这一次锁上了就是锁上了", onlyWindows, () => {
  // A refusal written down by some earlier run (a home that was on a share, a folder somebody else owned). Keeping it
  // for ever would have `doctor` reporting a machine cannot do something it has just been seen doing, and nobody
  // could clear it: the file is written by this program alone.
  writeFileSync(
    join(home, "permissions.json"),
    JSON.stringify({ at: "2020-01-01T00:00:00.000Z", trouble: "这是老早以前锁不上" }),
  );
  assert.match(String(permissionTrouble()), /老早以前/, "读的就是写下来的那份");

  secureDir(join(home, "after-a-refusal"));
  assert.equal(JSON.parse(readFileSync(join(home, "permissions.json"), "utf8")).trouble, null);
  assert.equal(permissionTrouble(), null, "doctor 不再报一件已经不存在的事");
});

test("nothing here throws, whatever it is asked about", () => {
  // A file that is not there: this is belt and braces over an inherited list, never the thing being relied on.
  assert.doesNotThrow(() => secureFile(join(home, "not-a-file")));
  // The same folder twice: the second time costs nothing and says the same.
  const twice = join(home, "twice");
  assert.doesNotThrow(() => secureDir(twice));
  assert.doesNotThrow(() => secureDir(twice));
  mkdirSync(join(home, "deep", "and", "deeper"), { recursive: true });
  assert.doesNotThrow(() => secureDir(join(home, "deep", "and", "deeper")));
});

test("锁不上就写下来，不抛错", onlyWindows, () => {
  // The one refusal that can be arranged on any machine: without a user there is nobody to grant it to. It must be a
  // report and not an exception — `init` carrying on with weaker permissions is the whole of D5a.
  const who = process.env.USERNAME;
  try {
    delete process.env.USERNAME;
    assert.doesNotThrow(() => secureDir(join(home, "nobody-to-grant-to")));
  } finally {
    if (who === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = who;
  }
  const mark = JSON.parse(readFileSync(join(home, "permissions.json"), "utf8")) as { trouble: string | null };
  assert.match(String(mark.trouble), /USERNAME/, "写下了为什么锁不上");
  assert.match(String(permissionTrouble()), /其他用户可能读得到/, "doctor 说得出这是降级");
});
