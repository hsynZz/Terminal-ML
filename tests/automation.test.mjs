import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
const vite = await createServer({ appType:'custom', configFile:false, server:{middlewareMode:true} });
after(()=>vite.close());
const policy = await vite.ssrLoadModule('/worker/automation-policy.ts');
const automation = await vite.ssrLoadModule('/worker/automation.ts');
const scheduler = await vite.ssrLoadModule('/worker/scheduler/index.ts');
function dbFixture() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE terminal_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE terminal_snapshots (as_of TEXT NOT NULL)');
  sql.prepare('INSERT INTO terminal_settings VALUES (?, ?, ?)').run('model', JSON.stringify({ trainedAt:null, trainingSamples:0, learnedWeights:{policy:0.7}, validation:null }), '2026-09-04');
  sql.prepare('INSERT INTO terminal_snapshots VALUES (?)').run('2026-09-04T15:15:00.000Z');
  const db = { prepare(query) {
    const statement=sql.prepare(query); let values=[];
    return { bind(...args){values=args;return this;}, async first(){return statement.get(...values)??null;}, async all(){return {results:statement.all(...values)};}, async run(){return {meta:{changes:Number(statement.run(...values).changes)}};} };
  }};
  return { sql, env:{DB:db,AUTOMATION_SECRET:'test-only'} };
}
function request(body, secret='test-only') {
  return new Request('https://terminal/api/automation/run',{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
}
test('daily UTC coverage yields exactly one primary Berlin time in summer, winter and DST transitions', ()=>{
  const crons=JSON.parse(readFileSync('worker/scheduler/wrangler.jsonc','utf8')).triggers.crons;
  assert.deepEqual(crons,policy.AUTOMATION_CRONS);
  for(const day of ['2026-01-05','2026-07-05','2026-03-29','2026-10-25']) {
    const accepted=[];
    for(const hour of [15,16,17]) for(const minute of [15,30,45]) {
      const at=Date.parse(`${day}T${hour}:${minute}:00Z`);
      if(policy.dueJob(crons[0],at)) accepted.push(policy.berlinParts(at).minute);
    }
    assert.deepEqual(accepted,[1035,1050,1065]);
  }
  for(const [day,hour] of [['2026-01-03',21],['2026-07-04',20]]) {
    assert.equal(policy.dueJob(crons[1],Date.parse(`${day}T${hour}:00:00Z`)),'WEEKLY_RETRAIN');
    assert.equal(policy.dueJob(crons[1],Date.parse(`${day}T${hour===20?21:20}:00:00Z`)),null);
  }
});
test('controlled daily test calls only refresh and proves the new stored snapshot',async()=>{
  const {env,sql}=dbFixture(); const at=new Date().toISOString();
  const original=sql.prepare("SELECT value FROM terminal_settings WHERE key='model'").get().value;
  const response=await automation.executeJob(env,async r=>{
    assert.equal(new URL(r.url).pathname,'/api/refresh'); assert.equal(r.method,'POST');
    sql.prepare('INSERT INTO terminal_snapshots VALUES (?)').run(at);
    return Response.json({asOf:at});
  },'DAILY_REFRESH','CONTROLLED_TEST');
  const run=await response.json(); assert.equal(run.status,'SUCCESS'); assert.equal(run.snapshotAdvanced,true);
  assert.equal(sql.prepare("SELECT value FROM terminal_settings WHERE key='model'").get().value,original);
  const health=await (await automation.healthResponse(env,async()=>Response.json({model:{version:'ML-H 1.2',trainedAt:null,trainingSamples:0,validation:null}}))).json();
  assert.equal(health.dailyScheduler.status,'NOT ACTIVE'); assert.equal(health.lastSuccessfulDailyRefresh.id,run.id);
});
test('waiting training keeps model untouched and completes only its scheduled period',async()=>{
  const {env,sql}=dbFixture();let count=0; const before=sql.prepare("SELECT value FROM terminal_settings WHERE key='model'").get().value;
  const invoke=async r=>{count++;assert.equal(new URL(r.url).pathname,'/api/retrain');return Response.json({status:'waiting',samples:0,validation:'walk-forward'});};
  const options={cron:policy.AUTOMATION_CRONS[1],scheduledTime:Date.parse('2026-09-05T20:00:00Z')};
  const first=await (await automation.executeJob(env,invoke,'WEEKLY_RETRAIN','CLOUDFLARE_CRON',options)).json();
  const second=await (await automation.executeJob(env,invoke,'WEEKLY_RETRAIN','CLOUDFLARE_CRON',options)).json();
  assert.equal(first.status,'WAITING');assert.equal(first.modelStateChanged,false);assert.equal(second.status,'WAITING');assert.equal(count,1);
  assert.equal(sql.prepare("SELECT value FROM terminal_settings WHERE key='model'").get().value,before);
});
test('training success requires a persisted new model, not merely HTTP 200',async()=>{
  const {env,sql}=dbFixture();const at=new Date().toISOString();
  const noWrite=await (await automation.executeJob(env,async()=>Response.json({status:'trained',trainedAt:at}),'WEEKLY_RETRAIN','CONTROLLED_TEST')).json();
  assert.equal(noWrite.status,'FAILED');
  const write=await (await automation.executeJob(env,async()=>{
    sql.prepare("UPDATE terminal_settings SET value=? WHERE key='model'").run(JSON.stringify({trainedAt:at,trainingSamples:100,validation:{folds:3}}));
    return Response.json({status:'trained',trainedAt:at,samples:100});
  },'WEEKLY_RETRAIN','CONTROLLED_TEST')).json();
  assert.equal(write.status,'SUCCESS');assert.equal(write.modelStateChanged,true);
});
test('HTTP errors are durable failures and do not mark a period complete',async()=>{
  const {env,sql}=dbFixture();
  const response=await automation.executeJob(env,async()=>Response.json({reason:'source unavailable'},{status:503}),'DAILY_REFRESH','CONTROLLED_TEST');
  assert.equal(response.status,502);const run=await response.json();assert.equal(run.status,'FAILED');
  assert.match(run.message,/503/);assert.ok(sql.prepare('SELECT value FROM terminal_settings WHERE key=?').get(`automation:run:${run.id}`));
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM terminal_settings WHERE key GLOB 'automation:completed:*'").get().n,0);
});
test('lease blocks duplicate execution while a job is in flight',async()=>{
  const {env}=dbFixture();let release;const gate=new Promise(r=>release=r);let calls=0;
  const first=automation.executeJob(env,async()=>{calls++;await gate;return Response.json({status:'waiting',samples:0});},'WEEKLY_RETRAIN','CONTROLLED_TEST');
  await new Promise(r=>setTimeout(r,20));
  const second=await automation.executeJob(env,async()=>{calls++;return Response.json({});},'DAILY_REFRESH','CONTROLLED_TEST');
  assert.equal(second.status,409);release();await first;assert.equal(calls,1);
});
test('machine requests require the secret and valid event; manual endpoint response stays identical',async()=>{
  const {env}=dbFixture();let calls=0;const invoke=async()=>{calls++;return Response.json({status:'waiting',samples:0,minimum:60});};
  assert.equal((await automation.automationRequest(request({type:'WEEKLY_RETRAIN',source:'CONTROLLED_TEST'},'wrong'),env,invoke)).status,401);
  assert.equal((await automation.automationRequest(request({type:'WEEKLY_RETRAIN',source:'CLOUDFLARE_CRON',scheduledTime:0,cron:'bad'}),env,invoke)).status,400);
  assert.equal(calls,0);
  const original=request({}); const response=await automation.executeJob(env,invoke,'WEEKLY_RETRAIN','MANUAL',{request:original});
  assert.deepEqual(await response.json(),{status:'waiting',samples:0,minimum:60});assert.equal(calls,1);
});
test('manual exception never invokes its endpoint twice',async()=>{
  const {env}=dbFixture();let calls=0;
  const response=await automation.executeJob(env,async()=>{calls++;throw new Error('failed');},'WEEKLY_RETRAIN','MANUAL',{request:request({})});
  assert.equal(calls,1);assert.equal(response.status,503);
});
test('relay authenticates to the fixed private site and preserves WAITING',async()=>{
  let calls=0;
  await scheduler.dispatch({cron:policy.AUTOMATION_CRONS[1],scheduledTime:Date.parse('2026-09-05T20:00:00Z')},
    {TERMINAL_ORIGIN:'https://fx-macro-terminal.hysnzz.chatgpt.site',SITES_API_TOKEN:'test-site-token',AUTOMATION_SECRET:'test-only'},'CONTROLLED_TEST',async(url,options)=>{
      calls++;assert.equal(url.pathname,'/api/automation/run');assert.equal(options.headers['OAI-Sites-Authorization'],'Bearer test-site-token');
      assert.equal(JSON.parse(options.body).source,'CONTROLLED_TEST');return Response.json({status:'WAITING',id:'test',message:'insufficient samples'});
    });
  assert.equal(calls,1);
});
