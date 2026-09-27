import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,appType:'custom',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});
after(()=>vite.close());
const data=await vite.ssrLoadModule('/lib/terminal-data.ts');
const core=await vite.ssrLoadModule('/lib/model-engine.ts');
const ingest=await vite.ssrLoadModule('/lib/production-data.ts');
const evidence=await vite.ssrLoadModule('/lib/adaptive-evidence.ts');
const runtime=await vite.ssrLoadModule('/worker/production.ts');
const migration=await vite.ssrLoadModule('/worker/model-migration.ts');
const proxies=await vite.ssrLoadModule('/worker/proxy-discovery.ts');
const sentiment=await vite.ssrLoadModule('/lib/sentiment.ts');
const research=await vite.ssrLoadModule('/lib/production-research.ts');
const provenance=await vite.ssrLoadModule('/lib/hypothesis/provenance.ts');
const at='2026-09-27T18:00:00.000Z';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);
function sqlite(){const sql=new DatabaseSync(':memory:');for(const file of ['0000_hesitant_krista_starr.sql','0001_happy_mandroid.sql','0002_sudden_blazing_skull.sql'])sql.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));return {sql,db:{prepare(query){const statement=sql.prepare(query);let v=[];return {bind(...values){v=values;return this},async first(){return statement.get(...v)??null},async all(){return {results:statement.all(...v)}},async run(){return {meta:{changes:Number(statement.run(...v).changes)}}}}},async batch(rows){sql.exec('BEGIN');try{const result=[];for(const row of rows)result.push(await row.run());sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}}}};}

test('legacy settings migration archives the exact original and freezes once in the snapshot transaction',async()=>{
  const {db,sql}=sqlite(),original=data.getDefaultModelSettings();original.modelBlend=.63;
  sql.prepare('INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?)').run('model',JSON.stringify(original),at);
  const first=await migration.prepareModelMigration(db,data.getDefaultModelSettings(),at);
  assert.equal(sql.prepare("SELECT count(*) n FROM terminal_settings WHERE key='model:before-automatic-v1'").get().n,0);
  await db.batch(first.writes);
  const saved=JSON.parse(sql.prepare("SELECT value FROM terminal_settings WHERE key='model'").get().value);
  assert.equal(saved.forecastBaseline.version,'frozen-core-v1');
  assert.deepEqual(JSON.parse(sql.prepare("SELECT value FROM terminal_settings WHERE key='model:before-automatic-v1'").get().value).settings,original);
  assert.equal((await migration.prepareModelMigration(db,original,at)).writes.length,0);
  sql.close();
});

test('automatic qualification defaults open, invalid or explicit kill switches fail closed, shared cap is hard bounded',()=>{
  assert.deepEqual(runtime.configuration({}),{enabled:true,cap:.1,ml:true,hypothesis:true});
  for(const flag of ['ADAPTIVE_ENABLED','ML_ENABLED','HYPOTHESIS_ENGINE_ENABLED']){
    const key={ADAPTIVE_ENABLED:'enabled',ML_ENABLED:'ml',HYPOTHESIS_ENGINE_ENABLED:'hypothesis'}[flag];
    assert.equal(runtime.configuration({[flag]:'false'})[key],false);
    assert.equal(runtime.configuration({[flag]:'TRUE'})[key],true);
    assert.equal(runtime.configuration({[flag]:'invalid'})[key],false);
  }
  assert.equal(runtime.configuration({ADAPTIVE_MAX_WEIGHT:'9'}).cap,.15);
  assert.equal(runtime.configuration({ADAPTIVE_MAX_WEIGHT:'invalid'}).cap,0);
  const c=data.getBaselinePayload().currencies[0];
  const parts=['ML','HYPOTHESIS'].map(kind=>({id:kind,kind,score:.99,weight:1,confidence:1,regimeFit:1,sourceReliability:1,validated:true}));
  const a=evidence.combineEvidence(c,parts,{at,cap:1});assert.ok(a.mlWeight+a.hypothesisWeight<=.15);
  assert.equal(evidence.combineEvidence(c,parts.map(x=>({...x,validated:false})),{at}).finalEvidenceScore,evidence.coreEvidence(c));
});

test('Final Evidence reaches Strength, Pair, relative dominance and forecasts once, never the sentiment factor',()=>{
  const p=data.getBaselinePayload(),q=structuredClone(p),now=new Date().toISOString();
  const c=q.currencies.find(c=>c.code==='EUR'),previous=structuredClone(c),weights=structuredClone(data.factorMeta);
  const before=core.buildModelDistribution(p,data.currencies),oldPair=core.buildPairForecast(p,'EUR','USD');
  c.evidenceAttribution=evidence.combineEvidence(c,[{id:'validated-local-fixture',kind:'ML',score:.9,weight:.025,confidence:1,regimeFit:1,sourceReliability:1,validated:true}],{at:now});
  const shift=evidence.evidenceShift(c);assert.ok(shift>0);
  c.history[0]={...c.history[0],coreScore:evidence.coreEvidence(c),score:c.evidenceAttribution.finalEvidenceScore};
  near(data.strengthScore(c)-data.strengthScore(previous),shift);
  const usd=q.currencies.find(c=>c.code==='USD');near(data.pairScore(c,usd)-data.pairScore(previous,usd),2*shift);
  const after=core.buildModelDistribution(q,data.currencies);
  for(const point of after.points){const original=before.points.find(x=>x.id===point.id);
    const relativeShift=point.currency==='EUR'?shift:-shift/7;
    near(point.probability,1/(1+Math.exp(-(Math.log(original.probability/(1-original.probability))+7.4*relativeShift))));
  }
  near(after.estimates.find(x=>x.currency==='EUR').strength-before.estimates.find(x=>x.currency==='EUR').strength,shift);
  const finalPair=core.buildPairForecast(q,'EUR','USD');assert.notDeepEqual(finalPair,oldPair);
  c.history[0].score+=shift;assert.deepEqual(core.buildPairForecast(q,'EUR','USD'),finalPair);
  assert.deepEqual(c.factors,previous.factors);assert.deepEqual(data.factorMeta,weights);
  delete c.evidenceAttribution;assert.deepEqual(core.buildPairForecast(q,'EUR','USD'),oldPair);
});

test('LIVE requires all 80 current verified Core factors, annual windows count, carried and future inputs do not',()=>{
  const p=data.getBaselinePayload();p.asOf=at;p.coreFactors={};
  ingest.refreshSourceStatus(p,at);assert.equal(p.sourceMode,'baseline');
  for(const c of data.currencies)p.coreFactors[c]=Object.fromEntries(Object.keys(data.factorMeta).map(f=>[f,{status:'OBSERVED',availability:'FRESH',source:'test receipt',period:'2025',availableAt:at,inputs:[{metric:'growth',value:2,period:'2025',receivedAt:at,source:'test receipt'}]}]));
  ingest.refreshSourceStatus(p,at);assert.equal(p.sourceMode,'live');assert.equal(p.sourceCoverage.fresh,80);
  p.coreFactors.CAD.seasonality.status='LEGACY_OR_CARRIED';p.coreFactors.CAD.seasonality.availability='CARRIED INPUT';
  ingest.refreshSourceStatus(p,at);assert.equal(p.sourceMode,'partial-live');
  p.coreFactors.CAD.seasonality.status='OBSERVED';p.coreFactors.CAD.seasonality.availability='FRESH';p.coreFactors.CAD.seasonality.inputs[0].receivedAt='2026-10-01T00:00:00Z';
  ingest.refreshSourceStatus(p,at);assert.equal(p.sourceMode,'partial-live');assert.equal(p.coreFactors.CAD.seasonality.availability,'STALE');
  ingest.refreshSourceStatus(p,'2030-01-01T00:00:00Z');assert.equal(p.sourceMode,'baseline');
});

test('metadata discovery defines economic channels and sparse annual features without invented currency peers',()=>{
  const indicator={id:'NEW.EXPORT.VOLUME',name:'New export product volume',sourceNote:'Export production volume in provider units',unit:'tonnes',source:{id:'2'},version:'fixture-v2',normalization:'annual-symmetric-change-v2'};
  assert.equal(proxies.proxyCandidates([indicator,{...indicator,name:'Unexplained identifier',sourceNote:'No economic mechanism'}]).length,1);
  const values=[{countryiso3code:'CAN',date:'2025',value:120},{countryiso3code:'CAN',date:'2024',value:100},{countryiso3code:'CAN',date:'2027',value:9999}];
  const rows=proxies.parseProxyRows(values,indicator,at,'https://api.worldbank.org/');
  assert.equal(rows.length,1);assert.equal(rows[0].currency,'CAD');near(rows[0].normalizedValue,40/220);
  assert.equal(rows[0].receivedAt,at);assert.equal(rows[0].releaseDate,null);assert.equal(rows[0].rawInputs.length,2);
  const payload=data.getBaselinePayload();payload.asOf=at;
  const frame=research.buildResearchFrame(payload,rows);assert.equal(frame.features.CAD[rows[0].metric],rows[0].normalizedValue);assert.equal(frame.features.USD[rows[0].metric],undefined);
  const recipes=research.discoverRecipes([],frame);assert.ok(recipes.some(r=>r.feature===rows[0].metric&&r.weight===0&&r.rationale.includes('Null hypothesis')));
  assert.equal(proxies.parseProxyRows(values.slice(0,1),indicator,at,'https://api.worldbank.org/').length,0);
  assert.equal(proxies.parseProxyRows(values,{...indicator,normalization:undefined},at,'https://api.worldbank.org/').length,0);
});

test('RSS modification time is never substituted for publication; SNB DC dates are read',()=>{
  const feed=sentiment.centralBankFeeds.find(f=>f.currency==='CHF');assert.ok(feed);
  const rows=sentiment.extractFeedItems('<rss><item><title>Actual publication</title><dc:date>2026-09-24T08:00:00Z</dc:date></item><entry><title>Undated original</title><updated>2026-09-27T10:00:00Z</updated></entry></rss>',feed);
  assert.equal(rows[0].publishedAt,'2026-09-24T08:00:00.000Z');assert.equal(rows[1].publishedAt,null);
  assert.equal(sentiment.aggregateTextSignals(rows,new Date(at)).sampleCount,1);
});

test('retired UI controls and old pair overlay cannot write or double apply production weights',()=>{
  const dashboard=readFileSync(new URL('../components/terminal-dashboard.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(dashboard,/Feste Basis-Gewichtung|setDraftModel|applyPairOverlay|applyHypothesisOverlay|modelBlend/);
  const worker=readFileSync(new URL('../worker/index.ts',import.meta.url),'utf8');assert.doesNotMatch(worker,/integrateResponse/);
  const settings=readFileSync(new URL('../app/api/settings/route.ts',import.meta.url),'utf8');assert.match(settings,/AUTOMATIC_VALIDATION_ONLY/);assert.doesNotMatch(settings,/\.insert\(/);
});

test('daily runtime qualifies a shadow model from frozen future predictions and read guards revoke degraded components',async()=>{
  const {db,sql}=sqlite(),day=86400000,now=new Date().toISOString();
  const p=data.getBaselinePayload();p.asOf=now;p.regime.label='risk-on';
  p.coreFactors=Object.fromEntries(data.currencies.map(c=>[c,{momentum:{status:'OBSERVED',availability:'FRESH',source:'ECB reference fixing',period:now.slice(0,10),availableAt:now}}]));
  p.sourceChecks=[{at:now,source:'ECB reference fixing',url:'https://www.ecb.europa.eu/',currency:'ALL',metrics:['fxReferenceUsd','momentum'],status:'SUCCESS',cause:null,fallback:'none',latencyMs:0},{at:now,source:'FRED',url:'https://fred.stlouisfed.org/',currency:'GLOBAL',metrics:['vix'],status:'SUCCESS',cause:null,fallback:'none',latencyMs:0}];
  const obs=Array.from({length:70},(_,i)=>data.currencies.map((currency,j)=>({currency,metric:'fxReferenceUsd',value:currency==='USD'?1:1+j*.1+i*.001,period:new Date(Date.parse(now)-(70-i)*day).toISOString().slice(0,10),receivedAt:now,source:'ECB reference fixing',sourceUrl:'https://www.ecb.europa.eu/',unit:'USD per currency',releaseDate:null,quality:'VALID',frequency:'business-daily'}))).flat();
  obs.push({currency:'GLOBAL',metric:'vix',value:15,period:now.slice(0,10),receivedAt:now,source:'FRED',sourceUrl:'https://fred.stlouisfed.org/',quality:'VALID',releaseDate:null,unit:'index',frequency:'daily'});
  const start=new Date(Date.parse(now)-1000*day).toISOString(),model={id:'local-runtime-shadow-fixture',horizon:10,version:ingest.DATA_VERSION,trainedAt:start,shadowStartedAt:start,lastChangedAt:start,weights:data.getDefaultModelSettings().expertWeights,trainingSamples:1000,status:'SHADOW',gate:{passed:true},weight:0,look:1,lastBlocks:0,featureKeys:['momentum'],featureRange:{momentum:[-1,1]},folds:[]};
  const save=async(kind,id,time,body)=>sql.prepare('INSERT INTO production_records (id,kind,at,version,payload) VALUES (?,?,?,?,?)').run(id,kind,time,research.RESEARCH_VERSION,JSON.stringify({...body,digest:await provenance.digest(body)}));
  for(let i=0;i<40;i++){
    const time=new Date(Date.parse(start)+(1+i*22)*day).toISOString(),labelEnd=new Date(Date.parse(time)+11*day).toISOString().slice(0,10);
    const frame=research.buildResearchFrame(p,obs);Object.assign(frame,{id:'local-frame-'+i,at:time,quality:'VALID',sourceReliability:1,regimeVerified:true,regime:i%2?'risk-on':'risk-off',ml:{[model.id]:Object.fromEntries(data.currencies.map(c=>[c,.9]))}});
    await save('frame',frame.id,time,frame);
    for(const currency of data.currencies){const o={frameId:frame.id,currency,horizon:10,asOf:time,labelEnd,resolvedAt:new Date(Date.parse(time)+12*day).toISOString(),label:1,core:.5,regime:frame.regime};await save('outcome:10','local-label-'+i+currency,o.resolvedAt,o);}
  }
  sql.prepare('INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?)').run('production:v2:state',JSON.stringify({at:now,models:[model],trainingSequence:1}),now);
  await (await runtime.prepareProductionSnapshot({DB:db},p,obs)).commit();
  const row=sql.prepare("SELECT value FROM terminal_settings WHERE key='production:v2:state'").get();const active=JSON.parse(row.value);
  assert.equal(active.models[0].status,'ACTIVE');assert.equal(active.models[0].gate.passed,true);assert.ok(p.currencies.some(c=>c.evidenceAttribution.mlWeight>0));
  assert.ok((await runtime.productionHealth({DB:db})).mlInfluence>0);
  active.models[0].status='DEGRADED';active.models[0].weight=0;sql.prepare("UPDATE terminal_settings SET value=? WHERE key='production:v2:state'").run(JSON.stringify(active));
  await runtime.guardProductionPayload({DB:db},p);assert.ok(p.currencies.every(c=>evidence.evidenceShift(c)===0));
  assert.equal((await runtime.productionHealth({DB:db})).mlInfluence,0);sql.close();
});
