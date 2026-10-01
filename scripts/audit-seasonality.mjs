// Full local audit with real official data only. No production connection or writes.
// node scripts/audit-seasonality.mjs <ECB XML> <Fed ZIP> <output JSON>
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'vite';

const [ecbPath,fedPath,output]=process.argv.slice(2);
assert.ok(ecbPath&&fedPath&&output,'Provide the downloaded ECB XML, Fed ZIP and output path');
const independent=JSON.parse(execFileSync('python',['scripts/audit-seasonality.py',ecbPath,fedPath],{encoding:'utf8'}));
assert.equal(independent.fedMismatches.length,0,'FRED and Fed observations must agree');
const vite=await createServer({configFile:false,appType:'custom',server:{middlewareMode:true,hmr:false}});
const sql=new DatabaseSync(':memory:');
try{
  const d=await vite.ssrLoadModule('/lib/seasonality-data.ts'),e=await vite.ssrLoadModule('/lib/seasonality-engine.ts'),w=await vite.ssrLoadModule('/worker/seasonality.ts');
  const csv=readFileSync('public/data/seasonality/h10-bootstrap.csv','utf8'),parsed=d.parseFxCsv(csv,'2026-10-01');
  await w.confirmLargeMoves(parsed.rows,async()=>{throw new Error('Audit never confirms from unavailable network');});
  assert.equal(parsed.rows.filter(r=>r.quality==='REVIEW_REQUIRED').length,0);
  let maxEngineError=0;
  for(const check of independent.checks){
    const points=d.derivePair(parsed.rows,check.pair,'2026-10-01'),actual=e.windowResult(points,check.year,check.start,check.end).result;
    assert.ok(actual);assert.equal(actual.startDate,check.startDate);assert.equal(actual.endDate,check.endDate);
    for(const key of ['startPrice','endPrice','return','mfe','mae']){
      const delta=Math.abs(actual[key]-check[key]);maxEngineError=Math.max(maxEngineError,delta);assert.ok(delta<1e-11,`${check.pair} ${check.year} ${key}`);
    }
  }
  for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+file,'utf8'));
  const db={prepare(query){const statement=sql.prepare(query);let params=[];return {bind(...p){params=p;return this;},async first(){return statement.get(...params)??null;},async all(){return {results:statement.all(...params)};},async run(){return {meta:{changes:Number(statement.run(...params).changes)}};}};},async batch(statements){sql.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  const at=new Date().toISOString(),begin=performance.now();
  const run=await w.syncSeasonality({DB:db},'LOCAL_REAL_DATA_AUDIT',at,async()=>new Response(csv));
  assert.equal(run.status,'SUCCESS');const importMs=performance.now()-begin;
  const count=()=>sql.prepare('SELECT COUNT(*) n FROM seasonality_fx_rates').get().n;
  assert.equal(count(),90788);await w.persistFxRows(db,parsed.rows,new Date(Date.parse(at)+1000).toISOString());assert.equal(count(),90788);
  const qbegin=performance.now();
  const response=await w.seasonalityApi(new Request('https://example.test/api/seasonality/stats?pair=AUDCAD&asOf=2026-10-01&lookback=20&start=10-03&end=10-27'),{DB:db},{waitUntil(){throw new Error('Unexpected network work');}});
  assert.equal(response.status,200);const body=await response.json(),queryMs=performance.now()-qbegin;assert.equal(body.analysis.stats.sample,20);
  const coreTables=['terminal_snapshots','currency_observations','observation_vintages','evidence_entries','production_records','terminal_settings'];
  for(const table of coreTables)assert.equal(sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  const pairCoverage=d.FX_PAIRS.map(pair=>{const points=d.derivePair(parsed.rows,pair,'2026-10-01'),a=e.analyzeSeasonality(points,{asOf:'2026-10-01',lookback:'MAX',start:'10-03',end:'10-27'});return {pair,firstDate:points[0]?.date,lastDate:points.at(-1)?.date,fixings:points.length,completedSample:a.stats.sample,excluded:a.excluded};});
  const report={auditedAt:at,scope:'LOCAL_REAL_DATA_VALIDATION; not production Cron proof',
    sources:{fred:JSON.parse(readFileSync('public/data/seasonality/h10-bootstrap-source.json','utf8')),fed:JSON.parse(readFileSync(fedPath+'.receipt.json','utf8')),ecb:JSON.parse(readFileSync(ecbPath+'.receipt.json','utf8'))},
    ...independent,maxEngineError,fixingCaveat:'ECB reference rates and Fed New York noon fixings have different fixing times; prices and returns are not expected to match exactly. The ECB series is an independent orientation/scale spotcheck, not replacement data.',
    localPersistence:{vintages:count(),idempotent:true,untouchedCoreTables:coreTables,importMs,statsQueryMs:queryMs},
    referenceAnalysis:{pair:'AUDCAD',asOf:'2026-10-01',lookback:20,window:'10-03/10-27',stats:body.analysis.stats},pairCoverage};
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({output,observations:count(),pairs:pairCoverage.length,independentWindows:independent.checks.length,maxEngineError,ecbReturnDifferenceBps:[Math.min(...independent.checks.map(x=>x.returnDifferenceBps)),Math.max(...independent.checks.map(x=>x.returnDifferenceBps))],importMs,queryMs}));
}finally{sql.close();await vite.close();}
