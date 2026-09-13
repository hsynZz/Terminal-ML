import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';
const vite=await createServer({configFile:false,appType:'custom',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});
after(()=>vite.close());
const e=await vite.ssrLoadModule('/lib/hypothesis/engine.ts');
const d=await vite.ssrLoadModule('/lib/terminal-data.ts');
const m=await vite.ssrLoadModule('/lib/model-engine.ts');
const store=await vite.ssrLoadModule('/worker/hypothesis-research.ts');
const safety=await vite.ssrLoadModule('/lib/hypothesis/safety.ts');
const now='2026-09-12T15:20:00.000Z';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
test('immutable pre-change baseline: scores evidence ML clouds and 56 pairs x four horizons',()=>{
  const p=d.getBaselinePayload();
  const output={scores:p.currencies.map(d.strengthScore),evidence:p.evidence,model:p.model,distribution:m.buildModelDistribution(p,d.currencies),forecasts:d.currencies.flatMap(a=>d.currencies.filter(b=>a!==b).map(b=>m.buildPairForecast(p,a,b)))};
  const expected={scores:'66d9077bb7c4671c15fc70c1a90ed0e79fa53e40f8ae4f31cf4f10a8ae9038ff',evidence:'75cfb846784071f5f1454353c4860e381c8294f0d9b2c3ee9f092958cafae084',model:'ec8232c1127de675b2b3bc0a068ef6e4df6c1b791344e4b3a84d98b7ea9c011b',distribution:'cf0457c250e6657764ba03ba7167af79aa6185621f1ceb7e8b00afb1fa2daf93',forecasts:'25957818eeb8873ea23a1577be891ab5e63f3e01b17647ab853c26b716592867'};
  for(const [k,v]of Object.entries(output))assert.equal(hash(v),expected[k],k);
});
test('finite versioned factory and fail-closed feature flags',()=>{
  const h=e.factory(now);assert.equal(h.length,32);assert.equal(new Set(h.map(h=>h.id)).size,32);
  assert.ok(h.every(h=>h.status==='CANDIDATE'&&h.weight===0&&h.rationale&&h.definition));
  for(const v of ['NaN','Infinity','-1','0.06','1'])assert.equal(e.flags({HYPOTHESIS_PRODUCTION_WEIGHT:v}).requestedWeight,0);
  assert.equal(e.flags({HYPOTHESIS_ENGINE_ENABLED:'false'}).enabled,false);
  assert.equal(e.flags({}).effectiveWeight,0);
});
test('lag features never read future values or impute missing observations',()=>{
  const h=e.factory(now).find(h=>h.kind==='policy-change');
  const f={issuedAt:now,regime:'neutral',factors:{EUR:{policy:.8},USD:{policy:.2}}};
  const old={...f,issuedAt:'2026-08-13T15:20:00.000Z',factors:{EUR:{policy:.5},USD:{policy:.2}}};
  assert.equal(e.signalFor(h,f,[],'EUR'),null);
  assert.ok(Math.abs(e.signalFor(h,f,[old,{...old,issuedAt:'2099-01-01'}],'EUR')-.3)<1e-12);
  assert.equal(e.signalFor(h,{...f,factors:{EUR:{policy:NaN},USD:{policy:.2}}},[old],'EUR'),null);
});
function samples(n=120,good=true){return Array.from({length:n},(_,i)=>{
  const date=new Date(Date.UTC(2000,0,1+i*40)),end=new Date(+date+11*86400000);
  return {asOf:date.toISOString(),labelEnd:end.toISOString().slice(0,10),pair:'EUR/USD',probability:good?(i%2?.8:.2):(i%2?.2:.8),baseline:.5,label:i%2,regime:i%2?'risk-on':'risk-off'};
});}
test('purging and embargo group correlated FX currencies into one time block',()=>{
  const r=samples(10), doubled=r.flatMap(x=>[x,{...x,pair:'CAD/USD'}]);
  const b=e.independentBlocks(doubled,10);assert.equal(b.length,10);assert.equal(b[0].rows.length,2);
  assert.equal(e.independentBlocks([r[0],{...r[1],asOf:r[0].asOf}],10).length,1);
  for(let i=1;i<b.length;i++)assert.ok(Date.parse(b[i].asOf)>Date.parse(b[i-1].end)+10*86400000);
});
test('frozen temporal development training three walk-forward folds final OOS; negative ideas rejected',()=>{
  assert.equal(e.historicalTest(samples(20),10,'synthetic').status,'INSUFFICIENT_DATA');
  const good=e.historicalTest(samples(),10,'synthetic');assert.equal(good.status,'SHADOW');
  assert.equal(good.historical.folds.length,3);assert.ok(good.historical.training[1]<good.historical.validation[0]);assert.ok(good.historical.validation[1]<good.historical.outOfSample[0]);
  assert.deepEqual(e.historicalTest([...samples(),...samples(30,false).map(r=>({...r,asOf:r.asOf.replace('2000','2099'),labelEnd:r.labelEnd.replace('2000','2099')}))],10,'synthetic').historical,good.historical);
  assert.equal(e.historicalTest(samples(120,false),10,'synthetic').status,'REJECTED');
});
test('multiplicity includes all 32 candidates and all repeated looks, not only winners',()=>{
  let spent=0;for(let i=1;i<10000;i++)spent+=32*e.alphaFor(i);assert.ok(spent<.05);
  assert.ok(Math.abs(e.signP(20,20)-2**-20)<1e-12);assert.equal(e.signP(10,20),1);
  assert.ok(e.evaluate(e.independentBlocks(samples(),10),2).alpha<e.alphaFor(1));
});
test('historical records and same-day synthetic shadow can never masquerade as prospective evidence',()=>{
  const h={...e.factory(now)[0],shadowStartedAt:'2026-01-01T00:00:00Z'};
  const f={issuedAt:'2026-01-02T00:00:00Z',recordedAt:now,origin:'ARCHIVED_SNAPSHOT',sourceMode:'live',signals:[{id:h.id,pair:'EUR/USD',horizon:10,probability:.8,baseline:.5,regime:'neutral',phase:'SHADOW'}]};
  assert.deepEqual(e.outcomes(h,[f],[],now,'SHADOW'),[]);
});
test('kill switch and extreme redundant hypotheses cannot touch any core output',()=>{
  for(const core of [0,.1,.5,.9,1])for(const weight of [0,.005,.05,1,NaN])for(const enabled of [true,false]) {
    const result=e.contribution(core,Array(50).fill({...e.factory(now)[0],status:'PRODUCTION',weight:1,signal:Infinity}),enabled,weight);
    assert.equal(result.finalScore,core);assert.equal(result.totalWeight,0);
  }
});
function fixture(){
  const sql=new DatabaseSync(':memory:');sql.exec('CREATE TABLE terminal_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE terminal_snapshots(as_of TEXT,payload TEXT); CREATE TABLE currency_observations(currency TEXT,metric TEXT,source TEXT,period TEXT,value REAL); CREATE TABLE model_debug_logs(pair TEXT,horizon INTEGER,probability REAL,observed_at TEXT);');
  const p=d.getBaselinePayload();p.sourceMode='partial-live';p.asOf=now;
  sql.prepare('INSERT INTO terminal_snapshots VALUES (?,?)').run(now,JSON.stringify(p));sql.prepare('INSERT INTO terminal_settings VALUES (?,?,?)').run('model',JSON.stringify(p.model),now);
  const db={prepare(query){const s=sql.prepare(query);let values=[];return {bind(...v){values=v;return this},async first(){return s.get(...values)??null},async all(){return {results:s.all(...values)}},async run(){return {meta:{changes:Number(s.run(...values).changes)}}}}},batch:async function(stmts){sql.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};return {sql,env:{DB:db}};
}
test('real SQLite job persistence: candidates audit frames; no core writes; repeat idempotent',async()=>{
  const {sql,env}=fixture();const before=sql.prepare("SELECT * FROM terminal_settings WHERE key='model'").get(),snap=sql.prepare('SELECT * FROM terminal_snapshots').all();
  const run=await store.runResearch(env,'SYNTHETIC_TEST',now);assert.equal(run.status,'SUCCESS');assert.equal(run.candidates,32);assert.equal(run.result,'WAITING_FOR_DATA');
  const status=await store.researchStatus(env);assert.equal(status.counts.INSUFFICIENT_DATA,32);assert.equal(status.audit.length,1);
  assert.equal((await store.runResearch(env,'SYNTHETIC_TEST',now)).status,'ALREADY_EVALUATED');
  assert.deepEqual(sql.prepare("SELECT * FROM terminal_settings WHERE key='model'").get(),before);assert.deepEqual(sql.prepare('SELECT * FROM terminal_snapshots').all(),snap);
  assert.equal(sql.prepare("SELECT count(*) n FROM terminal_settings WHERE key LIKE 'hypothesis:v1:frame:%'").get().n,1);
  assert.equal((await store.runResearch({...env,HYPOTHESIS_ENGINE_ENABLED:'false'},'SYNTHETIC_TEST',now)).status,'DISABLED');
});
test('job storage failure fails closed and cannot mutate the saved model',async()=>{
  const {sql,env}=fixture();const before=sql.prepare("SELECT value FROM terminal_settings WHERE key='model'").get();sql.exec('DROP TABLE currency_observations');
  const run=await store.runResearch(env,'SYNTHETIC_TEST',now);assert.equal(run.status,'FAILED');assert.equal(run.productionContribution,0);assert.deepEqual(sql.prepare("SELECT value FROM terminal_settings WHERE key='model'").get(),before);
});
test('legacy snapshots without regime or archived forecasts are excluded without killing research',async()=>{
  const {sql,env}=fixture();const legacy=d.getBaselinePayload();legacy.sourceMode='partial-live';legacy.asOf='2026-09-04T15:20:00.000Z';delete legacy.regime;
  sql.prepare('INSERT INTO terminal_snapshots VALUES (?,?)').run(legacy.asOf,JSON.stringify(legacy));
  const another=d.getBaselinePayload();another.sourceMode='partial-live';another.asOf='2026-09-05T15:20:00.000Z';
  sql.prepare('INSERT INTO terminal_snapshots VALUES (?,?)').run(another.asOf,JSON.stringify(another));
  const result=await store.runResearch(env,'SYNTHETIC_TEST',now);assert.equal(result.status,'SUCCESS');
  const status=await store.researchStatus(env);assert.deepEqual(status.dataQuality.importExcluded,{incompatibleSnapshot:1,missingArchivedForecasts:1});
  assert.equal(status.counts.INSUFFICIENT_DATA,32);assert.equal(status.dataQuality.prospectiveCaptures,1);
});
test('research never imports into model/scoring and automation retains existing handlers',()=>{
  for(const path of ['lib/model-engine.ts','lib/terminal-data.ts','lib/retraining.ts','app/api/forecast/route.ts'])assert.doesNotMatch(readFileSync(path,'utf8'),/hypothesis/);
  assert.match(readFileSync('worker/index.ts','utf8'),/queueResearch/);
});
test('isolated future allocation: caps, redundancy, regime, stale data, edge decay and slow growth',()=>{
  const evidence={id:'a',family:'yields',regime:'all',signal:1,weight:0,evaluatedAt:now,historicalPassed:true,shadowPassed:true,pointInTimeVerified:true,blocks:40,previousBlocks:30,meanImprovement:.02,logLossImprovement:.03,stability:.8,calibrationDegraded:false,recentSignals:Array.from({length:40},(_,i)=>Math.sin(i))};
  assert.equal(safety.nextWeight(evidence,now).weight,.005);
  assert.equal(safety.nextWeight({...evidence,weight:.005},now).weight,.006);
  assert.equal(safety.nextWeight({...evidence,weight:.005,meanImprovement:0},now).weight,0);
  assert.equal(safety.nextWeight({...evidence,weight:.005,stability:.4},now).weight,.0025);
  assert.equal(safety.nextWeight({...evidence,evaluatedAt:'2020-01-01'},now).weight,0);
  assert.equal(safety.nextWeight({...evidence,pointInTimeVerified:false},now).weight,0);
  const dup=safety.boundedProposal(.8,[evidence,{...evidence,id:'b'}],.05,'neutral',now);assert.equal(dup.contributions.length,1);
  assert.equal(safety.boundedProposal(.8,[{...evidence,regime:'risk-off'}],.05,'risk-on',now).totalWeight,0);
  const many=Array.from({length:20},(_,j)=>({...evidence,id:String(j).padStart(2,'0'),family:String(j),weight:.01,recentSignals:Array.from({length:64},(_,i)=>Math.cos(2*Math.PI*(j+1)*i/64))}));
  const r=safety.boundedProposal(.1,many,.05,'neutral',now);assert.ok(r.totalWeight<=.05);assert.ok(Math.abs(r.hypothesisAdjustment)<=.025);assert.ok(r.contributions.length>1);
  assert.equal(safety.boundedProposal(.8,[{...evidence,signal:Infinity}],.05,'neutral',now).totalWeight,0);
});
