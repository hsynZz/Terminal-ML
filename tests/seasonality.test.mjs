import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,appType:'custom',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});after(()=>vite.close());
const d=await vite.ssrLoadModule('/lib/seasonality-data.ts'),e=await vite.ssrLoadModule('/lib/seasonality-engine.ts'),w=await vite.ssrLoadModule('/worker/seasonality.ts');
const near=(a,b,tolerance=1e-11)=>assert.ok(Math.abs(a-b)<tolerance,`${a} != ${b}`);
const p=(date,close,quality='VALID')=>({date,close,quality,baseUsd:close,quoteUsd:1});
const header='observation_date,DEXUSEU,DEXUSUK,DEXUSAL,DEXUSNZ,DEXJPUS,DEXSZUS,DEXCAUS';
const csv=rows=>header+'\n'+rows.join('\n');
function fullHistory(first=1999,last=2026){const out=[];for(let y=first;y<=last;y++)for(let n=0;n<366;n++){const date=new Date(Date.UTC(y,0,n+1));if(date.getUTCFullYear()!==y)break;if([0,6].includes(date.getUTCDay()))continue;out.push(p(date.toISOString().slice(0,10),1+(y-first)*.013+n*.00025+Math.sin(n*.2+y)*.002));}return out;}
function sqlite(){const sql=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+file,'utf8'));return {sql,db:{prepare(query){const statement=sql.prepare(query);let params=[];return {bind(...values){params=values;return this},async first(){return statement.get(...params)??null},async all(){return {results:statement.all(...params)}},async run(){return {meta:{changes:Number(statement.run(...params).changes)}}}}},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}}};}
test('canonical normalization checks all seven Fed quote conventions and inversions',()=>{
  for(const s of d.FX_SERIES){const r=d.normalizeQuote(2,s.base,s.quote);near(r,s.quote==='USD'?2:.5);}
  for(const value of [0,-1,NaN,Infinity])assert.throws(()=>d.normalizeQuote(value,'EUR','USD'));
  assert.throws(()=>d.normalizeQuote(1,'EUR','EUR'));assert.throws(()=>d.normalizeQuote(1,'EUR','JPY'));
});
test('all 56 oriented pairs, inversions and triangle identities use the same fixing date',()=>{
  const usd={USD:1,EUR:1.1,GBP:1.25,AUD:.65,NZD:.6,JPY:1/150,CHF:1/.9,CAD:1/1.35};
  const rows=d.FX_SERIES.map(s=>({date:'2025-10-03',currency:s.currency,usdPerUnit:usd[s.currency],raw:s.quote==='USD'?usd[s.currency]:1/usd[s.currency],quality:'VALID'}));
  for(const pair of d.FX_PAIRS){const [base,quote]=d.pairCurrencies(pair),value=d.derivePair(rows,pair,'2025-10-03')[0].close;near(value,usd[base]/usd[quote]);near(value*d.derivePair(rows,quote+base,'2025-10-03')[0].close,1);}
  near(d.derivePair(rows,'AUDCAD','2025-10-03')[0].close,.65*1.35);near(d.derivePair(rows,'GBPCAD','2025-10-03')[0].close,1.25*1.35);near(d.derivePair(rows,'EURJPY','2025-10-03')[0].close,1.1*150);
});
test('crosses never join different dates or forward-fill a missing leg',()=>{
  const rows=[{date:'2025-10-03',currency:'AUD',usdPerUnit:.7,quality:'VALID'},{date:'2025-10-06',currency:'CAD',usdPerUnit:.75,quality:'VALID'}];assert.deepEqual(d.derivePair(rows,'AUDCAD','2025-10-06'),[]);assert.throws(()=>d.derivePair([...rows,rows[0]],'AUDCAD','2025-10-06'));assert.throws(()=>d.pairCurrencies('USDUSD'));assert.throws(()=>d.pairCurrencies('USDETH'));
});
test('parser rejects schema drift, invalid dates and conflicting duplicates; equal duplicates collapse',()=>{
  const row='2025-10-03,1.1,1.3,.7,.6,150,.9,1.3'.replace(',.7',',0.7').replace(',.6',',0.6').replace(',.9',',0.9');
  const parsed=d.parseFxCsv(csv([row,row]),'2025-10-03');assert.equal(parsed.rows.length,7);assert.equal(parsed.duplicates,1);
  assert.throws(()=>d.parseFxCsv(csv([row,row.replace('1.1','1.2')]),'2025-10-03'));
  assert.throws(()=>d.parseFxCsv(csv([row.replace('2025-10-03','2025-02-29')]),'2025-10-03'));assert.throws(()=>d.parseFxCsv('DATE,WRONG\n2025-10-03,1','2025-10-03'));
});
test('invalid, zero, negative, missing, future and weekend source values are never prices',()=>{
  const parsed=d.parseFxCsv(csv(['2025-10-03,0,-1,.,,NaN,0.9,1.3','2025-10-06,1.1,1.3,0.7,0.6,150,0.9,1.3','2025-10-04,1.1,1.3,0.7,0.6,150,0.9,1.3']),'2025-10-04');
  assert.equal(parsed.rows.length,2);assert.ok(parsed.rows.every(r=>r.date==='2025-10-03'));assert.equal(parsed.missing.DEXUSAL,1);assert.ok(parsed.issues.some(i=>i.reason==='FUTURE_DATE'));
});
test('large jumps are quarantined; new incremental range boundary still checks its prior observation',()=>{
  const row='2025-10-03,1.1,1.3,0.7,0.6,150,0.9,1.3';
  const parsed=d.parseFxCsv(csv([row]),'2025-10-03',[{date:'2025-10-02',currency:'AUD',raw:.5,usdPerUnit:.5,quality:'VALID'}]);assert.equal(parsed.rows.find(x=>x.currency==='AUD').quality,'REVIEW_REQUIRED');
});
test('large move confirmation requires exact official value and retains failed confirmations',async()=>{
  const rows=[{date:'2015-01-15',currency:'CHF',raw:.893,usdPerUnit:1/.893,quality:'REVIEW_REQUIRED'},{date:'2015-01-16',currency:'CHF',raw:.8,usdPerUnit:1/.8,quality:'REVIEW_REQUIRED'}];
  await w.confirmLargeMoves(rows,async()=>new Response('<tr><td>15-JAN-15</td><td>0.8930</td></tr><tr><td>16-JAN-15</td><td>0.9000</td></tr>'));
  assert.equal(rows[0].quality,'VERIFIED_LARGE_MOVE');assert.equal(rows[1].quality,'REVIEW_REQUIRED');assert.match(rows[0].verification,/federalreserve.gov/);
});
test('downloaded Fed archive confirms known historical jumps, never a revised or unmatched value',async()=>{
  const rows=[{date:'1974-09-25',currency:'AUD',raw:1.3075,usdPerUnit:1.3075,quality:'REVIEW_REQUIRED'},{date:'1974-09-25',currency:'AUD',raw:1.4,usdPerUnit:1.4,quality:'REVIEW_REQUIRED'}];
  await w.confirmLargeMoves(rows,async()=>{throw new Error('Offline');});assert.equal(rows[0].quality,'VERIFIED_LARGE_MOVE');assert.equal(rows[1].quality,'REVIEW_REQUIRED');assert.match(rows[0].verification,/sha256=/);
});
test('5Y, 10Y, 20Y contain exactly those completed calendar years; current year is excluded',()=>{
  const history=fullHistory();for(const n of [5,10,20]){const a=e.analyzeSeasonality(history,{asOf:'2026-10-01',lookback:n,start:'10-03',end:'10-27'});assert.equal(a.stats.sample,n);assert.deepEqual(a.years.map(x=>x.year),Array.from({length:n},(_,i)=>2026-n+i));assert.ok(a.years.every(y=>y.endYear<2026));}
});
test('historical cutoff is invariant to future rows and current-year outcome changes',()=>{
  const history=fullHistory(1999,2027),options={asOf:'2022-10-01',lookback:20,start:'10-03',end:'10-27'};
  const a=e.analyzeSeasonality(history,options),b=e.analyzeSeasonality(history.map(p=>p.date>'2022-10-01'?{...p,close:999999}:p),options);
  assert.deepEqual(a,b);assert.equal(a.years.at(-1).year,2021);
  const c=e.analyzeSeasonality(history.map(p=>p.date.startsWith('2022')?{...p,close:p.close*3}:p),options);assert.deepEqual(a.stats,c.stats);assert.ok(a.currentThrough<='2022-10-01');
});
test('historical custom years are exact and reject future, malformed or reversed ranges',()=>{
  const h=fullHistory(),o={asOf:'2026-10-01',lookback:20,start:'10-03',end:'10-27',fromYear:2001,toYear:2011};const a=e.analyzeSeasonality(h,o);assert.equal(a.stats.sample,11);assert.equal(a.years[0].year,2001);assert.equal(a.years.at(-1).year,2011);
  for(const extra of [{toYear:2026},{fromYear:2020,toYear:2000},{fromYear:NaN},{fromYear:1900}])assert.throws(()=>e.analyzeSeasonality(h,{...o,...extra}));
});
test('window start rolls forward and end backward without using a pre-window entry',()=>{
  const rows=[p('2025-10-03',100),p('2025-10-06',110),p('2025-10-07',121),p('2025-10-10',100)];
  const result=e.windowResult(rows,2025,'10-04','10-11').result;assert.equal(result.startDate,'2025-10-06');assert.equal(result.endDate,'2025-10-10');near(result.return,100/110-1);assert.equal(e.windowResult(rows,2025,'10-04','10-05').result,null);
});
test('large missing blocks and incomplete calendar years disable named lookbacks without sample inflation',()=>{
  const rows=fullHistory().filter(p=>!(p.date>='2014-10-05'&&p.date<='2014-10-25'));
  const a=e.analyzeSeasonality(rows,{asOf:'2026-10-01',lookback:20,start:'10-03',end:'10-27'});assert.equal(a.available,false);assert.equal(a.stats.sample,0);assert.equal(a.comparison.find(c=>c.lookback===20).valid,19);assert.ok(a.excluded.some(x=>x.year===2014));
  const max=e.analyzeSeasonality(rows,{asOf:'2026-10-01',lookback:'MAX',start:'10-03',end:'10-27'});assert.equal(max.available,true);assert.equal(max.stats.sample,26);
});
test('calendar alignment follows month/day across leap years; Feb 29 is not shifted into March',()=>{
  const a=e.analyzeSeasonality(fullHistory(),{asOf:'2026-10-01',lookback:20,start:'02-28',end:'03-04'});assert.equal(a.curve.length,365);assert.equal(a.curve.some(p=>p.monthDay==='02-29'),false);
  const march=a.curve.find(p=>p.monthDay==='03-01');for(const [y,date] of Object.entries(march.sourceDates)){assert.ok(date<=`${y}-03-01`);assert.ok(d.daysBetween(date,`${y}-03-01`)<=4);}
  assert.equal(e.windowResult(fullHistory(),2023,'02-29','03-04').reason,'FEB_29_NOT_PRESENT');assert.equal(e.windowResult(fullHistory(),2024,'02-29','03-04').result.startDate,'2024-02-29');
});
test('window daily returns include Feb 29 even though annual chart omits it',()=>{
  const r=e.windowResult([p('2024-02-28',100),p('2024-02-29',110),p('2024-03-01',99)],2024,'02-28','03-01').result;assert.equal(r.dailyLogReturns.length,2);near(r.logReturn,Math.log(.99));near(r.dailyLogReturns.reduce((a,b)=>a+b,0),r.logReturn);
});
test('calendar carry is bounded and current year never extends past its last actual fixing',()=>{
  const rows=fullHistory().filter(p=>p.date<='2026-09-25'),a=e.analyzeSeasonality(rows,{asOf:'2026-10-01',lookback:20,start:'10-03',end:'10-27'});
  assert.equal(a.currentThrough,'2026-09-25');assert.equal(a.curve.find(p=>p.monthDay==='09-26').current,null);assert.ok(a.curve.find(p=>p.monthDay==='12-20').average!==null);assert.equal(a.curve.find(p=>p.monthDay==='12-20').current,null);
});
test('unverified current-year jump hides the current overlay but does not corrupt verified historical statistics',()=>{
  const a=e.analyzeSeasonality(fullHistory().map(x=>x.date==='2026-02-02'?{...x,quality:'REVIEW_REQUIRED'}:x),{asOf:'2026-10-01',lookback:20,start:'10-03',end:'10-27'});
  assert.equal(a.available,true);assert.equal(a.stats.sample,20);assert.ok(a.curve.every(x=>x.current===null));
});
test('chart indices are 100 at each actual path start; arithmetic average is not a geometric mean',()=>{
  const a=e.analyzeSeasonality(fullHistory(),{asOf:'2026-10-01',lookback:20,start:'10-03',end:'10-27',view:'window'});
  for(const year of a.years){const first=a.curve.find(p=>p.years[year.year]!==undefined);near(first.years[year.year],100);}
  for(const p of a.curve){if(p.sample){near(p.average,Object.values(p.years).reduce((a,b)=>a+b,0)/p.sample);near(p.median,e.median(Object.values(p.years)));}}
});
test('cross-year seasonal windows exclude any end-year at or after the current year',()=>{
  const a=e.analyzeSeasonality(fullHistory(),{asOf:'2026-10-01',lookback:20,start:'12-20',end:'01-20',view:'window'});assert.equal(a.stats.sample,20);assert.equal(a.years.at(-1).year,2024);assert.equal(a.years.at(-1).endYear,2025);assert.equal(a.years[0].year,2005);assert.ok(a.curve.some(p=>p.monthDay==='12-31'));assert.ok(a.curve.some(p=>p.monthDay==='01-01'));
});
test('manual price example verifies exact return, log return, MFE and MAE from published prices',()=>{
  const r=e.windowResult([p('2024-10-03',100),p('2024-10-04',90),p('2024-10-07',120),p('2024-10-08',110)],2024,'10-03','10-08').result;
  near(r.return,.1);near(r.logReturn,Math.log(1.1));near(r.mfe,.2);near(r.mae,-.1);near(r.dailyLogReturns.reduce((a,b)=>a+b,0),r.logReturn);
});
test('manual sample verifies mean, median, positive/negative/flat share and n−1 deviation',()=>{
  const results=[.1,-.05,.2,0].map((r,i)=>({year:2020+i,return:r,mfe:Math.max(r,0),mae:Math.min(r,0),dailyLogReturns:[Math.log(1+r)]}));
  const s=e.summarize(results);near(s.average,.0625);near(s.median,.05);near(s.standardDeviation,Math.sqrt(.036875/3));near(s.winRate,.5);assert.deepEqual([s.positive,s.negative,s.flat],[2,1,1]);assert.equal(s.best.year,2022);assert.equal(s.worst.year,2021);near(s.consistency,.0625/Math.sqrt(.036875/3));assert.equal(s.spotSharpe,null);
});
test('spot Sharpe uses pooled daily log returns; cross-year consistency is a different ratio',()=>{
  const results=Array.from({length:5},(_,i)=>({year:2010+i,return:[.1,.2,-.1,.04,.01][i],mfe:.2,mae:-.1,dailyLogReturns:[.01,-.02,.03,.04]}));
  const s=e.summarize(results),daily=results.flatMap(r=>r.dailyLogReturns),m=daily.reduce((a,b)=>a+b,0)/20,sd=Math.sqrt(daily.reduce((a,b)=>a+(b-m)**2,0)/19);
  near(s.spotSharpe,m/sd*Math.sqrt(252));near(s.consistency,s.average/s.standardDeviation);assert.notEqual(s.spotSharpe,s.consistency);near(s.sortino,m/Math.sqrt(5*.02**2/20)*Math.sqrt(252));
});
test('zero variance and inadequate samples produce N/A, never fake Sharpe or confidence',()=>{
  const s=e.summarize(Array.from({length:5},(_,year)=>({year,return:.1,mfe:.1,mae:0,dailyLogReturns:[.01,.01,.01,.01]})));assert.equal(s.spotSharpe,null);assert.equal(s.consistency,null);assert.equal(s.sortino,null);assert.equal(e.summarize([]).winRate,null);assert.equal(e.standardDeviation([1]),null);assert.equal(e.median([2,5,1]),2);assert.equal(e.median([2,5,1,8]),3.5);
});
test('unverified jump blocks its sample year; official confirmation restores it without modifying price',()=>{
  const rows=fullHistory().map(p=>p.date==='2015-01-15'?{...p,quality:'REVIEW_REQUIRED'}:p),o={asOf:'2026-10-01',lookback:20,start:'10-03',end:'10-27'};assert.equal(e.analyzeSeasonality(rows,o).available,false);assert.equal(e.analyzeSeasonality(rows.map(p=>({...p,quality:p.quality==='REVIEW_REQUIRED'?'VERIFIED_LARGE_MOVE':p.quality})),o).available,true);
});
test('provenance distinguishes raw conventions, inversion, derived cross and source date freshness',()=>{
  const a=d.pairProvenance('AUDCAD');assert.equal(a.operation,'DIVIDE_CANONICAL_USD_PER_UNIT');assert.equal(a.series.find(s=>s.currency==='CAD').normalization,'INVERT');assert.equal(a.isDerived,true);assert.equal(d.pairProvenance('USDCHF').isDerived,false);assert.equal(a.sourceTimestamp,null);assert.match(a.fixing,/not a market closing/);
  assert.equal(d.fxFreshness('2026-09-25','2026-10-01'),'FRESH');assert.equal(d.fxFreshness('2026-09-18','2026-10-01'),'STALE');assert.equal(d.fxFreshness('2026-10-02','2026-10-01'),'UNAVAILABLE');
});
test('D1 stores immutable real-valued vintages, deduplicates repeats and preserves revisions/reversions',async()=>{
  const {sql,db}=sqlite(),row={date:'2025-10-03',currency:'AUD',raw:.7,usdPerUnit:.7,quality:'VALID'};
  await w.persistFxRows(db,[row],'2026-10-01T10:00:00.000Z');await w.persistFxRows(db,[row],'2026-10-01T11:00:00.000Z');assert.equal(sql.prepare('SELECT COUNT(*) n FROM seasonality_fx_rates').get().n,1);
  await w.persistFxRows(db,[{...row,raw:.71,usdPerUnit:.71}],'2026-10-02T10:00:00.000Z');await w.persistFxRows(db,[row],'2026-10-03T10:00:00.000Z');assert.equal(sql.prepare('SELECT COUNT(*) n FROM seasonality_fx_rates').get().n,3);
  near((await w.readFxRows(db,['AUD'],'2025-12-31','2026-10-02T12:00:00.000Z'))[0].usdPerUnit,.71);near((await w.readFxRows(db,['AUD'],'2025-12-31'))[0].usdPerUnit,.7);assert.equal((await w.readFxRows(db,['AUD'],'2025-12-31','2026-09-30T12:00:00.000Z')).length,0);
  const raw=sql.prepare('SELECT * FROM seasonality_fx_rates LIMIT 1').get();assert.equal(raw.source_series_id,'DEXUSAL');assert.equal(raw.source_timestamp,null);assert.equal(raw.quote_currency,'USD');assert.equal(raw.normalization_version,'usd-per-unit-v1');sql.close();
});
test('D1 history query uses compound primary-key index and migrations are additive',()=>{
  const {sql}=sqlite();const plan=sql.prepare('EXPLAIN QUERY PLAN SELECT * FROM seasonality_fx_rates WHERE base_currency=? AND date<=? ORDER BY date,ingested_at').all('EUR','2026-10-01');assert.match(JSON.stringify(plan),/USING INDEX sqlite_autoindex_seasonality_fx_rates/);const migration=readFileSync('drizzle/0003_serious_firebrand.sql','utf8');assert.doesNotMatch(migration,/DROP|DELETE|INSERT|ALTER/);sql.close();
});
test('sync consumes real-format data, is idempotent, separates failed source status and never changes Core tables',async()=>{
  const {sql,db}=sqlite(),input=csv(['2025-10-03,1.1,1.3,0.7,0.6,150,0.9,1.3']);let calls=0;const fetcher=async()=>{calls++;return new Response(input);};
  const a=await w.syncSeasonality({DB:db},'TEST_ONLY','2026-10-01T10:00:00.000Z',fetcher);assert.equal(a.status,'SUCCESS');assert.equal(a.parsedRows,7);
  assert.equal((await w.syncSeasonality({DB:db},'TEST_ONLY','2026-10-01T11:00:00.000Z',fetcher)).status,'ALREADY_CURRENT');assert.equal(calls,1);
  const failed=await w.syncSeasonality({DB:db},'TEST_ONLY','2026-10-02T12:00:00.000Z',async()=>new Response('Unavailable',{status:503}));assert.equal(failed.status,'FAILED');assert.equal(sql.prepare('SELECT COUNT(*) n FROM seasonality_fx_rates').get().n,7);const health=await w.seasonalityHealth({DB:db},'2026-10-02T12:00:00Z');assert.equal(health.status,'UPDATE_FAILED');assert.equal(health.freshness,'STALE');
  for(const table of ['terminal_snapshots','currency_observations','observation_vintages','evidence_entries','production_records','terminal_settings'])assert.equal(sql.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);sql.close();
});
test('source validation failure is audited without inserting corrupt or future values',async()=>{
  const {sql,db}=sqlite();const r=await w.syncSeasonality({DB:db},'TEST_ONLY','2026-10-01T12:00:00.000Z',async()=>new Response(csv(['2026-10-02,1.1,1.3,0.7,0.6,150,0.9,1.3'])));assert.equal(r.status,'FAILED');assert.equal(sql.prepare('SELECT COUNT(*) n FROM seasonality_fx_rates').get().n,0);assert.equal(sql.prepare('SELECT status FROM seasonality_sync_runs').get().status,'FAILED');sql.close();
});
test('offline initial archive import is explicitly labelled and preserves the live fetch failure',async()=>{
  const {sql,db}=sqlite(),env={DB:db,ASSETS:{fetch:async()=>new Response(csv(['2025-10-03,1.1,1.3,0.7,0.6,150,0.9,1.3']))}};
  const r=await w.syncSeasonality(env,'TEST_ONLY','2026-10-01T12:00:00.000Z',async()=>new Response('',{status:503}));assert.equal(r.mode,'OFFICIAL_ARCHIVE_BOOTSTRAP');const h=await w.seasonalityHealth(env,'2026-10-01T12:00:00Z');assert.equal(h.status,'ARCHIVE_READY');assert.equal(h.lastError,'HTTP_503');assert.equal(h.freshness,'STALE');sql.close();
});
test('pair API freshness follows the last shared fixing, not a fresher unrelated currency',async()=>{
  const {sql,db}=sqlite();await w.persistFxRows(db,[{date:'2026-09-01',currency:'AUD',raw:.7,usdPerUnit:.7,quality:'VALID'},{date:'2026-09-01',currency:'CAD',raw:1.3,usdPerUnit:1/1.3,quality:'VALID'},{date:'2026-09-25',currency:'CAD',raw:1.31,usdPerUnit:1/1.31,quality:'VALID'}],'2026-10-01T10:00:00Z');
  sql.prepare('INSERT INTO seasonality_sync_state VALUES (?,?,?)').run('history',JSON.stringify({lastSuccess:'2026-10-01T10:00:00Z',firstArchiveAt:'2026-10-01T10:00:00Z',lastDate:'2026-09-25'}),'2026-10-01');
  const r=await w.seasonalityApi(new Request('https://example.test/api/seasonality/history?pair=AUDCAD&asOf=2026-10-01'),{DB:db},{waitUntil(){throw new Error('Unexpected write');}}),h=await r.json();assert.equal(h.pairLastDate,'2026-09-01');assert.equal(h.pairFreshness,'STALE');assert.equal(h.health.lastDate,'2026-09-25');sql.close();
});
test('API rejects future cutoffs, unsupported pairs, CSRF and unarchived historical point-in-time simulation',async()=>{
  const {sql,db}=sqlite();sql.prepare('INSERT INTO seasonality_sync_state VALUES (?,?,?)').run('history',JSON.stringify({lastSuccess:'2026-10-01T10:00:00Z',firstArchiveAt:'2026-10-01T10:00:00Z',lastDate:'2026-09-25'}),'2026-10-01');
  const request=path=>w.seasonalityApi(new Request('https://example.test/api/seasonality/'+path),{DB:db},{waitUntil(){throw new Error('Unexpected write');}});
  assert.equal((await request('history?pair=USDUSD')).status,400);assert.equal((await request('history?asOf=2099-01-01')).status,400);assert.equal((await request('history?asOf=2022-10-01&mode=point-in-time')).status,409);assert.equal((await request('stats?lookback=500')).status,400);
  assert.equal((await w.seasonalityApi(new Request('https://example.test/api/seasonality/sync',{method:'POST'}),{DB:db},{waitUntil(){}})).status,403);sql.close();
});
test('module imports remain isolated from production scoring and scheduled integration keeps its source label',()=>{
  for(const file of ['lib/seasonality-data.ts','lib/seasonality-engine.ts','worker/seasonality.ts']){const source=readFileSync(file,'utf8');assert.doesNotMatch(source,/from\s+['"].*(?:production-research|model-engine|adaptive-evidence|hypothesis-context|terminal-data)/);assert.doesNotMatch(source,/(?:INSERT INTO|UPDATE) (?:terminal_|production_records|observation_vintages)/);}
  const worker=readFileSync('worker/index.ts','utf8');assert.ok(worker.indexOf('requireAuthenticatedSiteUser(request)')<worker.indexOf("return seasonalityApi"));assert.match(worker,/queueSeasonality\(env, ctx, url.pathname === '\/api\/automation\/run' \? \(inner.headers.has\('x-fx-schedule'\)/);
});
test('real official archive has a pinned receipt, 90788 observations and 56 reproducible same-date pair histories',async()=>{
  const csv=readFileSync('public/data/seasonality/h10-bootstrap.csv','utf8'),receipt=JSON.parse(readFileSync('public/data/seasonality/h10-bootstrap-source.json','utf8'));
  assert.equal(createHash('sha256').update(csv).digest('hex'),receipt.sha256);
  const parsed=d.parseFxCsv(csv,'2026-10-01');assert.equal(parsed.rows.length,90788);await w.confirmLargeMoves(parsed.rows,async()=>{throw new Error('Offline audit');});assert.ok(parsed.rows.every(r=>r.quality!=='REVIEW_REQUIRED'));
  const audit=JSON.parse(readFileSync('docs/seasonality-source-audit.json','utf8'));assert.equal(audit.fedMismatches.length,0);
  for(const expected of audit.pairCoverage){const points=d.derivePair(parsed.rows,expected.pair,'2026-10-01');assert.equal(points.length,expected.fixings);assert.equal(points[0].date,expected.firstDate);assert.equal(points.at(-1).date,expected.lastDate);}
});
test('20 historical windows reproduce independent Python arithmetic from real raw source legs',async()=>{
  const parsed=d.parseFxCsv(readFileSync('public/data/seasonality/h10-bootstrap.csv','utf8'),'2026-10-01');await w.confirmLargeMoves(parsed.rows,async()=>{throw new Error('Offline audit');});
  const audit=JSON.parse(readFileSync('docs/seasonality-source-audit.json','utf8'));assert.equal(audit.checks.length,20);
  for(const check of audit.checks){const actual=e.windowResult(d.derivePair(parsed.rows,check.pair,'2026-10-01'),check.year,check.start,check.end).result;assert.equal(actual.startDate,check.startDate);assert.equal(actual.endDate,check.endDate);for(const key of ['startPrice','endPrice','return','mfe','mae'])near(actual[key],check[key]);}
});
