// What the owner stopped stays stopped, and what comes back to a thread comes back to that thread. Failure cases: a run told
// to stop hands in a failure and is queued again, so it starts again minutes later; the card saying it will try again stays
// open once it's stopped, and needs clearing by hand; after a rule stops running in parallel, an answer or a due check starts a
// run on another thread, whose context has neither the answer nor the check, so the question is never really answered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide } from "../kernel/decide.ts";
import { empty, evolve, rows, type Fact } from "../kernel/evolve.ts";
import { parseRules } from "../protocol/rules.ts";
import { invariants } from "../sim/invariants.ts";

const env = { secret: "stops", publicUrl: "https://hub.test" };
const rules = parseRules(readFileSync(new URL("./rules.fixture.json", import.meta.url), "utf8"), 0, "UTC");
const MINUTE = 60_000;

function hub() {
  let view = empty();
  let now = Date.UTC(2026, 10, 5, 0, 0, 0);
  const log: Fact[] = [];
  const act = (type: string, ...args: any[]) => {
    const decided = decide(view, { type, args }, now++, env);
    log.push(...decided.facts);
    view = evolve(view, decided.facts);
    return decided.value;
  };
  act("rules", rules);
  return {
    act,
    run: (id: number) => view.get("runs", id)!,
    cards: () => rows(view, "cards"),
    pass: (minutes: number) => void (now += minutes * MINUTE),
    view: () => view,
    /** The same facts played into an empty view: what a projection rebuild would come out with. */
    replayed: () => evolve(empty(), log),
    check: () => invariants(view, log),
  };
}

const feedback = { id: "e1", type: "feedback.new", subject: "#1" };
const notParallel = () => {
  const next = structuredClone(rules);
  for (const rule of next.rules) delete rule.parallel;
  return next;
};

/** Fails a run three times, so it's told the owner it will try again, and leaves it queued for the fourth. */
function failedThreeTimes(it: ReturnType<typeof hub>) {
  it.act("ingest", "app", feedback);
  let id = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    it.pass(61);
    const job = it.act("claimNext", "w1", `claim-${attempt}`);
    id = job.run;
    it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  }
  return id;
}
const failing = (it: ReturnType<typeof hub>, id: number) => it.cards().find((card) => card.key === `run:${id}:failing`);

test("a run told to stop that hands in a failure stays stopped, and doesn't start again", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  it.act("cancel", job.run);
  it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  assert.equal(it.run(job.run).state, "cancelled");
  assert.equal(it.run(job.run).finished_at !== null, true);
  it.pass(120);
  assert.equal(it.act("claimNext", "w1", "c2"), null);
  it.check();
});

test("a failure handed in with no stop asked for still tries again", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  assert.equal(it.run(job.run).state, "queued");
  it.check();
});

test("stopping a run waiting to try again closes the card that says it will", () => {
  const it = hub();
  const id = failedThreeTimes(it);
  assert.equal(failing(it, id)?.state, "open");
  it.act("cancel", id);
  assert.equal(it.run(id).state, "cancelled");
  assert.equal(failing(it, id)?.state, "closed");
  it.check();
});

test("a run with that card, stopped while it's going, closes the card when it has stopped", () => {
  const it = hub();
  const id = failedThreeTimes(it);
  it.pass(61);
  const job = it.act("claimNext", "w1", "last");
  assert.equal(job.run, id);
  it.act("cancel", id);
  assert.equal(failing(it, id)?.state, "open", "not stopped yet");
  it.act("finish", job.run, job.token, { outcome: "cancelled", summary: "已停止" });
  assert.equal(failing(it, id)?.state, "closed");
  it.check();
});

test("a run told to stop whose worker stopped mentioning it closes the card that says it may still be going", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  it.act("cancel", job.run);
  it.pass(6);
  it.act("heartbeat", "w1", []);
  it.act("tick");
  assert.equal(it.run(job.run).state, "unknown");
  const unknown = () => it.cards().find((card) => card.key === `run:${job.run}:unknown`);
  assert.equal(unknown()?.state, "open");
  it.act("finish", job.run, job.token, { outcome: "failed", error: "boom" });
  assert.equal(it.run(job.run).state, "cancelled");
  assert.equal(unknown()?.state, "closed");
  it.check();
});

test("an answer comes back to the thread that asked, after the rule stopped running in parallel", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  const question = { title: "选哪个", text: "选一个", options: ["甲", "乙"], about: "接着做" };
  it.act("finish", job.run, job.token, { outcome: "done", summary: "问了", session: "S", ask: [question] });
  const [card] = it.cards().filter((card) => card.kind === "ask");
  assert.equal(card.lane, "#1", "the fixture's rule runs in parallel");
  it.act("rules", notParallel());
  it.act("answer", card.id, { choice: 1 });
  const next = it.act("claimNext", "w1", "c2");
  assert.equal(it.run(next.run).lane, "#1");
  assert.equal(next.session, "S");
  assert.deepEqual(
    next.context.answers.map((answer: any) => answer.choice),
    [1],
  );
  it.act("finish", next.run, next.token, { outcome: "done", summary: "做完了" });
  it.check();
});

test("a due check comes back to its thread, after the rule stopped running in parallel", () => {
  const it = hub();
  it.act("ingest", "app", feedback);
  const job = it.act("claimNext", "w1", "c1");
  const later = { key: "看看", at: "2026-11-05T01:00:00Z", about: "到时候查" };
  it.act("finish", job.run, job.token, { outcome: "done", summary: "约了", session: "S", later: [later] });
  it.act("rules", notParallel());
  it.pass(61);
  it.act("tick");
  const next = it.act("claimNext", "w1", "c2");
  assert.equal(it.run(next.run).lane, "#1");
  assert.deepEqual(
    next.context.timers.map((timer: any) => timer.key),
    ["看看"],
  );
  it.act("finish", next.run, next.token, { outcome: "done", summary: "查过了" });
  it.check();
});

// ---- `stop --force`：接单程序死掉以后的死锁 ----
// 失联的接单程序手上那一轮永远停在 claimed：sweep 只看最近两分钟出现过的接单程序的租约（kernel/decide.ts:266），
// 同一组后面的全排不进去（:299-300），而普通 cancel 只写 cancel_at，等它下次来领——它不会再来了。
const feedbackOn = (subject: string) => ({ id: `e-${subject}`, type: "feedback.new", subject });

/** 一次只跑一件的规则。lane 要分得开才会是两轮（ingest 只在 parallel 写了的时候按 subject 分 lane），
 * 组里一次只许一件才看得出死锁，所以 parallel 是 1 而不是删掉。 */
const oneAtATime = () => {
  const next = structuredClone(rules);
  next.rules.find((rule) => rule.name === "意见")!.parallel = 1;
  return next;
};

/** 两件同一组（notes，一次一件）、不同 lane 的活，第一件已经被 w1 领走。 */
function twoInOneGroup(it: ReturnType<typeof hub>) {
  it.act("rules", oneAtATime());
  it.act("ingest", "app", feedbackOn("#1"));
  it.act("ingest", "app", feedbackOn("#2"));
  return it.act("claimNext", "w1", "c1");
}

test("接单程序刚打过招呼，--force 被挡下来：它听得见普通的 stop", () => {
  const it = hub();
  const job = twoInOneGroup(it);
  it.act("heartbeat", "w1", [job.run]);
  assert.throws(() => it.act("cancel", job.run, true), /w1/);
  assert.equal(it.run(job.run).state, "claimed");
  it.check();
});

test("接单程序领了活还没来得及打招呼，--force 也挡：那一轮好得很", () => {
  const it = hub();
  const job = twoInOneGroup(it);
  assert.throws(() => it.act("cancel", job.run, true), /w1/);
  assert.equal(it.run(job.run).state, "claimed");
  it.check();
});

test("接单程序失联超过两分钟，--force 把那一轮结掉，同一组后面的接着跑", () => {
  const it = hub();
  const job = twoInOneGroup(it);
  it.act("heartbeat", "w1", [job.run]);
  it.pass(10);
  // 死锁本身：不强制的话，这一组再也领不到东西。
  assert.equal(it.act("claimNext", "w1", "c2"), null);
  it.act("cancel", job.run, true);
  assert.equal(it.run(job.run).state, "cancelled");
  assert.equal(it.run(job.run).finished_at !== null, true);
  const next = it.act("claimNext", "w1", "c3");
  assert.equal(it.run(next.run).grp, it.run(job.run).grp);
  assert.notEqual(next.run, job.run);
  it.check();
});

test("从来没打过招呼的接单程序，那一轮过了两分钟一样强制得掉", () => {
  const it = hub();
  const job = twoInOneGroup(it);
  it.pass(10);
  it.act("cancel", job.run, true);
  assert.equal(it.run(job.run).state, "cancelled");
  it.check();
});

test("强制结掉会说一声，说的是哪台机器、失联多久、可能做过两次", () => {
  const it = hub();
  const job = twoInOneGroup(it);
  it.act("heartbeat", "w1", [job.run]);
  it.pass(10);
  it.act("cancel", job.run, true);
  const card = it.cards().find((card) => card.key === `run:${job.run}:forced`)!;
  assert.ok(card, "强制结掉要留一张卡片");
  assert.match(card.text, /w1/);
  assert.match(card.text, /10 分钟/);
  assert.match(card.text, /丢掉/);
  it.check();
});

test("被强制结掉以后，那台机器要是回来交结果，交不进去，状态也不动", () => {
  const it = hub();
  const job = twoInOneGroup(it);
  it.pass(10);
  it.act("cancel", job.run, true);
  assert.throws(() => it.act("finish", job.run, job.token, { outcome: "done", summary: "我做完了" }));
  assert.throws(() => it.act("started", job.run, job.token, { session: "S" }));
  assert.equal(it.run(job.run).state, "cancelled");
  it.check();
});

test("强制结掉这件事重放得出来：投影重建以后还是 cancelled", () => {
  const it = hub();
  const job = twoInOneGroup(it);
  it.pass(10);
  it.act("cancel", job.run, true);
  assert.equal(it.replayed().get("runs", job.run)!.state, "cancelled");
  it.check();
});

test("排队中的那一轮加不加 --force 都一样结掉", () => {
  const it = hub();
  const job = twoInOneGroup(it);
  const queued = rows(it.view(), "runs", { state: "queued" })[0];
  it.act("cancel", queued.id, true);
  assert.equal(it.run(queued.id).state, "cancelled");
  assert.equal(it.run(job.run).state, "claimed");
  it.check();
});

test("已经结束的那一轮，--force 还是说它结束了", () => {
  const it = hub();
  const job = twoInOneGroup(it);
  it.act("finish", job.run, job.token, { outcome: "done", summary: "做完了" });
  assert.throws(() => it.act("cancel", job.run, true));
  it.check();
});

test("同名接单程序重建以后 --force 被挡，但租约到期那一轮自己变 unknown，这一组自己就通了", () => {
  const it = hub();
  const job = twoInOneGroup(it);
  it.pass(10);
  // 重建出来的同名接单程序：手上什么都没有，但招呼照打，所以中台看它是新鲜的。
  it.act("heartbeat", "w1", []);
  assert.throws(() => it.act("cancel", job.run, true), /w1/);
  // 不用强制也不用等人：那一轮自己的 seen_at 没人再往前推，过了租约就被认作下落不明。
  it.act("tick");
  assert.equal(it.run(job.run).state, "unknown");
  const next = it.act("claimNext", "w1", "c3");
  assert.equal(it.run(next.run).grp, it.run(job.run).grp);
  assert.notEqual(next.run, job.run);
  it.check();
});
