import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'vite';

const vite=await createServer({configFile:false,appType:'custom',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});
after(()=>vite.close());
const source=await vite.ssrLoadModule('/lib/source-expansion.ts');
const ingest=await vite.ssrLoadModule('/lib/production-data.ts');
const data=await vite.ssrLoadModule('/lib/terminal-data.ts');
const runtime=await vite.ssrLoadModule('/worker/production.ts');
const at='2026-09-29T15:00:00.000Z';
const csv='DATE,IUDMNPY\r\n24 Sep 2026,5.3438\r\n25 Sep 2026,5.3321\r\n';

test('BoE official CSV fixes GBP, 10Y, nominal par, percent and daily frequency without inventing 2Y',()=>{
  const rows=source.parseBritishTenYearYield(csv,at);
  assert.equal(rows.length,1);
  const r=rows[0];assert.equal(r.currency,'GBP');assert.equal(r.metric,'yield10y');assert.equal(r.value,5.3321);
  assert.equal(r.period,'2026-09-25');assert.equal(r.receivedAt,at);assert.equal(r.releaseDate,null);
  assert.equal(r.unit,'percent per annum');assert.equal(r.frequency,'business-daily');assert.equal(r.quality,'VALID');
  assert.deepEqual(r.lineage,['BoE:IUDMNPY']);assert.equal(r.normalizedValue,null);
  const url=new URL(r.sourceUrl);assert.equal(url.hostname,'www.bankofengland.co.uk');assert.equal(url.searchParams.get('SeriesCodes'),'IUDMNPY');
  assert.equal(url.searchParams.get('Datefrom'),'15/Aug/2026');assert.equal(url.searchParams.get('CSVF'),'TN');
  for(const wrong of ['IUDMNZC','IUMMNPY','IUDSNPY','DGS10'])assert.throws(()=>source.parseBritishTenYearYield(csv.replace('IUDMNPY',wrong),at),/INVALID_RESPONSE/);
  assert.throws(()=>source.parseBritishTenYearYield('<html>provider error</html>',at),/INVALID_RESPONSE/);
});
test('BoE missing/stale/malformed/future observations cannot certify a fresh yield',()=>{
  for(const value of ['', '..','n/a','NaN','Infinity','0x10','999'])assert.deepEqual(source.parseBritishTenYearYield(`DATE,IUDMNPY\n25 Sep 2026,${value}`,at),[]);
  for(const date of ['30 Feb 2026','1 Foo 2026','30 Sep 2026','25 Sep 2020'])assert.deepEqual(source.parseBritishTenYearYield(`DATE,IUDMNPY\n${date},5`,at),[]);
  assert.deepEqual(source.parseBritishTenYearYield(csv+'30 Sep 2026,99\n',at),source.parseBritishTenYearYield(csv,at));
  assert.equal(source.parseBritishTenYearYield('DATE,IUDMNPY\n25 Sep 2026,0',at)[0].value,0);
  assert.equal(source.parseBritishTenYearYield('DATE,IUDMNPY\n25 Sep 2026,-.1',at)[0].value,-.1);
  assert.deepEqual(source.parseBritishTenYearYield(csv,'2026-10-06T15:00:00.000Z'),[]);
});
test('BoE duplicate dates are deduplicated but conflicting same-response revisions fail closed',()=>{
  assert.deepEqual(source.parseBritishTenYearYield(csv+'25 Sep 2026,5.3321\n',at),source.parseBritishTenYearYield(csv,at));
  assert.throws(()=>source.parseBritishTenYearYield(csv+'25 Sep 2026,5.4\n',at),/INVALID_RESPONSE/);
});
test('GBP 10Y alone cannot certify the missing 2Y or any incomplete cross-sectional yield factor',()=>{
  const p=data.getBaselinePayload();p.asOf=at;
  const rows=source.parseBritishTenYearYield(csv,at);ingest.truthfulEvidence(p,rows);
  assert.equal(p.coreFactors.GBP.yields.status,'LEGACY_OR_CARRIED');
  assert.equal(p.coreFactors.GBP.yields.inputs.length,1);assert.equal(p.sourceCoverage.critical.fresh,0);
  const other=data.currencies.filter(c=>c!=='GBP').flatMap(currency=>['yield2y','yield10y'].map(metric=>({...rows[0],currency,metric})));
  ingest.truthfulEvidence(p,[...rows,...other]);assert.equal(p.sourceCoverage.critical.fresh,0);
  assert.equal(p.coreFactors.CAD.yields.status,'PARTIAL_CROSS_SECTION');
});
test('BoE collection records HTTP/schema/missing failures and never substitutes another yield',async(t)=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const [body,status,cause] of [['',403,'HTTP_403'],['DATE,IUDMNZC\n25 Sep 2026,5',200,'INVALID_RESPONSE'],['DATE,IUDMNPY\n25 Sep 2000,5',200,'NO_VALID_OBSERVATIONS']]){
    globalThis.fetch=async()=>new Response(body,{status});const checks=[];
    assert.deepEqual(await source.collectBritishTenYearYield(checks),[]);assert.equal(checks[0].cause,cause);
    assert.equal(checks[0].currency,'GBP');assert.deepEqual(checks[0].metrics,['yield10y']);assert.equal(checks[0].status,'FAILED');
  }
  const today=new Date().toISOString().slice(0,10);globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).searchParams.get('SeriesCodes'),'IUDMNPY');assert.equal(options.headers.Accept,'text/csv');
    return new Response(`DATE,IUDMNPY\n${today},5.3321`);
  };
  const checks=[];const rows=await source.collectBritishTenYearYield(checks);assert.equal(rows.length,1);assert.equal(checks[0].status,'SUCCESS');
});
test('BoE revisions retain first receipt, do not duplicate retrievals and never backdate availability',async()=>{
  const sql=new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE observation_vintages (id TEXT PRIMARY KEY,currency TEXT,metric TEXT,period TEXT,source TEXT,received_at TEXT,value REAL,payload TEXT)');
  const db={prepare(query){let args=[];return {bind(...a){args=a;return this;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){return sql.prepare(query).run(...args);}};},async batch(rows){return Promise.all(rows.map(r=>r.run()));}};
  const first=source.parseBritishTenYearYield(csv,at),later='2026-09-30T15:00:00.000Z';
  await runtime.archiveObservations(db,first,at);
  await runtime.archiveObservations(db,source.parseBritishTenYearYield(csv,later),later);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM observation_vintages').get().n,1);
  const changed=source.parseBritishTenYearYield(csv.replace('5.3321','5.3322'),later);
  await runtime.archiveObservations(db,changed,later);
  const stored=sql.prepare('SELECT payload FROM observation_vintages ORDER BY received_at').all().map(r=>JSON.parse(r.payload));
  assert.equal(stored.length,2);assert.equal(stored[0].receivedAt,at);assert.equal(stored[1].receivedAt,later);
  assert.equal(stored[0].period,stored[1].period);assert.equal(stored[0].releaseDate,null);assert.notEqual(stored[0].contentHash,stored[1].contentHash);
  await runtime.archiveObservations(db,changed,at);assert.equal(sql.prepare('SELECT count(*) AS n FROM observation_vintages').get().n,2);
  sql.close();
});
