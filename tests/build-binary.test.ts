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
  // 同一个提交建两次，要是同两个工具建出来的（不是同一份字节：下面那一条讲这件事）。
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

test("打 tag 就能发：Release 不在就先建，而且同一个 tag 不会有两个 release 在跑", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  // 一个单独 push 上去的 tag 后面没有 Release，`gh release upload` 就没有地方可上传，三个平台白建一遍。
  const attach = workflow.slice(workflow.indexOf("上传到 Release"));
  assert.match(attach, /gh release create "\$TAG"/, "Release 不在的时候没有人去建它");
  assert.match(attach, /--verify-tag/, "没有 --verify-tag，一个打错的 tag 也能建出一个 Release");
  assert.ok(
    attach.indexOf('gh release create "$TAG"') < attach.indexOf('gh release upload "$TAG"'),
    "先上传再建 Release，顺序反了",
  );
  // 建不出来可以容忍，但容忍完要再看一眼：「已经有了」是竞态赢的那一边，而「还是没有」是真的失败。
  assert.match(attach, /gh release create "\$TAG"[^\n]*\|\| true/, "create 失败就直接挂了，竞态赢的那一边也算失败");
  const afterCreate = attach.slice(attach.indexOf('gh release create "$TAG"'));
  assert.match(afterCreate, /gh release view "\$TAG"/, "容忍了 create 失败，却没有再看一眼它到底在不在");
  assert.match(afterCreate, /exit 1/, "既不在也建不出来的时候没有当失败说出来");
  assert.ok(
    afterCreate.indexOf('gh release view "$TAG"') < afterCreate.indexOf('gh release upload "$TAG"'),
    "先上传才回头看 Release 在不在，顺序反了",
  );
  // 同一个 tag 来两次，或者一次 tag、一次手动，两条流水线会各自往同一个 Release 上传同一批文件。
  assert.match(workflow, /^concurrency:$/m, "没有 concurrency，两条同样的流水线会撞在一起");
  // 一个 tag 只有一个组。dispatch 填进来的是 tag 的短名（v1.2.3），tag push 来的 github.ref 是
  // refs/tags/v1.2.3——同一个 tag 的两个写法就是两个组，两条流水线于是会同时往同一个 Release 上传
  // （phase3-verification-round2.md #8）。ref_name 两边都是短名。
  assert.match(workflow, /group: release-\$\{\{ inputs\.release \|\| github\.ref_name \}\}/, "组名不是 tag 的短名");
  assert.doesNotMatch(workflow, /group: release-\$\{\{[^}]*github\.ref \}\}/, "组名还在用 github.ref");
});

test("校验和不是拿来比两次建置的：这不是可重现建置，两处文字都得说清楚", () => {
  // useCodeCache 把 V8 的 code cache 放进 blob，那是建置那台机器的运行时产出的，不是源码的函数：同一个提交建两次，
  // 两个文件不一样。「钉住版本，所以两次建置是同一个东西」这句话读起来像可重现建置，而它不是——照着它拿自己重建的
  // 那一份去对校验和，得出的是「下载到的文件被换过」这个错结论，而那是这串校验和唯一要回答的问题。
  assert.equal(seaConfig().useCodeCache, true, "要谈可重现建置得先改掉它，而那是另一件事");
  const source = readFileSync(join(root, "scripts", "build-binary.ts"), "utf8");
  assert.match(source, /not a reproducible build/, "建置脚本还在许一个它做不到的承诺");
  // 下载的人读的是 INSTALL.md，所以那句话也要在那里，连同「export 了那两个变量会盖掉版本」。
  const install = readFileSync(join(root, "INSTALL.md"), "utf8");
  assert.match(install, /可重现建置/, "INSTALL.md 没说这不是可重现建置");
  assert.match(install, /AGENT_AUTOLOOP_COMMIT/, "INSTALL.md 没说 export 了这个会盖掉二进位自己说的版本");
  assert.match(install, /AGENT_AUTOLOOP_RELEASE/);
});

test("改一份文档也会去看被跟踪的文字：那一步不挂在 scope 上", () => {
  // scope=docs 的意思是「没有测试读这些文字」，于是 check.yml 里每一步都被 scope != 'docs' 拦住，整条流水线
  // 一个文件都不看。而控制字符、还有不再解码的文件，正是一次改文档的提交带进来的东西（INSTALL.md 里那条
  // `certutil -hashfile .<BEL>gent-autoloop-windows-x64.exe` 就是这么来的）。tests/tracked-text.test.ts 不需要
  // 任何依赖，所以跑它那一步不该挂在 scope 上，它前面的 node 也不该。
  const lines = readFileSync(join(root, ".github", "workflows", "check.yml"), "utf8").split("\n");
  const step = lines.findIndex((line) => line.includes("- run:") && line.includes("tests/tracked-text.test.ts"));
  assert.ok(step > 0, "check.yml 里没有谁去跑 tests/tracked-text.test.ts");
  // 一个 step 的 `if` 写在它自己那一行，或者同一个 step 里紧挨着的别的行：从这一步往上找到它自己的 `- ` 开头。
  let from = step;
  while (from > 0 && !lines[from].trimStart().startsWith("- ")) from -= 1;
  const own = lines.slice(from, step + 1).join("\n");
  assert.doesNotMatch(own, /\bif:/, `跑 tracked-text 的那一步被 scope 拦住了：\n${own}`);
  // 不挂 scope 的 setup-node 也得在它前面，否则那一步没有 node 可用。
  const setup = lines.findIndex((line) => line.includes("uses: actions/setup-node"));
  assert.ok(setup > 0 && setup < step, "setup-node 不在跑 tracked-text 的那一步前面");
  let head = setup;
  while (head > 0 && !lines[head].trimStart().startsWith("- ")) head -= 1;
  const node = lines.slice(head, setup + 1).join("\n");
  assert.doesNotMatch(node, /\bif:/, `第一个 setup-node 挂在 scope 上，docs 的时候没有 node：\n${node}`);
  // 而 `npm ci` 还是该挂着：这一步的全部意思就是它不需要依赖。
  const ci = lines.findIndex((line) => line.includes("run: npm ci"));
  assert.ok(ci > 0, "check.yml 里没有 npm ci 了");
  assert.match(lines[ci - 1], /if: steps\.scope\.outputs\.scope != 'docs'/, "npm ci 不该跟着一起放开");
});
