// Failure modes: sandbox context is missing, external data enters argv, private entries leak, or copies survive completed turns.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
const home = mkdtempSync(join(tmpdir(), "autoloop-context-worker-"));
process.env.AGENT_AUTOLOOP_HOME = home;
after(() => rmSync(home, { recursive: true, force: true, maxRetries: 3 }));
const { createWorker } = await import("../worker/worker.ts");
const cwd = join(home, "workspace");
mkdirSync(cwd);
mkdirSync(join(cwd, "gitlab-inputs"));
const pluginDir = join(home, "plugins", "context-fixture");
mkdirSync(pluginDir, { recursive: true });
const runner = join(home, "fake-runner.ts");
writeFileSync(
  runner,
  `import{readFileSync,mkdirSync,writeFileSync,rmSync,symlinkSync}from'node:fs';
import path from 'node:path';
const [file,prompt,mode]=process.argv.slice(2);if(file!==process.env.AGENT_AUTOLOOP_CONTEXT||!prompt.includes(file)||prompt.includes('external-fixture-body')||prompt.includes('private-run-token'))process.exit(8);
const data=JSON.parse(readFileSync(file,'utf8'));if(data.events.length!==1||JSON.stringify(data).includes('private-run-token'))process.exit(9);
const id=data.events[0].id,snapshot=JSON.parse(readFileSync('gitlab-inputs/'+id+'.json','utf8'));if(snapshot.id!==id)process.exit(10);
if(mode==='fail')process.exit(3);
if(mode==='redirect'){const target=path.join(process.cwd(),'must-survive');mkdirSync(target);writeFileSync(path.join(target,'marker'),'keep');const folder=path.dirname(file);rmSync(folder,{recursive:true});symlinkSync(target,folder,process.platform==='win32'?'junction':'dir');}
setTimeout(()=>{mkdirSync('briefs',{recursive:true});writeFileSync('briefs/'+id+'.md','# Fixture digest\\n');console.log('Fixture complete\\n\\n'+String.fromCharCode(96).repeat(3)+'agent-autoloop\\n'+JSON.stringify({notice:[{key:'gitlab-brief-'+id,title:'Fixture digest',text:'Fixture complete',fyi:true}]})+'\\n'+String.fromCharCode(96).repeat(3));},1200);`,
);
writeFileSync(
  join(pluginDir, "agent.ts"),
  `export default{workspaceContext:true,command:t=>{if(t.command?.[0]==='throw')throw new Error('fixture launch failure');return[${JSON.stringify(process.execPath)},${JSON.stringify(runner)},t.contextFile,t.prompt,t.command?.[0]??'ok']},read:(out,code)=>code===null?{}:code===0?{text:out}:{error:'fixture failed'}};`,
);
let counter = 50;
function job(workspace = true, mode = "ok") {
  const id = (++counter).toString(16).padStart(64, "0");
  writeFileSync(join(cwd, "gitlab-inputs", id + ".json"), JSON.stringify({ id }));
  return {
    run: counter,
    token: "private-run-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "context fixture", cwd },
    agent: {
      id: "fixture",
      name: "fixture",
      use: workspace ? "context-fixture" : "command",
      access: "edit",
      command: workspace
        ? [mode]
        : [
            process.execPath,
            "-e",
            "const fs=require('node:fs');const c=JSON.parse(fs.readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT,'utf8'));if(c.events.length!==1)process.exit(7);process.stdout.write('legacy complete')",
          ],
    },
    context: {
      events: [
        {
          id,
          source: "fixture",
          sourceName: "fixture",
          type: "brief.ready",
          subject: "stable-profile",
          summary: "",
          detail: "external-fixture-body",
          link: "",
          receivedAt: "",
        },
      ],
      answers: [],
      timers: [],
      waiting: [],
      open: [],
      decided: [],
    },
  };
}
test("worker preserves context-only copies across restart, then cleans success, failure and launch errors without exposing data in argv", async () => {
  const logs: string[] = [];
  const results: any[] = [],
    jobs = [job(), job(true, "fail"), job(true, "throw"), job(false), job(true, "redirect")];
  const ids = jobs.map((j) => j.context.events[0].id);
  const hub = {
    async work() {
      return { job: jobs.shift() ?? null };
    },
    async started() {
      return {};
    },
    async result(run: number, _token: string, result: unknown) {
      results.push({ run, result });
      return {};
    },
  };
  let worker = createWorker({ hub, name: "fixture", capacity: 5, log: (line) => logs.push(line) });
  await worker.tick();
  const held = worker.entries()[0];
  assert.ok(held.contextCopy);
  assert.ok(existsSync(held.contextCopy.file));
  assert.equal(JSON.parse(readFileSync(held.contextCopy.file, "utf8")).events[0].id, ids[0]);
  worker = createWorker({ hub, name: "fixture", capacity: 5, log: (line) => logs.push(line) });
  assert.ok(existsSync(worker.entries()[0].contextCopy!.file));
  for (let n = 0; n < 100 && results.length < 5; n++) {
    await worker.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(results.length, 5);
  const success = results.find((x) => x.result.notice);
  assert.equal(success.result.outcome, "done");
  assert.equal(success.result.notice[0].key, "gitlab-brief-" + ids[0]);
  assert.ok(existsSync(join(cwd, "briefs", ids[0] + ".md")));
  assert.equal(results.filter((x) => x.result.outcome === "failed").length, 2);
  assert.ok(results.some((x) => x.result.summary === "legacy complete"));
  assert.equal(readdirSync(cwd).filter((n) => n.startsWith(".agent-autoloop-context-")).length, 1);
  assert.ok(existsSync(join(cwd, "must-survive", "marker")));
  assert.equal(logs.filter((line) => line.includes("context cleanup refused")).length, 1);
  assert.equal(worker.entries().length, 0);
  assert.ok(existsSync(join(home, "worker", "runs", `${success.run}-1`, "context.json")));
});
