import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,appType:'custom',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});
after(()=>vite.close());
const data=await vite.ssrLoadModule('/lib/terminal-data.ts');
const ingest=await vite.ssrLoadModule('/lib/production-data.ts');
const sources=await vite.ssrLoadModule('/lib/observed-sources.ts');
const narrative=await vite.ssrLoadModule('/lib/narrative-features.ts');
const research=await vite.ssrLoadModule('/lib/production-research.ts');
const targets=await vite.ssrLoadModule('/lib/shadow-targets.ts');
const context=await vite.ssrLoadModule('/lib/hypothesis-context.ts');
const at='2026-09-22T12:00:00.000Z',day=86400000;
const priceRows=(now=at,n=70)=>Array.from({length:n},(_,i)=>data.currencies.map((currency,j)=>({currency,metric:'fxReferenceUsd',value:currency==='USD'?1:1+j*.1+i*.002*(j%2?1:-1),period:new Date(Date.parse(now)-(n-i)*day).toISOString().slice(0,10),receivedAt:now,source:'ECB reference fixing',sourceUrl:'https://www.ecb.europa.eu/',unit:'USD per currency',releaseDate:null,quality:'VALID',frequency:'business-daily'}))).flat();
function frame(now=at){const p=data.getBaselinePayload();p.asOf=now;p.sourceChecks=[];return research.buildResearchFrame(p,priceRows(now));}
const cot=(code,date,long='60',short='20',oi='100')=>({cftc_contract_market_code:code,report_date_as_yyyy_mm_dd:date,noncomm_positions_long_all:long,noncomm_positions_short_all:short,open_interest_all:oi,market_and_exchange_names:'fixture contract'});

test('BIS CSV units, freshness and missing values fail closed; quoted source descriptions are retained',()=>{
  assert.deepEqual(sources.csvRecords('a,b\n"one, two","line\nwith ""quote"""\n'),[{a:'one, two',b:'line\nwith "quote"'}]);
  assert.throws(()=>sources.csvRecords('a\n"unfinished'));
  const header='REF_AREA,FREQ,UNIT_MEASURE,UNIT_MULT,OBS_VALUE,TIME_PERIOD,COMPILATION,SOURCE_REF\n';
  const csv=header+'GB,D,368,0,3.75,2026-09-21,"policy, rate",Bank\nGB,D,368,0,99,2026-09-23,x,x\nXM,D,368,0,,2026-09-21,x,x\nJP,D,wrong,0,1,2026-09-21,x,x\nCH,D,368,0,0,2020-01-01,x,x';
  const rows=sources.parseBisPolicy(csv,at);assert.equal(rows.length,1);assert.equal(rows[0].currency,'GBP');assert.equal(rows[0].value,3.75);assert.equal(rows[0].receivedAt,at);assert.equal(rows[0].releaseDate,null);assert.match(rows[0].definition,/policy, rate/);
  assert.match(sources.bisUrl(at),/\/api\/v2\//);
});
test('CFTC normalization is deterministic, separate Legacy positions; acceleration requires contiguous weeks',()=>{
  const rows=sources.parseCot(Object.keys(sources.cotContracts).flatMap(code=>[cot(code,'2026-09-15','60'),cot(code,'2026-09-08','50'),cot(code,'2026-09-01','45')]),at);
  assert.equal(rows.filter(r=>r.metric==='cot').length,8);assert.equal(rows.find(r=>r.metric==='cot').value,.7);
  const acceleration=rows.find(r=>r.metric==='alt.cot.acceleration.v1');assert.ok(Math.abs(acceleration.value-.05)<1e-12);assert.equal(acceleration.rawInputs.length,3);assert.equal(acceleration.releaseDate,null);assert.equal(acceleration.receivedAt,at);
  assert.match(rows.find(r=>r.currency==='USD').definition,/ICE USD index/);
  assert.equal(sources.parseCot([cot('099741','2026-09-15','60','20','0')],at).length,0);
  assert.equal(sources.parseCot([cot('099741','2026-09-15'),cot('099741','2026-09-01')],at).some(r=>r.metric.includes('change')),false);
  assert.equal(sources.parseCot([cot('099741','2026-09-30')],at).length,0);
});
test('alternative macro inputs preserve raw data, real receipt time and no missing-key success',async()=>{
  const spec=sources.macroProxySeries.find(s=>s.id==='STLFSI4');
  const rows=sources.parseMacroProxy({observations:[{date:'2026-09-18',value:'-0.6'},{date:'2026-10-01',value:'5'}]},spec,at);
  assert.equal(rows.length,2);assert.equal(rows[0].value,-.6);assert.ok(Math.abs(rows[1].value-Math.tanh(-.2))<1e-12);assert.equal(rows[1].receivedAt,at);assert.equal(rows[1].currency,'GLOBAL');assert.deepEqual(rows[1].lineage,['FRED:STLFSI4']);
  assert.equal(sources.parseMacroProxy({observations:[{date:'2020-01-01',value:'1'}]},spec,at).length,0);
  const checks=[];assert.deepEqual(await sources.collectMacroProxies(checks,undefined),[]);assert.equal(checks.length,5);assert.ok(checks.every(c=>c.status==='MISSING'&&c.fallback.includes('UNAVAILABLE')));
  const oil=sources.macroProxySeries[0];assert.deepEqual(sources.parseMacroProxy({observations:[{date:'2026-09-21',value:'70'}]},oil,at),[]);
});
test('official narrative features reject future/undated items, deduplicate and identify bounded RSS sample',()=>{
  const item={currency:'USD',source:'Federal Reserve · Speeches',title:'Inflation policy',summary:'Stable rates',publishedAt:'2026-09-21T10:00:00Z'};
  const old={...item,title:'Labor demand',summary:'Employment growth',publishedAt:'2026-09-10T10:00:00Z'};
  const expected=narrative.narrativeObservations([item,old],at),actual=narrative.narrativeObservations([item,item,old,{...item,publishedAt:'2026-10-01T00:00:00Z'},{...item,publishedAt:null}],at);
  assert.deepEqual(actual,expected);assert.equal(actual.length,2);assert.equal(actual[0].rawInputs.length,2);assert.ok(actual.every(r=>r.receivedAt===at&&r.featureVersion==='official-narrative-v1'));assert.match(actual[0].definition,/bounded sample/);
});
test('Core coverage never presents carried or partial factors as fresh; weights do not change',()=>{
  const p=data.getBaselinePayload(),weights=structuredClone(data.factorMeta);p.asOf=at;
  const cotRows=sources.parseCot(Object.keys(sources.cotContracts).map(code=>cot(code,'2026-09-15')),at).filter(r=>r.metric==='cot');
  ingest.truthfulEvidence(p,cotRows);assert.equal(p.sourceCoverage.fresh,8);assert.equal(p.coreFactors.USD.cot.availability,'FRESH');assert.equal(p.coreFactors.EUR.seasonality.availability,'CARRIED INPUT');assert.notEqual(p.coreFactors.USD.risk.status,'OBSERVED');
  p.asOf='2026-09-23T12:00:00Z';p.sourceChecks=[{at:p.asOf,source:'CFTC Legacy futures only',currency:'ALL',metrics:['cot'],status:'FAILED',cause:'HTTP_503',url:sources.cotUrl,fallback:'CARRIED INPUT',latencyMs:1}];
  ingest.truthfulEvidence(p,[]);assert.equal(p.coreFactors.USD.cot.availability,'FALLBACK');assert.equal(p.coreFactors.USD.cot.availableAt,at);assert.equal(p.sourceCoverage.fresh,0);assert.deepEqual(data.factorMeta,weights);
});
test('one-country and global alternatives retain provenance without fabricated peer inputs',()=>{
  const p=data.getBaselinePayload();p.asOf=at;p.sourceChecks=[];
  const receipt={currency:'USD',metric:'alt.us.fixture.v1',value:.4,normalizedValue:.4,period:'2026-09-21',receivedAt:at,source:'fixture source',sourceUrl:'https://example.org',unit:'index',releaseDate:null,frequency:'daily',quality:'VALID',featureVersion:'v1',definition:'A real-source fixture for labor demand',economicCause:'labor',lineage:['series:fixture']};
  const f=research.buildResearchFrame(p,[...priceRows(),receipt,{...receipt,currency:'GLOBAL',metric:'alt.global.fixture.v1'}]);
  assert.equal(f.features.USD[receipt.metric],.4);assert.equal(f.features.EUR[receipt.metric],undefined);assert.ok(data.currencies.every(c=>f.features[c]['alt.global.fixture.v1']===.4));
  assert.deepEqual(f.featureOrigins[receipt.metric].lineage,['series:fixture']);
  const candidate=research.discoverRecipes([],f).find(r=>r.feature===receipt.metric);assert.ok(candidate);assert.match(candidate.rationale,/labor/);assert.equal(candidate.weight,0);
});
test('redundancy detects underlying source/cause; hypothesis qualification ages out',()=>{
  const f=frame(),base=research.discoverRecipes([],f)[0];
  const r={...base,id:'a',feature:'a',status:'ACTIVE',gate:{passed:true,improvement:1},weight:.02,lastChangedAt:at,lastValidatedAt:at,lineage:['same series'],economicCauses:['same cause']};
  assert.equal(research.nonRedundant([r,{...r,id:'b',feature:'b'}],[f]).length,1);
  assert.equal(research.effectiveRecipeWeight(r,at),.02);assert.ok(research.effectiveRecipeWeight(r,new Date(Date.parse(at)+90*day).toISOString())<.02);assert.equal(research.effectiveRecipeWeight(r,new Date(Date.parse(at)+181*day).toISOString()),0);
});
test('event predictions freeze thresholds and exclude future information; no directional contribution',()=>{
  const f=frame(),prices=priceRows();
  const issued=targets.issueEventPredictions(f,prices,[]);assert.ok(issued.length>100);assert.ok(issued.every(p=>p.influence===0&&p.calibrated===false&&p.baseline===null));
  assert.deepEqual(targets.issueEventPredictions(f,[...prices,...priceRows('2026-10-22T12:00:00Z')],[]),issued);
  assert.deepEqual(targets.resolveEventPredictions(f,issued,[],prices,at),[]);
  const now='2026-10-25T12:00:00Z',future=priceRows(now,110),outcomes=research.resolveFrameTargets(f,future,now),resolved=targets.resolveEventPredictions(f,issued,outcomes,future,now);
  assert.ok(resolved.length>0);assert.ok(resolved.every(o=>o.labelEnd<now.slice(0,10)&&o.asOf===at));assert.ok(!resolved.some(o=>o.horizon===90));
  assert.ok(targets.eventTargetStatus(resolved).every(t=>t.influence===0&&!t.gate.passed));
});
test('context inputs and labels preserve currency/pair identity, regime and missing-feature gates',()=>{
  const f=frame();f.sourceReliability=1;f.regimeVerified=true;f.hypotheses={a:{USD:.8,EUR:.2},b:{USD:.7,EUR:.3}};f.pairForecasts=[{pair:'USD/EUR',horizon:10,core:.4,adaptive:.4}];
  const x=context.contextInputs(f,'USD/EUR',10,['a','b']);assert.equal(x.core,.4);assert.ok(x.x['entity:USD/EUR:a']>0);assert.ok('interaction:a:b' in x.x);
  assert.equal(context.contextInputs(f,'JPY',10,['a']),null);
  const model={version:context.CONTEXT_VERSION,horizon:10,recipeIds:['a','b'],weights:Object.fromEntries(Object.keys(x.x).map(k=>[k,0]))};
  assert.equal(context.contextScore(model,f,'USD/EUR').candidate,.4);assert.equal(context.contextScore(model,{...f,regime:'unseen-regime'},'USD/EUR'),null);
  const outcomes=['USD','EUR'].map((currency,i)=>({frameId:f.id,currency,horizon:10,entryDate:'2026-09-23',labelEnd:'2026-10-03',label:1,forwardReturn:.02-i*.01}));
  assert.equal(context.contextLabels([f],outcomes,10,'pair').length,1);outcomes[1].entryDate='2026-09-24';assert.equal(context.contextLabels([f],outcomes,10,'pair').length,0);
});
test('context learner trains only purged time splits and needs incremental validation; insufficient data stays waiting',()=>{
  assert.equal(context.trainContextModel([],[],10,'currency',at,1),null);
  const template=frame(),frames=[],outcomes=[];
  for(let i=0;i<130;i++){
    const time=new Date(Date.parse('2010-01-01')+i*32*day).toISOString(),label=i%2,f={...structuredClone(template),id:'f'+i,at:time,sourceReliability:1,regimeVerified:true,regime:i%3?'risk-on':'risk-off'};
    f.core=Object.fromEntries(data.currencies.map(c=>[c,.5]));f.hypotheses={a:Object.fromEntries(data.currencies.map(c=>[c,label?.9:.1]))};frames.push(f);
    for(const currency of data.currencies)outcomes.push({frameId:f.id,currency,horizon:10,asOf:time,label,entryDate:new Date(Date.parse(time)+day).toISOString().slice(0,10),labelEnd:new Date(Date.parse(time)+11*day).toISOString().slice(0,10),resolvedAt:new Date(Date.parse(time)+12*day).toISOString(),forwardReturn:label?.01:-.01});
  }
  const m=context.trainContextModel(frames,outcomes,10,'currency',at,1);assert.ok(m);assert.equal(m.weight,0);assert.ok(m.folds.length>=3);assert.ok(m.folds.every(f=>f.trainEnd<f.testStart));assert.deepEqual(m.recipeIds,['a']);assert.ok(m.gate&&m.incrementalGate);
  const future={...outcomes[0],frameId:'future',labelEnd:'2027-01-01'};assert.deepEqual(context.trainContextModel(frames,[...outcomes,future],10,'currency',at,1),m);
  assert.equal(context.trainContextModel(frames,outcomes.map(o=>({...o,resolvedAt:'2027-01-01T00:00:00Z'})),10,'currency',at,1),null);
  assert.equal(context.chooseContextChampions([m],[],frames,outcomes,at).length,0);
});
test('context allocation requires future shadow evidence and returns to zero after degradation',()=>{
  const template=frame(),frames=[],outcomes=[];
  const model={id:'context-fixture',version:context.CONTEXT_VERSION,horizon:10,scope:'currency',recipeIds:['a'],weights:{},trainedAt:'2019-12-01T00:00:00Z',trainingSamples:100,status:'SHADOW',gate:{passed:true},incrementalGate:{passed:true},weight:0,look:1,lastBlocks:0,lastChangedAt:'2019-12-01T00:00:00Z',folds:[]};
  for(let i=0;i<80;i++){
    const time=new Date(Date.parse('2020-01-01')+i*21*day).toISOString(),label=1;
    const candidate=i<40?(label?.9:.1):(label?.1:.9),regime=i%2?'risk-on':'risk-off';
    const f={...structuredClone(template),id:'shadow'+i,at:time,sourceReliability:1,regimeVerified:true,regime,contextPredictions:{[model.id]:{USD:{candidate,core:.5,ensemble:label?.6:.4,regime,inputVersion:context.CONTEXT_VERSION}}}};
    frames.push(f);outcomes.push({frameId:f.id,currency:'USD',horizon:10,asOf:time,label,entryDate:time.slice(0,10),labelEnd:new Date(Date.parse(time)+10*day).toISOString().slice(0,10),resolvedAt:new Date(Date.parse(time)+11*day).toISOString(),forwardReturn:label?.01:-.01});
  }
  assert.equal(context.advanceContextModel(model,frames,outcomes.map(o=>({...o,resolvedAt:'2027-01-01T00:00:00Z'})),at,1).weight,0);
  const active=context.advanceContextModel(model,frames.slice(0,40),outcomes.slice(0,40),at,1);assert.equal(active.status,'ACTIVE',JSON.stringify({gate:active.gate,incremental:active.incrementalGate}));assert.equal(active.weight,.005);assert.ok(active.gate.passed&&active.incrementalGate.passed);
  assert.equal(context.chooseContextChampions([active],[],frames,outcomes,at).length,1);
  const degraded=context.advanceContextModel(active,frames,outcomes,at,1);assert.equal(degraded.status,'DEGRADED');assert.equal(degraded.weight,0);assert.equal(context.chooseContextChampions([degraded],[model.id],frames,outcomes,at).length,0);
});
