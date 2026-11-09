import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("worker-settle");
const { createWorker } = await import("../worker/worker.ts");
const { HubError } = await import("../protocol/client.ts");

function createFixture(run: number, result: any) {
  const dir = join(home, "worker", "runs", `${run}-1`);
  mkdirSync(dir, { recursive: true });
  const entry = {
    run,
    token: `token-${run}`,
    attempt: 1,
    turn: 1,
    dir,
    session: "s1",
    resume: null,
    repairs: 0,
    triedFresh: false,
    job: {
      run,
      token: `token-${run}`,
      rule: { name: "test-rule", prompt: "prompt" },
      agent: { use: "test-agent" },
    },
    result,
  };
  writeFileSync(join(dir, "entry.json"), JSON.stringify(entry));
  return { dir, entry };
}

test("settle logs outcome, summary, error, notice, and ask cards with options", async () => {
  const lines: string[] = [];
  const fakeHub = {
    async work() {
      return { job: null, cancel: [] };
    },
    async started() {
      return { ok: true };
    },
    async result(run: number, token: string, result: any) {
      if (run === 6) {
        return { rejected: [{ card: 99, reason: "card closed" }] };
      }
      if (run === 7) {
        throw new HubError(400, "invalid token");
      }
      return { rejected: [] };
    },
  };
  const worker = createWorker({
    hub: fakeHub as any,
    name: "test-worker",
    wait: 0,
    log: (line) => lines.push(line),
  });

  // 1. Run 1: done with summary and single-line notice
  createFixture(1, {
    outcome: "done",
    summary: "第一行結論已達成",
    notice: [{ title: "任務回報", text: "一切正常" }],
  });

  // 2. Run 2: failed with error and multi-line notice
  createFixture(2, {
    outcome: "failed",
    error: "資料庫連線超時\n額外偵錯細節",
    notice: [{ title: "告警通知", text: "第一行告警\n第二行補充說明" }],
  });

  // 3. Run 3: done with single-line ask
  createFixture(3, {
    outcome: "done",
    summary: "請確認下一步",
    ask: [{ title: "確認部署", text: "即將發布至正式環境", options: ["確認", "取消"] }],
  });

  // 4. Run 4: done with multi-line ask
  createFixture(4, {
    outcome: "done",
    ask: [{ title: "選擇版本", text: "請選擇要部署的映像檔：\n- v1.0\n- v2.0", options: ["v1.0", "v2.0"] }],
  });

  // 5. Run 5: cancelled without summary or error
  createFixture(5, {
    outcome: "cancelled",
  });

  // 6. Run 6: rejected items from hub
  createFixture(6, {
    outcome: "done",
    summary: "部分卡片被拒絕",
  });

  // 7. Run 7: hub refused result
  createFixture(7, {
    outcome: "done",
    summary: "被丟棄的結果",
  });

  await worker.tick();

  // Assert Run 1
  assert.ok(lines.includes("run 1: done — 第一行結論已達成"));
  assert.ok(lines.includes("run 1: [notice] 任務回報: 一切正常"));

  // Assert Run 2
  assert.ok(lines.includes("run 2: failed — 資料庫連線超時"));
  assert.ok(lines.includes("run 2:   額外偵錯細節"));
  assert.ok(lines.includes("run 2: [notice] 告警通知: 第一行告警"));
  assert.ok(lines.includes("run 2: [notice]   第二行補充說明"));

  // Assert Run 3
  assert.ok(lines.includes("run 3: done — 請確認下一步"));
  assert.ok(lines.includes("run 3: [ask] 確認部署: 即將發布至正式環境 (options: 確認 / 取消)"));

  // Assert Run 4
  assert.ok(lines.includes("run 4: done"));
  assert.ok(lines.includes("run 4: [ask] 選擇版本: 請選擇要部署的映像檔："));
  assert.ok(lines.includes("run 4: [ask]   - v1.0"));
  assert.ok(lines.includes("run 4: [ask]   - v2.0 (options: v1.0 / v2.0)"));

  // Assert Run 5
  assert.ok(lines.includes("run 5: cancelled"));

  // Assert Run 6
  assert.ok(lines.includes('run 6: not applied: {"card":99,"reason":"card closed"}'));
  assert.ok(lines.includes("run 6: done — 部分卡片被拒絕"));

  // Assert Run 7
  assert.ok(lines.includes("run 7: the hub refused its result (400: invalid token); dropped"));
});
