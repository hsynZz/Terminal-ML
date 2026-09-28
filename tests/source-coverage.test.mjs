import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,appType:'custom',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});
after(()=>vite.close());
const source=await vite.ssrLoadModule('/lib/source-expansion.ts');
const data=await vite.ssrLoadModule('/lib/terminal-data.ts');
const core=await vite.ssrLoadModule('/lib/model-engine.ts');
const ingest=await vite.ssrLoadModule('/lib/production-data.ts');
const research=await vite.ssrLoadModule('/lib/production-research.ts');
const coverage=await vite.ssrLoadModule('/lib/research-coverage.ts');
const runtime=await vite.ssrLoadModule('/worker/production.ts');
const at='2026-09-28T18:00:00.000Z',day=86400000;
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
function complete(){const p=data.getBaselinePayload();p.asOf=at;p.sourceMode='partial-live';p.coreFactors=Object.fromEntries(data.currencies.map(c=>[c,Object.fromEntries(Object.keys(data.factorMeta).map(f=>[f,{status:'OBSERVED',availability:'FRESH',source:'local fixture',period:'2025',availableAt:at,inputs:[{metric:'growth',value:2,period:'2025',receivedAt:at,source:'local fixture'}]}]))]));return p;}

test('Core criticality is dependency based: isolated context gaps permit LIVE; critical or category gaps do not',()=>{
  const p=complete();ingest.refreshSourceStatus(p,at);assert.equal(p.sourceMode,'full-live');assert.equal(p.sourceCoverage.critical.total,60);
  p.coreFactors.CAD.seasonality.status='LEGACY_OR_CARRIED';ingest.refreshSourceStatus(p,at);assert.equal(p.sourceMode,'live');assert.equal(p.sourceCoverage.fresh,79);assert.equal(p.sourceCoverage.critical.ratio,1);
  p.coreFactors.JPY.yields.status='PARTIAL_CROSS_SECTION';ingest.refreshSourceStatus(p,at);assert.equal(p.sourceMode,'partial-live');assert.ok(p.sourceCoverage.critical.missing.includes('JPY.yields'));
  const q=complete();for(const c of data.currencies)q.coreFactors[c].seasonality.status='LEGACY_OR_CARRIED';ingest.refreshSourceStatus(q,at);assert.equal(q.sourceMode,'partial-live');assert.deepEqual(q.sourceCoverage.categoryGaps,['seasonality']);
  const empty=data.getBaselinePayload();ingest.refreshSourceStatus(empty,at);assert.equal(empty.sourceMode,'baseline');
});
test('coverage label changes alone do not alter any forecast or create source dots',()=>{
  const p=complete();p.coreFactors.CAD.seasonality.status='LEGACY_OR_CARRIED';
  const before=core.buildModelDistribution(p,data.currencies),pairs=data.currencies.flatMap(a=>data.currencies.filter(b=>a!==b).map(b=>core.buildPairForecast(p,a,b)));
  ingest.refreshSourceStatus(p,at);assert.equal(p.sourceMode,'live');assert.equal(p.forecastSourceMode,'partial-live');
  assert.deepEqual(core.buildModelDistribution(p,data.currencies),before);
  assert.deepEqual(data.currencies.flatMap(a=>data.currencies.filter(b=>a!==b).map(b=>core.buildPairForecast(p,a,b))),pairs);
  assert.equal(before.points.length,8*26);assert.ok(before.points.every(p=>data.currencies.includes(p.currency)));
});
test('invalid dates, future receipts, empty dependencies and expired annual inputs cannot certify Core',()=>{
  assert.equal(ingest.observationQuality('growth',2,'2026-02-30',at),'INVALID');
  const p=complete();p.coreFactors.USD.yields.inputs=[];ingest.refreshSourceStatus(p,at);assert.equal(p.sourceCoverage.fresh,79);assert.equal(p.sourceMode,'partial-live');
  p.coreFactors.EUR.policy.inputs[0].receivedAt='2030-01-01T00:00:00Z';ingest.refreshSourceStatus(p,at);assert.equal(p.sourceCoverage.fresh,78);
  ingest.refreshSourceStatus(p,'2031-01-01T00:00:00Z');assert.equal(p.sourceMode,'baseline');
});
test('Canadian, Japanese and Australian parsers preserve maturity, negative/zero yields and missing/future rejection',()=>{
  const cad=source.parseCanadianYields({observations:[{d:'2026-09-25','BD.CDN.2YR.DQ.YLD':{v:'0'},'BD.CDN.10YR.DQ.YLD':{v:'-.1'}},{d:'2026-09-29','BD.CDN.2YR.DQ.YLD':{v:'5'},'BD.CDN.10YR.DQ.YLD':{v:'6'}}]},at);
  assert.equal(cad.length,3);assert.equal(cad[0].value,0);assert.equal(cad[1].value,-.1);assert.equal(cad[0].releaseDate,null);
  assert.equal(source.parseCanadianYields({observations:[{d:'2026-09-25','BD.CDN.2YR.DQ.YLD':{v:''},'BD.CDN.10YR.DQ.YLD':{v:'3'}}]},at).length,0);
  const jpy=source.parseJapaneseYields('Interest Rate\nDate,1Y,2Y,10Y\n2026/9/25,1,2,3\n2026/9/29,8,9,10\n',at);assert.equal(jpy[0].value,2);assert.equal(jpy[1].value,3);
  const aud=source.parseAustralianYields('F2\nSeries ID,FCMYGBAG2D,FCMYGBAG10D\n25-Sep-2026,2.3,3.4\n26-Sep-2026,,3.5',at);assert.equal(aud[0].value,2.3);assert.equal(aud[0].period,'2026-09-25');
  assert.equal(source.parseAustralianYields('Series ID,FCMYGBAG2D,FCMYGBAG10D\n25-Sep-2020,2.3,3.4',at).length,0);
  assert.throws(()=>source.parseJapaneseYields('incompatible units/schema',at),/INVALID_RESPONSE/);
});
test('ECB nominal par curves require exact currency, maturity and units; spot rates are not substituted',()=>{
  const head='FREQ,REF_AREA,CURRENCY,PROVIDER_FM,INSTRUMENT_FM,PROVIDER_FM_ID,DATA_TYPE_FM,TIME_PERIOD,OBS_VALUE,UNIT,UNIT_MULT\n';
  const row=(type,v,unit='PCPA')=>`B,U2,EUR,4F,G_N_A,SV_C_YM,${type},2026-09-25,${v},${unit},0\n`;
  const good=head+row('PY_2Y',2.4)+row('PY_10Y',3.5);
  assert.equal(source.parseEuroYields(good,at)[0].value,2.4);
  assert.equal(source.parseEuroYields(head+row('SR_2Y',2.4)+row('SR_10Y',3.5),at).length,0);
  assert.equal(source.parseEuroYields(head+row('PY_2Y',2.4,'USD')+row('PY_10Y',3.5),at).length,0);
});
test('yield repricing uses real consecutive observations and USD spreads require matching dates',()=>{
  const points=Array.from({length:6},(_,i)=>({d:`2026-09-${25-i}`,'BD.CDN.2YR.DQ.YLD':{v:String(2+i*.1)},'BD.CDN.10YR.DQ.YLD':{v:String(3+i*.1)}}));
  const rows=source.parseCanadianYields({observations:points},at),two=rows.find(r=>r.metric==='yield2y');
  near(rows.find(r=>r.metric==='alt.rates.yield2y.change.v1').value,-.5);
  const usd={...two,currency:'USD',source:'FRED',sourceUrl:'https://fred.stlouisfed.org/series/DGS2',value:3};
  const spreads=source.relativeYieldFeatures([two,usd],at);assert.equal(spreads.length,1);assert.equal(spreads[0].value,-1);
  assert.equal(source.relativeYieldFeatures([two,{...usd,period:'2026-09-24'}],at).length,0);
});
test('monthly supply vintages and commodity baskets have their own freshness and actual publication dates',()=>{
  const supply=source.parseSupplyPressure('Date,Aug-26,Sep-26,Oct-26\n31-Jul-2026,1.4,1.5,999\n31-Aug-2026,#N/A,1.1,999\n30-Sep-2026,#N/A,#N/A,999',at);
  assert.equal(supply[0].value,1.1);assert.equal(supply[0].period,'2026-08-31');assert.equal(supply[0].quality,'VALID');assert.equal(supply[0].releaseDate,null);
  assert.equal(ingest.observationQuality(supply[0].metric,supply[0].value,supply[0].period,'2026-12-01T00:00:00Z'),'STALE');
  const csv='Title,Commodity prices – US$\nUnits,index\nPublication date,01-Sep-2026\nSeries ID,GRCPAIUSD\n31/05/2026,100\n30/06/2026,101\n31/07/2026,103\n31/08/2026,104\n30/09/2026,999';
  const basket=source.parseCommodityBasket(csv,at);assert.equal(basket.length,2);assert.equal(basket[1].currency,'AUD');assert.equal(basket[1].releaseDate,'2026-09-01');assert.equal(basket[1].value,104);assert.equal(basket[1].quality,'VALID');near(basket[1].normalizedValue,Math.tanh(4*Math.log(1.04)));
  assert.equal(source.parseCommodityBasket(csv.replace('01-Sep-2026','01-Oct-2026'),at).length,0);
});
test('aggregate crime features carry countries, immutable provenance, no demographic variables and no invented euro-area peer',()=>{
  const spec=source.annualResearch[0],body=[{},[{countryiso3code:'CAN',date:'2023',value:2},{countryiso3code:'CAN',date:'2022',value:2.5},{countryiso3code:'GBR',date:'2021',value:1},{countryiso3code:'GBR',date:'2020',value:1.1},{countryiso3code:'CAN',date:'2027',value:99}]];
  const rows=source.parseAnnualResearch(body,spec,at),can=rows.find(r=>r.currency==='CAD'&&r.metric===spec.metric),gbp=rows.find(r=>r.currency==='GBP'&&r.metric===spec.metric);
  near(can.normalizedValue,-1/4.5);assert.equal(can.releaseDate,null);assert.equal(can.receivedAt,at);assert.equal(gbp.quality,'STALE');assert.ok(!rows.some(r=>r.currency==='EUR'));assert.deepEqual(can.lineage,['WorldBank:VC.IHR.PSRC.P5']);assert.match(can.definition,/Aggregate all persons only/);
  const p=data.getBaselinePayload();p.asOf=at;const frame=research.buildResearchFrame(p,rows);assert.equal(frame.features.CAD[spec.metric],can.normalizedValue);assert.equal(frame.features.GBP[spec.metric],undefined);
  const hypotheses=research.discoverRecipes([],frame);assert.ok(hypotheses.some(h=>h.feature===spec.metric));assert.ok(hypotheses.every(h=>h.weight===0&&h.status==='DISCOVERY'));assert.ok(hypotheses.every(h=>h.rationale.includes('Null hypothesis')));
});
test('Research gaps and premium classes are separate from Core; stale/future/revised observations stay honest',()=>{
  const spec=source.annualResearch[0],rows=source.parseAnnualResearch([{},[{countryiso3code:'CAN',date:'2023',value:2},{countryiso3code:'CAN',date:'2022',value:2.5}]],spec,at);
  const failed={at,source:spec.source,url:'https://api.worldbank.org',currency:'EUR',metrics:[spec.metric],status:'MISSING',cause:'NO_VALID_OBSERVATIONS',fallback:'No influence',latencyMs:0};
  const r=coverage.researchCoverage(rows,[failed],at);assert.equal(r.classes.find(c=>c.name==='Aggregate public-safety statistics').status,'PARTIAL');assert.equal(r.freshObservations,1);
  const p=complete();p.sourceChecks=[failed];p.researchCoverage=r;ingest.refreshSourceStatus(p,at);assert.equal(p.sourceMode,'full-live');
  assert.equal(coverage.researchCoverage(rows.map(r=>({...r,releaseDate:'2026-10-01'})),[],at).freshObservations,0);
  assert.ok(coverage.sourceGaps.filter(x=>x.status==='PREMIUM SOURCE RECOMMENDED').every(x=>x.history&&x.frequency&&x.pointInTime&&x.integration));
});
test('unavailable country-specific alternative input cannot kill another country observed feature; used source failures still count',()=>{
  const metric=source.annualResearch[0].metric,sourceName=source.annualResearch[0].source;
  const f={features:{CAD:{[metric]:.2},GBP:{}},sources:{[metric]:[sourceName]}};
  const check={at,source:sourceName,url:'https://api.worldbank.org',metrics:[metric],cause:null,fallback:'none',latencyMs:0};
  const relevant=research.researchSourceChecks(f,[{...check,currency:'ALL',status:'SUCCESS'},{...check,currency:'GBP',status:'MISSING'},{...check,currency:'CAD',status:'FAILED'}]);
  assert.deepEqual(relevant.map(c=>c.currency),['ALL','CAD']);
});
test('seasonality uses completed prior years, full currency baskets, sample and stability metadata; no future history changes it',()=>{
  const cube=(date,shift=0)=>`<Cube time='${date}'>${data.currencies.filter(c=>c!=='EUR').map((c,j)=>`<Cube currency='${c}' rate='${1+j*.1+shift*(j%2?1:-1)}'/>`).join('')}</Cube>`;
  let xml=cube('2026-09-25');for(let y=2006;y<2026;y++)xml+=cube(`${y}-09-30`)+cube(`${y}-10-31`,.01+(y%3)*.002);
  const rows=source.parseSeasonality(xml,at);assert.equal(rows.length,8);assert.ok(rows.every(r=>r.value>=.35&&r.value<=.65&&r.rawInputs[0].samples===20&&r.rawInputs[0].history.every(s=>s.end<'2026')));
  assert.deepEqual(source.parseSeasonality(xml+cube('2027-10-31',.5),at),rows);
  assert.equal(source.parseSeasonality(xml.replaceAll('2026-09-25','2020-09-25'),at).length,0);
  assert.equal(source.parseSeasonality(cube('2026-09-25'),at).length,0);
});
test('normalized feature revisions survive unchanged latest raw values without overwriting earlier vintages',async()=>{
  const sql=new DatabaseSync(':memory:');for(const f of ['0000_hesitant_krista_starr.sql','0001_happy_mandroid.sql','0002_sudden_blazing_skull.sql'])sql.exec(readFileSync(new URL('../drizzle/'+f,import.meta.url),'utf8'));
  const db={prepare(q){const st=sql.prepare(q);let values=[];return {bind(...v){values=v;return this},async all(){return {results:st.all(...values)}},async run(){return st.run(...values)}}},async batch(rows){return Promise.all(rows.map(r=>r.run()))}};
  const spec=source.annualResearch[0],o=source.parseAnnualResearch([{},[{countryiso3code:'CAN',date:'2023',value:2},{countryiso3code:'CAN',date:'2022',value:2.5}]],spec,at)[1];
  o.rawInputs=o.rawInputs.map(r=>({...r,receivedAt:at}));
  await runtime.archiveObservations(db,[o],at);
  const later=new Date(Date.parse(at)+day).toISOString();await runtime.archiveObservations(db,[{...o,receivedAt:later,rawInputs:o.rawInputs.map(r=>({...r,receivedAt:later}))}],later);assert.equal(sql.prepare('SELECT count(*) n FROM observation_vintages').get().n,1);
  await runtime.archiveObservations(db,[{...o,receivedAt:later,normalizedValue:.3,rawInputs:[{period:'2022',value:1.5}]}],later);
  const rows=sql.prepare('SELECT payload FROM observation_vintages ORDER BY received_at').all().map(r=>JSON.parse(r.payload));assert.equal(rows.length,2);assert.equal(rows[0].value,rows[1].value);assert.notEqual(rows[0].normalizedValue,rows[1].normalizedValue);assert.equal(rows[0].receivedAt,at);sql.close();
});
