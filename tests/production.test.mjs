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
const research=await vite.ssrLoadModule('/lib/production-research.ts');
const runtime=await vite.ssrLoadModule('/worker/production.ts');
const sourceHealth=await vite.ssrLoadModule('/lib/source-health.ts');
const proxies=await vite.ssrLoadModule('/worker/proxy-discovery.ts');
const at='2026-01-01T17:00:00.000Z',day=86400000;
function sqlite(){const sql=new DatabaseSync(':memory:');for(const file of ['0000_hesitant_krista_starr.sql','0001_happy_mandroid.sql','0002_sudden_blazing_skull.sql'])sql.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));return {sql,db:{prepare(query){const statement=sql.prepare(query);let v=[];return {bind(...values){v=values;return this},async first(){return statement.get(...v)??null},async all(){return {results:statement.all(...v)}},async run(){return {meta:{changes:Number(statement.run(...v).changes)}}}}},async batch(rows){sql.exec('BEGIN');try{const result=[];for(const row of rows)result.push(await row.run());sql.exec('COMMIT');return result}catch(e){sql.exec('ROLLBACK');throw e}}}};}
function observations(end=at,n=70){return Array.from({length:n},(_,i)=>data.currencies.map((currency,j)=>({currency,metric:'fxReferenceUsd',value:currency==='USD'?1:1+j*.1+i*.002*(j%2?1:-1),period:new Date(Date.parse(end)-(n-i)*day).toISOString().slice(0,10),receivedAt:end,source:'ECB reference fixing',sourceUrl:'https://www.ecb.europa.eu/',unit:'USD per currency',releaseDate:null,quality:'VALID',frequency:'business-daily'}))).flat();}
function payload(now=at){const p=data.getBaselinePayload();p.asOf=now;p.sourceMode='partial-live';p.sourceChecks=[{at:now,source:'ECB reference fixing',url:'https://www.ecb.europa.eu/',currency:'ALL',metrics:['fxReferenceUsd'],status:'SUCCESS',cause:null,fallback:'none',latencyMs:1}];ingest.repairDerivedScores(p);return p;}
test('versioned raw plumbing is idempotent, directional and does not mutate legacy forecast with zero influence',()=>{
  const untouched=data.getBaselinePayload(),mutated=data.getBaselinePayload();mutated.currencies[0].factors.risk=.01;assert.deepEqual(data.getBaselinePayload(),untouched);
  const p=payload();const first=structuredClone(p);ingest.repairDerivedScores(p);assert.deepEqual(p,first);
  const old=data.getBaselinePayload(),zero=structuredClone(old);for(const c of zero.currencies)c.evidenceAttribution=evidence.combineEvidence(c,[],{at});
  assert.deepEqual(core.buildModelDistribution(old,data.currencies),core.buildModelDistribution(zero,data.currencies));
  for(const a of data.currencies)for(const b of data.currencies)assert.deepEqual(core.buildPairForecast(old,a,b),core.buildPairForecast(zero,a,b));
  const eur=p.currencies.find(c=>c.code==='EUR'),before=eur.factors.policy;eur.rate+=.25;ingest.repairDerivedScores(p);assert.ok(eur.factors.policy>before);
  const beforeY=eur.factors.yields;eur.yield2y+=.25;ingest.repairDerivedScores(p);assert.ok(eur.factors.yields>beforeY);
});
test('ECB reference conversion is exact, all majors and USD included; partial/future data rejected',()=>{
  const xml=`<Cube time='2026-01-01'>${data.currencies.filter(c=>c!=='EUR').map((c,i)=>`<Cube currency='${c}' rate='${c==='USD'?2:i+3}'/>`).join('')}</Cube>`;
  const rows=ingest.parseEcbRates(xml,at);assert.equal(rows.length,8);assert.equal(rows.find(r=>r.currency==='EUR').value,2);assert.equal(rows.find(r=>r.currency==='USD').value,1);assert.equal(rows.find(r=>r.currency==='GBP').value,2/4);
  assert.equal(ingest.parseEcbRates(xml,'2025-12-31T00:00:00Z').length,0);assert.equal(ingest.parseEcbRates("<Cube time='2026-01-01'><Cube currency='USD' rate='1'/></Cube>",at).length,0);
});
test('vintages retain first availability and revisions without deleting old observations',async()=>{
  const {sql,db}=sqlite(),o=observations()[0];await runtime.archiveObservations(db,[o],at);await runtime.archiveObservations(db,[{...o,receivedAt:'2026-01-02T00:00:00Z'}],'2026-01-02T00:00:00Z');assert.equal(sql.prepare('SELECT count(*) n FROM observation_vintages').get().n,1);
  await runtime.archiveObservations(db,[{...o,value:o.value+1,receivedAt:'2026-01-03T00:00:00Z'}],'2026-01-03T00:00:00Z');assert.equal(sql.prepare('SELECT count(*) n FROM observation_vintages').get().n,2);assert.equal(sql.prepare('SELECT value FROM observation_vintages ORDER BY received_at LIMIT 1').get().value,o.value);sql.close();
});
test('prospective features and future targets never backdate availability or mix vintages',()=>{
  const f=research.buildResearchFrame(payload(),observations());assert.equal(f.quality,'VALID');assert.equal(Object.keys(f.features).length,8);assert.ok(f.volatility.USD>0);assert.equal(research.currencyPairs(f).length,28);
  const future=observations('2026-02-01T17:00:00Z',110);assert.equal(research.resolveFrameTargets(f,future,at).length,0);
  const outcomes=research.resolveFrameTargets(f,future,'2026-02-02T17:00:00Z');assert.ok(outcomes.length>0);assert.ok(outcomes.every(o=>o.entryDate>f.at.slice(0,10)&&o.labelEnd<'2026-02-02'&&o.resolvedAt>o.labelEnd));assert.ok(outcomes.some(o=>o.currency==='USD'));
});
test('adaptive arithmetic has one cap, exact attribution and fail-closed stale/NaN gates',()=>{
  const p=payload(),c=p.currencies[0],now=new Date().toISOString();
  const parts=['ML','HYPOTHESIS'].map((kind,i)=>({id:String(i),kind,score:i?.05:.95,weight:.3,confidence:1,regimeFit:1,sourceReliability:1,validated:true}));
  const a=evidence.combineEvidence(c,parts,{at:now,cap:.1});assert.ok(a.mlWeight+a.hypothesisWeight<=.1+1e-12);assert.equal(a.coreEvidenceScore+a.mlContribution+a.hypothesisContribution,a.finalEvidenceScore);
  c.evidenceAttribution=a;assert.equal(evidence.evidenceShift(c),a.mlContribution+a.hypothesisContribution);a.expiresAt='bad';assert.equal(evidence.evidenceShift(c),0);assert.equal(evidence.combineEvidence(c,parts,{at:now,enabled:false}).finalEvidenceScore,evidence.coreEvidence(c));
  parts[0].score=NaN;assert.ok(Number.isFinite(evidence.combineEvidence(c,parts,{at:now}).finalEvidenceScore));
});
function samples(n,start='2020-01-01',horizon=1,bad=false){return Array.from({length:n},(_,i)=>({asOf:new Date(Date.parse(start)+i*(horizon+4)*day).toISOString(),labelEnd:new Date(Date.parse(start)+(i*(horizon+4)+horizon+1)*day).toISOString().slice(0,10),pair:'EUR',probability:bad?.48:.52,candidate:bad?.1:.9,baseline:.5,label:1,regime:i%2?'risk-on':'risk-off',pointInTimeVerified:true}));}
test('hypothesis lifecycle requires frozen holdout, then new shadow; collapse zeroes weight',()=>{
  const f=research.buildResearchFrame(payload(),observations());let r=research.discoverRecipes([],f)[0];r={...r,horizon:1};
  assert.equal(research.advanceRecipe(r,samples(119),128,'2022-01-01T00:00:00Z').weight,0);
  r=research.advanceRecipe(r,samples(120),128,'2022-01-01T00:00:00Z');assert.equal(r.status,'SHADOW');assert.equal(r.weight,0);
  r=research.advanceRecipe(r,[...samples(120),...samples(40,'2022-01-02')],128,'2023-01-01T00:00:00Z');assert.equal(r.status,'ACTIVE');assert.ok(r.weight<=.005);
  const bad=research.advanceRecipe(r,[...samples(120),...samples(100,'2022-01-02',1,true)],128,'2024-01-01T00:00:00Z');assert.equal(bad.weight,0);assert.equal(bad.status,'DEGRADED');
  assert.equal(research.validationGate(samples(15),1,128,1).passed,false);assert.ok(research.validationGate(samples(15),1,128,10).adjustedP>=research.validationGate(samples(15),1,1,1).adjustedP);
});
test('fresh snapshot persistence, immutable labels and weekly waiting work through SQLite',async()=>{
  const {db,sql}=sqlite();const env={DB:db};const p=payload();await (await runtime.prepareProductionSnapshot(env,p,observations())).commit();
  assert.equal(sql.prepare("SELECT count(*) n FROM production_records WHERE kind='frame'").get().n,1);assert.ok(p.currencies.every(c=>c.evidenceAttribution.finalEvidenceScore===c.evidenceAttribution.coreEvidenceScore));
  const first=sql.prepare("SELECT payload FROM production_records WHERE kind='frame'").get().payload;
  const later='2026-01-20T17:00:00.000Z';await (await runtime.prepareProductionSnapshot(env,payload(later),observations(later,90))).commit();
  const count=sql.prepare("SELECT count(*) n FROM production_records WHERE kind LIKE 'outcome:%'").get().n;assert.ok(count>0);const outcome=sql.prepare("SELECT payload FROM production_records WHERE kind LIKE 'outcome:%' LIMIT 1").get().payload;
  await (await runtime.prepareProductionSnapshot(env,payload(later),observations(later,90).map(o=>({...o,value:o.value*1.01})))).commit();
  assert.equal(sql.prepare("SELECT payload FROM production_records WHERE kind='frame' ORDER BY at LIMIT 1").get().payload,first);assert.equal(sql.prepare("SELECT payload FROM production_records WHERE kind LIKE 'outcome:%' LIMIT 1").get().payload,outcome);
  const result=await runtime.productionRetrain(env,later);assert.equal(result.status,'waiting');assert.equal(sql.prepare("SELECT count(*) n FROM terminal_settings WHERE key='model'").get().n,0);assert.equal(sql.prepare("SELECT count(*) n FROM production_records WHERE kind='retrain'").get().n,1);
  const kill=await runtime.guardProductionPayload({...env,ADAPTIVE_ENABLED:'false'},p);assert.ok(kill.currencies.every(c=>!c.evidenceAttribution));
  sql.prepare("UPDATE production_records SET payload=json_set(payload,'$.label',9) WHERE kind LIKE 'outcome:%'").run();await assert.rejects(runtime.productionRetrain(env,later),/INTEGRITY/);sql.close();
});
test('snapshot publication is atomic and a failed publication leaves no training frame or lifecycle update',async()=>{
  const {db,sql}=sqlite();const prepared=await runtime.prepareProductionSnapshot({DB:db},payload(),observations());
  assert.equal(sql.prepare("SELECT count(*) n FROM production_records WHERE kind='frame'").get().n,0);
  sql.exec("CREATE TRIGGER reject_snapshot BEFORE INSERT ON terminal_snapshots BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  await assert.rejects(prepared.commit(),/fixture failure/);
  assert.equal(sql.prepare("SELECT count(*) n FROM production_records WHERE kind='frame'").get().n,0);
  assert.equal(sql.prepare("SELECT count(*) n FROM terminal_settings WHERE key='production:v2:state'").get().n,0);sql.close();
});
test('walk-forward trains a frozen challenger on purged past labels; no automatic champion replacement without common OOS evidence',()=>{
  const frames=[],outcomes=[];
  for(let i=0;i<150;i++){
    const time=new Date(Date.parse('2008-01-01')+i*41*day).toISOString(),label=i%2;
    const f=research.buildResearchFrame(payload(time),observations(time));f.sourceReliability=1;f.regimeVerified=true;f.regime=i%3?'risk-on':'risk-off';
    for(const c of data.currencies){f.features[c]={'factor.momentum':label?.8:-.8};f.core[c]=label?.3:.7;outcomes.push({frameId:f.id,currency:c,horizon:10,asOf:time,labelEnd:new Date(Date.parse(time)+11*day).toISOString().slice(0,10),label,core:f.core[c],regime:f.regime});}frames.push(f);
  }
  const now=new Date(Date.parse(frames.at(-1).at)+30*day).toISOString();
  const candidate=research.trainChallenger(frames,outcomes,10,now,1);
  assert.ok(candidate);assert.equal(candidate.status,'SHADOW');assert.equal(candidate.weight,0);assert.ok(candidate.folds.length>=3);assert.ok(candidate.folds.every(f=>f.trainEnd<f.testStart));
  const champion={...candidate,id:'incumbent',status:'ACTIVE',gate:{...candidate.gate,passed:true},weight:.005};
  const competitor={...champion,id:'challenger',gate:{...champion.gate,improvement:1}};
  assert.equal(research.chooseChampions([champion,competitor],['incumbent'],frames,outcomes,now)[0].id,'incumbent');
  assert.equal(research.chooseChampions([{...champion,status:'DEGRADED'},competitor],['incumbent'],frames,outcomes,now)[0].id,'challenger');
  assert.equal(research.modelInDistribution(candidate,frames[0],'USD'),true);delete frames[0].features.USD['factor.momentum'];assert.equal(research.modelInDistribution(candidate,frames[0],'USD'),false);
});
test('source quality, outliers, stale data, redundancy and recipe identity fail closed',()=>{
  assert.equal(ingest.observationQuality('rate',NaN,'2026',at),'INVALID');assert.equal(ingest.observationQuality('unemployment',102,'2025',at),'INVALID');assert.equal(ingest.observationQuality('growth',2,'2019',at),'STALE');
  const good={at,source:'ECB reference fixing',url:'https://www.ecb.europa.eu/',currency:'ALL',metrics:['fxReferenceUsd'],status:'SUCCESS',cause:null,fallback:'none',latencyMs:20};
  assert.ok(sourceHealth.sourceReliability([good],[[good]])[good.source].score>.99);assert.equal(sourceHealth.sourceReliability([{...good,status:'FAILED'}],[[good]])[good.source].score,0);
  const p=payload(),rows=observations();rows.at(-1).value*=100;assert.equal(research.buildResearchFrame(p,rows).quality,'WAITING_FOR_PRICES');
  const f=research.buildResearchFrame(p,observations()),recipes=research.discoverRecipes([],f);const again=research.discoverRecipes(recipes,f);assert.equal(new Set(again.map(r=>r.id)).size,again.length);assert.equal(again[0].id,recipes[0].id);
  const qualified=recipes.slice(0,2).map((r,i)=>({...r,feature:'same',status:'ACTIVE',gate:{improvement:2-i}}));assert.equal(research.nonRedundant(qualified,[f]).length,1);
  assert.equal(proxies.proxyCandidates([{id:'NEW.PROXY',name:'Unusual freight index',sourceNote:'Provider definition',unit:'index',source:{id:'2'}}]).length,1);
});
test('health reports zero effective influence immediately when killed or expired',async()=>{
  const {db,sql}=sqlite();const p=payload(new Date().toISOString());await (await runtime.prepareProductionSnapshot({DB:db},p,observations(p.asOf))).commit();
  const health=await runtime.productionHealth({DB:db,ADAPTIVE_ENABLED:'false'});assert.equal(health.mlInfluence,0);assert.equal(health.hypothesisInfluence,0);assert.equal(health.status,'CORE_FALLBACK');assert.equal(health.snapshotCount,1);sql.close();
});
test('read boundary does not revive stale or changed-input attribution through recombination',async()=>{
  const {db,sql}=sqlite();const p=payload(new Date().toISOString());await (await runtime.prepareProductionSnapshot({DB:db},p,observations(p.asOf))).commit();
  p.currencies[0].evidenceAttribution.expiresAt='2020-01-01T00:00:00Z';p.currencies[1].factors.momentum=.999;
  await runtime.guardProductionPayload({DB:db},p);assert.equal(p.currencies[0].evidenceAttribution,undefined);assert.equal(p.currencies[1].evidenceAttribution,undefined);sql.close();
});
test('source qualification follows actual feature dependencies, not unrelated failed provider metrics',()=>{
  const p=payload();p.coreFactors=Object.fromEntries(data.currencies.map(c=>[c,{growth:{status:'OBSERVED',source:'World Bank Open Data'}}]));
  const success=(source,metric)=>({at,source,url:'https://example.org',currency:'ALL',metrics:[metric],status:'SUCCESS',cause:null,fallback:'none',latencyMs:1});
  p.sourceChecks.push(success('World Bank Open Data','growth'),success('World Bank Open Data','unemployment'),success('FRED','vix'),{...success('World Bank Open Data','debt'),status:'FAILED'});
  const f=research.buildResearchFrame(p,observations());assert.equal(f.sourceReliability,1);assert.equal(research.researchSourceChecks(f,p.sourceChecks).some(c=>c.metrics.includes('debt')),false);
  p.sourceChecks.find(c=>c.metrics.includes('growth')).status='FAILED';assert.ok(research.buildResearchFrame(p,observations()).sourceReliability<1);
});
test('historical Evidence is evaluated at its issue time, not reinterpreted after attribution expires',()=>{
  const previous=payload(at),c=previous.currencies[0];c.evidenceAttribution=evidence.combineEvidence(c,[{id:'fixture',kind:'ML',score:.9,weight:.02,confidence:1,regimeFit:1,sourceReliability:1,validated:true}],{at});
  const next=payload('2026-01-11T17:00:00.000Z');ingest.historicalScores(next,[previous]);assert.equal(next.currencies[0].history.find(h=>h.ageDays===10).score,c.evidenceAttribution.finalEvidenceScore);
});
