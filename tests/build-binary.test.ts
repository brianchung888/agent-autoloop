// The build contract (scripts/build-binary.ts). Not what the build produces — that needs a binary, and
// tests/sea-format.test.ts is where one is made — but the set of things that have to be true together for a binary to
// be buildable and correct at all.
//
// Failure cases: a `--define` goes missing, so the bundle either refuses to build (the two top-level awaits come back)
// or builds and reads `import.meta` as nothing; a file is added to what the program reads out of itself and not to
// what the build embeds, so the binary dies at its first start naming a file that is not in it; the entry grows a
// top-level await, which a CJS output cannot have; the version is left out, so every bug report says `dev`; a bundler
// creeps into package.json, which is the one thing the maintainer was promised would not happen (计划 D1(a)).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ASSETS } from "../host/assets.ts";
import { bundleArgs, ENTRY, seaConfig, toldSource, TOOLS } from "../scripts/build-binary.ts";

const root = join(import.meta.dirname, "..");

test("bundler 的三个 --define 一个都不能少，banner 也是", () => {
  // 这三件是建置契约本身：CJS 的产物没有 import.meta。main=false 把每个「当脚本直接跑」的入口守卫变成死码，
  // 树里那两个 top-level await（plugins/delivery/run.ts、protocol/conformance.ts）因此消失——CJS 不能有。
  // 另外两个把 import.meta.dirname 与 import.meta.url 换成 CJS 里同样意思的词。
  const args = bundleArgs("build/sea-entry.ts", "build/agent-autoloop.cjs");
  assert.ok(args.includes("--define:import.meta.main=false"), args.join(" "));
  assert.ok(args.includes("--define:import.meta.dirname=__dirname"), args.join(" "));
  assert.ok(args.includes("--define:import.meta.url=__seaModuleUrl"), args.join(" "));
  // import.meta.url 换成的那个词要真有人给它赋值，而且要在所有模块之前：banner 就是「所有模块之前」。
  const banner = args.find((word) => word.startsWith("--banner:js="));
  assert.ok(banner, "没有 banner：__seaModuleUrl 在打包出来的文件里是个没人赋值的名字");
  assert.match(banner, /const __seaModuleUrl = require\('node:url'\)\.pathToFileURL\(__filename\)\.href;/);
  // CJS 产物、node24 目标、node:* 留给 runtime：这三件也是契约。
  for (const word of ["--bundle", "--platform=node", "--format=cjs", "--target=node24", "--packages=external"]) {
    assert.ok(args.includes(word), `少了 ${word}`);
  }
  // 整条命令行里不能有双引号：Windows 上 npx 是个 .cmd，只有 shell 读得了它，而 shell 不会替谁加引号。
  for (const word of args) assert.ok(!word.includes('"'), `这个词带引号，过不了 Windows 的 shell：${word}`);
});

test("打包版带的文件就是程序要读的那些，一个不多一个不少", () => {
  const embedded = seaConfig().assets;
  assert.deepEqual(Object.keys(embedded).sort(), [...ASSETS].sort(), "建置内嵌的清单和程序读的清单不是同一张");
  for (const [name, from] of Object.entries(embedded)) {
    assert.equal(from, name, "asset 的名字就是它在仓库里的路径：两头对不上就读不回来");
    assert.ok(existsSync(join(root, name)), `${name} 不在树里：内嵌一个空名字，打包版一启动就死`);
  }
  // 建置是在仓库根跑的，所以 main/output 也是仓库相对的那两个路径。
  assert.equal(seaConfig().main, "build/agent-autoloop.cjs");
  assert.equal(seaConfig().output, "build/sea-prep.blob");
  assert.equal(seaConfig().disableExperimentalSEAWarning, true, "不然每次启动都先说一句 SEA 是实验功能");
});

test("入口里没有 top-level await，而且顺序是定好的那三行", () => {
  // 一个模块的 import 全跑在它 body 之前，而「import 命令行」就等于「把命令跑掉」。所以版本要排在最前面，
  // 内置清单第二，命令行最后——而且全是静态 import：CJS 的产物不能有 top-level await。
  const code = ENTRY.split("\n").filter((line) => !line.trimStart().startsWith("//"));
  assert.doesNotMatch(code.join("\n"), /\bawait\b/, "入口有 top-level await：CJS 打不出来");
  const lines = ENTRY.split("\n").filter((line) => line.startsWith("import "));
  assert.deepEqual(lines, ['import "./sea-told.ts";', 'import "./builtins.generated.ts";', 'import "../cli/main.ts";']);

  const told = toldSource({ commit: "abc123", release: "v1.2.3" });
  assert.match(told, /AGENT_AUTOLOOP_COMMIT \|\|= "abc123";/);
  assert.match(told, /AGENT_AUTOLOOP_RELEASE \|\|= "v1\.2\.3";/);
  assert.doesNotMatch(told, /\bimport\b/, "这个文件要能排在最前面，所以它自己不该再 import 什么");
  // 没有 tag 的时候是空字符串，host/version.ts 把它读成「这次建置不知道」。
  assert.match(toldSource({ commit: "abc", release: "" }), /AGENT_AUTOLOOP_RELEASE \|\|= "";/);
});

test("两个工具是钉住版本的，而且 package.json 一个字没加", () => {
  // 同一个提交建两次，要是同一个东西。
  for (const pinned of Object.values(TOOLS)) assert.match(pinned, /@\d+\.\d+\.\d+(-[\w.]+)?$/, pinned);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {}, "装一个东西才能跑，这个程序就不是那个程序了");
  // D1(a)：bundler 只出现在 release job 里，开发与测试流程一个字不变。
  const dev = Object.keys(manifest.devDependencies ?? {});
  for (const name of ["esbuild", "postject"]) {
    assert.ok(!dev.includes(name), `${name} 进了 devDependencies：bundler 该只在 release job 里出现`);
  }
  assert.deepEqual(dev.sort(), ["@types/node", "prettier", "typescript"]);
});

test("两个平台的入口脚本都只是入口：建置契约只写一遍", () => {
  // 同一份契约用两种语言各写一遍，就是两份契约。这两个脚本只负责转交。
  for (const name of ["build-binary.ps1", "build-binary.sh"]) {
    const text = readFileSync(join(root, "scripts", name), "utf8");
    assert.match(text, /scripts[\\/]build-binary\.ts/, `${name} 没有转交给那一份`);
    assert.doesNotMatch(text, /--define:/, `${name} 自己又抄了一份 --define`);
    assert.doesNotMatch(text, /NODE_SEA_BLOB/, `${name} 自己又抄了一遍注入`);
  }
  // release.yml 用的是这两个脚本，不是自己再拼一遍命令。
  const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /scripts\/build-binary\.ps1/);
  assert.match(workflow, /scripts\/build-binary\.sh/);
  assert.doesNotMatch(workflow, /npx --yes esbuild/, "release.yml 自己打包了一遍");
  // 三个平台，各自带 SHA256。
  for (const name of ["linux-x64", "macos-arm64", "windows-x64"]) assert.match(workflow, new RegExp(name));
  assert.match(workflow, /sha256sum|shasum/);
});
