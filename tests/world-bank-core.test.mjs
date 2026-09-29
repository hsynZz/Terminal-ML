import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'vite';

const vite=await createServer({configFile:false,appType:'custom',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});
after(()=>vite.close());
const wb=await vite.ssrLoadModule('/lib/world-bank-core.ts');
const ingest=await vite.ssrLoadModule('/lib/production-data.ts');
const data=await vite.ssrLoadModule('/lib/terminal-data.ts');
const model=await vite.ssrLoadModule('/lib/model-engine.ts');
const runtime=await vite.ssrLoadModule('/worker/production.ts');
const at='2026-09-29T19:00:00.000Z';
const row=(currency='USD',metric='inflation',value=2.9,date='2025')=>({indicator:{id:wb.worldBankIndicators[metric]},countryiso3code:wb.worldBankCountries[currency],date,value,unit:'',obs_status:''});
const body=(rows)=>[{page:1,pages:1,per_page:100,total:rows.length,sourceid:'2',lastupdated:'2026-07-13'},rows];
const fixture=metric=>body(data.currencies.flatMap((c,i)=>[row(c,metric,i+1),row(c,metric,i+2,'2024')]));

test('WDI batching retains the exact five series and eight countries without gapfill',()=>{
  assert.deepEqual(wb.worldBankIndicators,{inflation:'FP.CPI.TOTL.ZG',growth:'NY.GDP.MKTP.KD.ZG',unemployment:'SL.UEM.TOTL.ZS',currentAccount:'BN.CAB.XOKA.GD.ZS',debt:'GC.DOD.TOTL.GD.ZS'});
  for(const metric of Object.keys(wb.worldBankIndicators)){
    const url=new URL(wb.worldBankCoreUrl(metric));assert.equal(url.hostname,'api.worldbank.org');
    assert.equal(url.searchParams.get('source'),'2');assert.equal(url.searchParams.get('mrv'),'8');assert.equal(url.searchParams.get('per_page'),'100');
    assert.equal(url.searchParams.get('gapfill'),null);assert.equal(url.searchParams.get('mrnev'),null);
    assert.ok(Object.values(wb.worldBankCountries).every(c=>url.pathname.includes(c)));
    for(const [i,currency] of data.currencies.entries()){
      const r=wb.parseWorldBankCore(fixture(metric),metric,currency,at);
      assert.equal(r.value,i+1);assert.equal(r.currency,currency);assert.equal(r.metric,metric);assert.equal(r.period,'2025');
      assert.equal(r.frequency,'annual');assert.equal(r.receivedAt,at);assert.equal(r.releaseDate,null);assert.equal(r.quality,'VALID');
      assert.ok(r.sourceUrl.includes(`/country/${wb.worldBankCountries[currency]}/`));
      assert.equal(r.unit,metric==='debt'||metric==='currentAccount'?'percent of GDP':metric==='unemployment'?'percent of total labor force':'annual percent');
    }
  }
});
test('WDI country omissions never borrow another country; zero is real, null is missing',()=>{
  assert.equal(wb.parseWorldBankCore(body([row('CAD')]),'inflation','USD',at),null);
  assert.equal(wb.parseWorldBankCore(body([row('USD','inflation',null)]),'inflation','USD',at),null);
  assert.equal(wb.parseWorldBankCore(body([row('USD','inflation',0)]),'inflation','USD',at).value,0);
  assert.equal(wb.parseWorldBankCore(body([row('USD','currentAccount',-2)]),'currentAccount','USD',at).value,-2);
});
test('WDI schema, pages, source, indicator, units and malformed values fail closed',()=>{
  const valid=body([row()]);
  for(const b of [null,{},[{message:[{id:'120'}]}], [{...valid[0],pages:2},valid[1]], [{...valid[0],total:2},valid[1]], [{...valid[0],sourceid:'6'},valid[1]],body([row('USD','growth')]),body([{...row(),unit:'USD'}]),body([{...row(),value:'2.9'}]),body([{...row(),value:Infinity}]),body([{...row(),date:'2025-01-01'}]),body([row('USD','inflation',1001)])])assert.throws(()=>wb.parseWorldBankCore(b,'inflation','USD',at),/INVALID_RESPONSE/);
  assert.throws(()=>wb.parseWorldBankCore(valid,'inflation','USD','unknown'),/INVALID_RESPONSE/);
});
test('WDI observation year, source update and actual receipt are distinct; future, unfinished, stale and flagged years cannot certify FRESH',()=>{
  const rows=[row('USD','inflation',99,'2027'),row('USD','inflation',98,'2026'),{...row('USD','inflation',97),obs_status:'F'},row('USD','inflation',2,'2024')];
  const r=wb.parseWorldBankCore(body(rows),'inflation','USD',at);assert.equal(r.period,'2024');assert.equal(r.value,2);assert.equal(r.releaseDate,null);
  assert.equal(wb.parseWorldBankCore(body(rows.slice(0,3)),'inflation','USD',at),null);
  assert.throws(()=>wb.parseWorldBankCore(body([row('USD','debt',55,'2022')]),'debt','USD',at),/INVALID_RESPONSE/);
});
test('WDI response order and identical duplicates are harmless; conflicting revisions in one response are rejected',()=>{
  const r=wb.parseWorldBankCore(body([row('USD','inflation',1,'2024'),row(),row()]),'inflation','USD',at);
  assert.equal(r.period,'2025');assert.equal(r.value,2.9);
  assert.throws(()=>wb.parseWorldBankCore(body([row(),row('USD','inflation',3)]),'inflation','USD',at),/INVALID_RESPONSE/);
});
test('WDI collection makes five requests, at most five in flight, but retains forty per-input source checks',async(t)=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let calls=0,active=0,peak=0;
  globalThis.fetch=async url=>{
    calls++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;
    const id=new URL(url).pathname.split('/').at(-1);const metric=Object.keys(wb.worldBankIndicators).find(m=>wb.worldBankIndicators[m]===id);
    return Response.json(fixture(metric));
  };
  const checks=[];const rows=await wb.collectWorldBankCore(checks);
  assert.equal(calls,5);assert.equal(peak,5);assert.equal(rows.length,40);assert.equal(checks.length,40);
  assert.ok(checks.every(c=>c.status==='SUCCESS'));assert.equal(new Set(checks.map(c=>`${c.currency}:${c.metrics[0]}`)).size,40);
});
test('WDI batch HTTP/timeout/schema failure stays visible for all eight affected inputs without false success or stale substitution',async(t)=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const [fetcher,cause] of [[async()=>new Response('',{status:403}),'HTTP_403'],[async()=>{throw new DOMException('deadline','TimeoutError');},'TIMEOUT'],[async()=>Response.json({error:'bad schema'}),'INVALID_RESPONSE'],[async()=>Response.json(body([])),'NO_VALID_OBSERVATIONS']]){
    globalThis.fetch=fetcher;const checks=[];
    assert.deepEqual(await wb.collectWorldBankCore(checks),[]);assert.equal(checks.length,40);
    assert.ok(checks.every(c=>c.status==='FAILED'&&c.cause===cause));
  }
});
test('WDI transient timeout retries once per batch, not per country; access denial is never retried',async(t)=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});const calls=new Map();
  globalThis.fetch=async url=>{
    calls.set(url,(calls.get(url)??0)+1);
    if(calls.get(url)===1)throw new DOMException('deadline','TimeoutError');
    const id=new URL(url).pathname.split('/').at(-1);const metric=Object.keys(wb.worldBankIndicators).find(m=>wb.worldBankIndicators[m]===id);
    return Response.json(fixture(metric));
  };
  const checks=[];assert.equal((await wb.collectWorldBankCore(checks)).length,40);
  assert.equal(calls.size,5);assert.ok([...calls.values()].every(n=>n===2));assert.ok(checks.every(c=>c.status==='SUCCESS'));
  let denied=0;globalThis.fetch=async()=>{denied++;return new Response('',{status:403});};
  assert.deepEqual(await wb.collectWorldBankCore([]),[]);assert.equal(denied,5);
});
test('WDI batching preserves raw values, Core formulas, all pair forecasts and dominance for identical source inputs',()=>{
  const prior=data.getBaselinePayload(),next=data.getBaselinePayload();prior.asOf=at;next.asOf=at;
  for(const metric of Object.keys(wb.worldBankIndicators))for(const currency of data.currencies){
    const raw=fixture(metric)[1].filter(r=>r.countryiso3code===wb.worldBankCountries[currency]);
    prior.currencies.find(c=>c.code===currency)[metric]=raw.find(r=>typeof r.value==='number').value;
    next.currencies.find(c=>c.code===currency)[metric]=wb.parseWorldBankCore(body(raw),metric,currency,at).value;
  }
  ingest.repairDerivedScores(prior);ingest.repairDerivedScores(next);assert.deepEqual(next,prior);
  for(const a of data.currencies)for(const b of data.currencies.filter(c=>c!==a))assert.deepEqual(model.buildPairForecast(next,a,b),model.buildPairForecast(prior,a,b));
  assert.deepEqual(model.buildModelDistribution(next,data.currencies),model.buildModelDistribution(prior,data.currencies));
  const receipts=Object.keys(wb.worldBankIndicators).flatMap(m=>data.currencies.map(c=>wb.parseWorldBankCore(fixture(m),m,c,at)));
  ingest.truthfulEvidence(next,receipts);assert.equal(next.coreFactors.USD.growth.status,'OBSERVED');
  assert.equal(next.coreFactors.USD.risk.status,'PARTIAL_ANCHORED');assert.equal(next.coreFactors.USD.yields.status,'LEGACY_OR_CARRIED');
  ingest.truthfulEvidence(next,receipts.filter(r=>!(r.currency==='AUD'&&r.metric==='growth')));
  assert.notEqual(next.coreFactors.USD.growth.status,'OBSERVED');assert.notEqual(next.coreFactors.AUD.growth.status,'OBSERVED');
});
test('WDI later revisions append immutable vintages, repeated receipts deduplicate, and availability is not backdated',async()=>{
  const sql=new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE observation_vintages (id TEXT PRIMARY KEY,currency TEXT,metric TEXT,period TEXT,source TEXT,received_at TEXT,value REAL,payload TEXT)');
  const db={prepare(query){let args=[];return{bind(...a){args=a;return this;},async all(){return{results:sql.prepare(query).all(...args)};},async run(){return sql.prepare(query).run(...args);}};},async batch(rows){return Promise.all(rows.map(r=>r.run()));}};
  const later='2026-09-30T19:00:00.000Z';
  await runtime.archiveObservations(db,[wb.parseWorldBankCore(body([row()]),'inflation','USD',at)],at);
  await runtime.archiveObservations(db,[wb.parseWorldBankCore(body([row()]),'inflation','USD',later)],later);
  assert.equal(sql.prepare('SELECT count(*) AS n FROM observation_vintages').get().n,1);
  await runtime.archiveObservations(db,[wb.parseWorldBankCore(body([row('USD','inflation',3)]),'inflation','USD',later)],later);
  const stored=sql.prepare('SELECT payload FROM observation_vintages ORDER BY received_at').all().map(r=>JSON.parse(r.payload));
  assert.equal(stored.length,2);assert.equal(stored[0].receivedAt,at);assert.equal(stored[1].receivedAt,later);
  assert.equal(stored[0].releaseDate,null);assert.notEqual(stored[0].contentHash,stored[1].contentHash);sql.close();
});
