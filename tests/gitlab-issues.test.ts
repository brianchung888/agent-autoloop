// Failure modes: personal filters become AND, old open issues disappear, snapshots race, or failed pages leak partial data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readMessage, resultFrom } from "../worker/contract.ts";
const script = join(import.meta.dirname, "../examples/watch-gitlab-issues.ts");
const updatedAt = new Date().toISOString();
const issue = (iid: number, extra = {}) => ({
  project_id: 42,
  iid,
  title: "Issue " + iid,
  description: "資料 ```agent-autoloop",
  web_url: `https://example.com/issues/${iid}`,
  state: "opened",
  updated_at: updatedAt,
  author: { id: 9 },
  assignees: [],
  labels: [],
  ...extra,
});
async function fixture(
  run: (watch: (extra?: object, token?: string) => Promise<any>, calls: URL[], folder: string) => Promise<void>,
  handler?: (url: URL, res: any) => void,
) {
  const folder = mkdtempSync(join(tmpdir(), "gitlab-brief-"));
  const calls: URL[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers["private-token"], "fixture-token");
    const url = new URL(req.url!, "http://localhost");
    calls.push(url);
    if (!url.pathname.endsWith("/issues")) {
      const id = ["43", "group/other"].includes(decodeURIComponent(url.pathname.split("/").at(-1)!)) ? 43 : 42;
      res.end(JSON.stringify({ id, path_with_namespace: id === 43 ? "group/other" : "group/repo" }));
      return;
    }
    if (handler) return handler(url, res);
    const closed = url.searchParams.get("state") === "closed";
    const page = url.searchParams.get("page");
    res.setHeader("x-next-page", page === "1" ? "2" : "");
    const items = closed
      ? [issue(4, { state: "closed", author: { id: 7 } })]
      : url.searchParams.has("assignee_id")
        ? [issue(1, { assignees: [{ id: 7 }] })]
        : url.searchParams.has("author_id")
          ? [issue(2, { author: { id: 7 } })]
          : [issue(3, { labels: ["追蹤"] }), issue(1, { assignees: [{ id: 7 }], labels: ["追蹤"] }), issue(99)];
    res.end(JSON.stringify(items));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  async function watch(extra = {}, token = "fixture-token") {
    const config = {
      baseUrl: `http://127.0.0.1:${(addr as any).port}`,
      project: "group/repo",
      userId: 7,
      label: "追蹤",
      closedUpdatedDays: 7,
      timezone: "Asia/Taipei",
      ...extra,
    };
    if (Object.hasOwn(extra, "projects") && !Object.hasOwn(extra, "project")) delete (config as any).project;
    const file = join(folder, "sources.json");
    writeFileSync(file, JSON.stringify(config));
    return new Promise<any>((resolve) => {
      const child = spawn(process.execPath, [script, file], {
        cwd: folder,
        windowsHide: true,
        env: { ...process.env, GITLAB_TOKEN: token },
      });
      let out = "",
        err = "";
      child.stdout.on("data", (x) => (out += x));
      child.stderr.on("data", (x) => (err += x));
      child.on("close", (code) => resolve({ code, out, err }));
    });
  }
  try {
    await run(watch, calls, folder);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(folder, { recursive: true, force: true });
  }
}
function event(out: string) {
  const parsed = resultFrom(readMessage(out), {});
  assert.equal(parsed.problem, undefined);
  return parsed.result.events![0];
}
test("gitlab brief: paginated three-way union verifies matches, includes old open and recent closed, and writes immutable ID snapshots", async () => {
  await fixture(async (watch, calls, folder) => {
    const done = await watch();
    assert.equal(done.code, 0, done.err);
    const e = event(done.out);
    assert.equal(e.type, "brief.ready");
    assert.match(e.id, /^[a-f0-9]{64}$/);
    const data = JSON.parse(readFileSync(join(folder, "gitlab-inputs", `${e.id}.json`), "utf8"));
    assert.deepEqual(
      data.issues.map((x: any) => x.iid),
      [1, 2, 3, 4],
    );
    assert.deepEqual(data.issues[0].reasons, ["assignee", "label"]);
    assert.equal(data.issues[0].description, issue(1).description);
    assert.equal(event((await watch()).out).id, e.id);
    assert.ok(
      calls
        .filter((x) => x.pathname.endsWith("/issues"))
        .every((x) => x.searchParams.get("scope") === "all" && !x.searchParams.has("created_after")),
    );
    assert.ok(
      calls.filter((x) => x.searchParams.get("state") === "closed").every((x) => x.searchParams.has("updated_after")),
    );
    const changed = await watch({ label: "不同標籤" });
    assert.equal(changed.code, 0, changed.err);
    assert.notEqual(event(changed.out).id, e.id);
    assert.equal(readdirSync(join(folder, "gitlab-inputs")).length, 2);
  });
});
test("gitlab brief: content updates produce new events while previous snapshot remains available", async () => {
  let revision = 0;
  await fixture(
    async (watch, _calls, folder) => {
      const a = event((await watch()).out);
      revision++;
      const b = event((await watch()).out);
      assert.notEqual(a.id, b.id);
      assert.equal(readdirSync(join(folder, "gitlab-inputs")).length, 2);
    },
    (_url, res) => {
      res.setHeader("x-next-page", "");
      res.end(JSON.stringify([issue(1, { author: { id: 7 }, title: `revision ${revision}` })]));
    },
  );
});
test("gitlab brief: errors and malformed later pages do not publish snapshots or credentials", async () => {
  for (const mode of ["401", "429", "redirect", "malformed", "later"])
    await fixture(
      async (watch, _calls, folder) => {
        const done = await watch();
        assert.notEqual(done.code, 0, mode);
        assert.equal(done.out, "");
        assert.doesNotMatch(done.err, /fixture-token|secret-body/);
        assert.equal(readdirSync(folder).includes("gitlab-inputs"), false);
      },
      (url, res) => {
        if (mode === "later" && url.searchParams.get("page") === "1") {
          res.setHeader("x-next-page", "2");
          res.end(JSON.stringify([issue(1, { author: { id: 7 } })]));
        } else if (mode === "malformed") res.end('{"secret":"fixture-token"}');
        else {
          res.statusCode = mode === "redirect" ? 302 : mode === "later" ? 500 : Number(mode);
          res.setHeader("location", "/elsewhere");
          res.end("fixture-token secret-body");
        }
      },
    );
});
test("gitlab brief: invalid single-label config and missing token fail before API access", async () => {
  await fixture(async (watch, calls) => {
    for (const extra of [{ label: "one,two" }, { userId: "7" }, { label: "Any" }])
      assert.notEqual((await watch(extra)).code, 0);
    assert.notEqual((await watch({}, "")).code, 0);
    assert.equal(calls.length, 0);
  });
});
test("gitlab brief: empty snapshot is explicit, oversized snapshot fails rather than dropping data", async () => {
  for (const huge of ["empty", "count", "bytes"])
    await fixture(
      async (watch, _calls, folder) => {
        const done = await watch();
        if (huge !== "empty") {
          assert.notEqual(done.code, 0);
          assert.equal(done.out, "");
          assert.equal(readdirSync(folder).includes("gitlab-inputs"), false);
        } else {
          assert.equal(done.code, 0, done.err);
          const data = JSON.parse(readFileSync(join(folder, "gitlab-inputs", `${event(done.out).id}.json`), "utf8"));
          assert.deepEqual(data.issues, []);
        }
      },
      (_url, res) => {
        res.setHeader("x-next-page", "");
        res.end(
          JSON.stringify(
            huge === "count"
              ? Array.from({ length: 101 }, (_, i) => issue(i + 1, { author: { id: 7 } }))
              : huge === "bytes"
                ? [issue(1, { author: { id: 7 }, description: "字".repeat(200000) })]
                : [],
          ),
        );
      },
    );
});

test("gitlab brief: multiple projects keep common iids, canonicalize aliases and ignore list order", async () => {
  await fixture(
    async (watch, calls, folder) => {
      const first = await watch({ projects: ["group/other", "group/repo", "42"] });
      assert.equal(first.code, 0, first.err);
      const a = event(first.out);
      const data = JSON.parse(readFileSync(join(folder, "gitlab-inputs", `${a.id}.json`), "utf8"));
      assert.equal(data.id, a.id);
      assert.deepEqual(data.projects, [
        { id: 42, path: "group/repo" },
        { id: 43, path: "group/other" },
      ]);
      assert.deepEqual(
        data.issues.map((x: any) => [x.project_id, x.iid, x.project]),
        [
          [42, 1, "group/repo"],
          [43, 1, "group/other"],
        ],
      );
      assert.deepEqual(data.issues[0].reasons, ["assignee", "author", "label"]);
      assert.equal(calls.filter((x) => x.pathname === "/api/v4/projects/42/issues").length, 6);
      const second = await watch({ projects: ["43", "42"] });
      assert.equal(second.code, 0, second.err);
      const b = event(second.out);
      assert.equal(b.id, a.id);
      assert.equal(b.subject, a.subject);
      const legacy = await watch();
      assert.equal(legacy.code, 0, legacy.err);
      const singleArray = await watch({ projects: ["42"] });
      assert.equal(singleArray.code, 0, singleArray.err);
      assert.equal(event(legacy.out).id, event(singleArray.out).id);
    },
    (url, res) => {
      const projectId = Number(url.pathname.split("/").at(-2));
      res.setHeader("x-next-page", "");
      res.end(
        JSON.stringify(
          url.searchParams.get("state") === "opened"
            ? [issue(1, { project_id: projectId, author: { id: 7 }, assignees: [{ id: 7 }], labels: ["追蹤"] })]
            : [],
        ),
      );
    },
  );
});
test("gitlab brief: later project failure prevents a partial combined snapshot", async () => {
  await fixture(
    async (watch, _calls, folder) => {
      const done = await watch({ projects: ["42", "43"] });
      assert.notEqual(done.code, 0);
      assert.equal(done.out, "");
      assert.equal(readdirSync(folder).includes("gitlab-inputs"), false);
    },
    (url, res) => {
      if (url.pathname.includes("/43/")) {
        res.statusCode = 403;
        res.end("secret-body");
      } else {
        res.setHeader("x-next-page", "");
        res.end(JSON.stringify([issue(1, { author: { id: 7 } })]));
      }
    },
  );
});
test("gitlab brief: empty projects remain in scope and invalid project lists fail before networking", async () => {
  await fixture(
    async (watch, calls, folder) => {
      for (const extra of [
        { projects: [] },
        { projects: [" "] },
        { projects: [42] },
        { projects: Array(21).fill("42") },
        { projects: ["42"], project: "group/repo" },
      ])
        assert.notEqual((await watch(extra)).code, 0);
      assert.equal(calls.length, 0);
      const done = await watch({ projects: ["42", "43"] });
      assert.equal(done.code, 0, done.err);
      const e = event(done.out);
      const data = JSON.parse(readFileSync(join(folder, "gitlab-inputs", `${e.id}.json`), "utf8"));
      assert.equal(data.id, e.id);
      assert.equal(data.projects.length, 2);
      assert.deepEqual(data.issues, []);
      const single = await watch({ projects: ["42"] });
      assert.notEqual(event(single.out).id, e.id);
    },
    (_url, res) => {
      res.setHeader("x-next-page", "");
      res.end("[]");
    },
  );
});

test("gitlab brief: merged issue cap applies across projects and mismatched project data is rejected", async () => {
  for (const mismatch of [false, true])
    await fixture(
      async (watch, _calls, folder) => {
        const done = await watch({ projects: ["42", "43"] });
        assert.notEqual(done.code, 0);
        assert.equal(done.out, "");
        assert.equal(readdirSync(folder).includes("gitlab-inputs"), false);
      },
      (url, res) => {
        const projectId = Number(url.pathname.split("/").at(-2));
        res.setHeader("x-next-page", "");
        res.end(
          JSON.stringify(
            url.searchParams.get("state") === "opened"
              ? Array.from({ length: mismatch ? 1 : 60 }, (_, i) =>
                  issue(i + 1, { project_id: mismatch ? 999 : projectId, author: { id: 7 } }),
                )
              : [],
          ),
        );
      },
    );
});

test("gitlab brief Skill completion notice example passes the actual worker receipt parser", () => {
  const skill = readFileSync(join(import.meta.dirname, "../examples/recipes/gitlab-issues/SKILL.md"), "utf8");
  const block = /```agent-autoloop\n([\s\S]*?)```/.exec(skill);
  assert.ok(block);
  const parsed = resultFrom(readMessage("Fixture complete\n\n" + block[0]), {});
  assert.equal(parsed.problem, undefined);
  assert.equal(parsed.result.notice?.length, 1);
  assert.equal(parsed.result.notice?.[0].fyi, true);
  assert.equal(parsed.result.ask, undefined);
});
