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

test("it is written down that it was done, so doctor can say so", onlyWindows, () => {
  secureDir(join(home, "another-folder"));
  const mark = JSON.parse(readFileSync(join(home, "permissions.json"), "utf8"));
  assert.equal(typeof mark.at, "string");
  assert.equal(mark.trouble, null, "nothing was refused on a local NTFS folder");
  assert.equal(permissionTrouble(), null, "so doctor has nothing to report");
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
