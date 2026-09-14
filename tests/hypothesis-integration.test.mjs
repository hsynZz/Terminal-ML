import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,appType:'custom',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});
after(()=>vite.close());
const data=await vite.ssrLoadModule('/lib/terminal-data.ts');
const model=await vite.ssrLoadModule('/lib/model-engine.ts');
const proof=await vite.ssrLoadModule('/lib/hypothesis/provenance.ts');
const engine=await vite.ssrLoadModule('/lib/hypothesis/engine.ts');
const adapter=await vite.ssrLoadModule('/lib/hypothesis/adapter.ts');
const integration=await vite.ssrLoadModule('/worker/hypothesis-integration.ts');
const outcomes=await vite.ssrLoadModule('/worker/hypothesis-outcomes.ts');
const at='2026-09-14T15:20:00.000Z';
const on={enabled:true,requestedWeight:.05};
const payload=()=>({...data.getBaselinePayload(),asOf:at,sourceMode:'partial-live'});
function receipt(p,currency,metric,receivedAt=at){return {currency,metric,value:p.currencies.find(c=>c.code===currency)[metric],period:'2025',source:'Synthetic fixture',receivedAt};}
function sqlite(){
  const sql=new DatabaseSync(':memory:');sql.exec('CREATE TABLE terminal_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)');
  const db={prepare(query){const s=sql.prepare(query);let values=[];return {bind(...v){values=v;return this},async first(){return s.get(...values)??null},async all(){return {results:s.all(...values)}},async run(){return {meta:{changes:Number(s.run(...values).changes)}}}}},async batch(stmts){sql.exec('BEGIN');try{const r=[];for(const s of stmts)r.push(await s.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};
  return {sql,db};
}
function rows(n=120,start=2000,probability=.55){return Array.from({length:n},(_,i)=>({asOf:new Date(Date.UTC(start,0,1+i*40)).toISOString(),
  labelEnd:new Date(Date.UTC(start,0,12+i*40)).toISOString().slice(0,10),pair:'EUR/USD',probability,baseline:.5,label:1,regime:i%2?'risk-on':'risk-off'}));}
function qualified(){
  const h=engine.factory(at)[0],history=engine.historicalTest(rows(),10,'synthetic-only');
  const shadow=engine.evaluate(engine.independentBlocks(rows(40),10),2);
  return {...h,status:'VALIDATED',pointInTimeVerified:true,qualificationVersion:proof.PROVENANCE_VERSION,historical:history.historical,
    shadow,look:2,lastEvidenceAt:at,lastEvaluation:at};
}
function frame(h,baseline=.5){return {issuedAt:at,recordedAt:at,origin:'PROSPECTIVE_CAPTURE',snapshotAsOf:at,regime:'risk-on',sourceMode:'partial-live',
  factors:{},signals:[{id:h.id,pair:'EUR/USD',horizon:h.horizon,signal:1,probability:.54,baseline,phase:'SHADOW',regime:'risk-on',pointInTimeVerified:true}],pointInTimeVerified:true};}

test('provenance records retrieval time, retains unknown factors and leaves every core output unchanged',async()=>{
  const p=payload(),before=structuredClone(p);
  const receipts=p.currencies.flatMap(c=>['growth','unemployment','inflation'].map(k=>receipt(p,c.code,k)));
  const lineage=await proof.captureProvenance(p,undefined,receipts);
  assert.deepEqual(p,before);assert.ok(await proof.verifyProvenance(lineage));
  assert.equal(lineage.inputs['EUR:growth'].availableAt,at);assert.equal(lineage.inputs['EUR:growth'].period,'2025');
  assert.equal(lineage.factors['EUR:growth'].verified,true);
  assert.equal(lineage.factors['EUR:inflation'].verified,false); // missing rate
  assert.equal(lineage.factors['USD:yields'].verified,false); // raw yields are not this normalized factor
  assert.equal(lineage.regimeVerified,false); // legacy half of risk is still unknown
  const augmented={...p,inputProvenance:lineage};
  assert.deepEqual(model.buildModelDistribution(augmented,data.currencies),model.buildModelDistribution(before,data.currencies));
  for(const a of data.currencies)for(const b of data.currencies.filter(c=>c!==a))assert.deepEqual(model.buildPairForecast(augmented,a,b),model.buildPairForecast(before,a,b));
});
test('future receipts, changed values and corrupted certificates cannot qualify a factor',async()=>{
  const p=payload(),receipts=p.currencies.flatMap(c=>['growth','unemployment'].map(k=>receipt(p,c.code,k)));
  const lineage=await proof.captureProvenance(p,undefined,receipts);
  const f={...frame(qualified()),factors:Object.fromEntries(p.currencies.map(c=>[c.code,c.factors])),provenance:lineage};
  assert.equal(proof.inputVerified(f,'EUR','growth'),true);
  assert.equal(proof.inputVerified({...f,issuedAt:'2026-09-13T00:00:00Z'},'EUR','growth'),false);
  assert.equal(proof.signalProvenance(qualified(),f,[],'EUR'),false);
  const bad=structuredClone(lineage);bad.inputs['EUR:growth'].value+=1;
  assert.equal(await proof.verifyProvenance(bad),false);
  const future=await proof.captureProvenance(p,undefined,receipts.map(r=>({...r,receivedAt:'2026-10-01T00:00:00Z'})));
  assert.equal(future.factors['EUR:growth'].verified,false);
  const tomorrow={...p,asOf:'2026-09-15T15:20:00.000Z'};
  const carried=await proof.captureProvenance(tomorrow,{...p,inputProvenance:lineage},[]);
  assert.equal(carried.inputs['EUR:growth'].status,'CARRIED');assert.equal(carried.inputs['EUR:growth'].availableAt,at);
  const corrupt=await proof.captureProvenance(tomorrow,{...p,inputProvenance:bad},[]);
  assert.equal(corrupt.factors['EUR:growth'].verified,false);
});
test('completed outcomes are insert-only across provider revisions and corruption fails closed',async()=>{
  const {sql,db}=sqlite(),h=qualified(),f=frame(h);
  f.issuedAt='2026-08-01T12:00:00Z';
  const closes=[{currency:'EUR',period:'2026-08-02',value:1},{currency:'EUR',period:'2026-08-12',value:1.1}];
  const first=await outcomes.archiveOutcomes(db,[f],closes,at);
  assert.equal(first.length,1);assert.equal(first[0].label,1);assert.equal(first[0].exitPrice,1.1);
  const second=await outcomes.archiveOutcomes(db,[f],[closes[0],{...closes[1],value:.9}],'2026-09-15T15:20:00Z');
  assert.deepEqual(second,first);assert.equal(sql.prepare('SELECT COUNT(*) n FROM terminal_settings').get().n,1);
  const bad={...first[0],label:0};sql.prepare('UPDATE terminal_settings SET value=?').run(JSON.stringify(bad));
  await assert.rejects(outcomes.archiveOutcomes(db,[f],closes,at),/OUTCOME_INTEGRITY_FAILURE/);
});
test('qualified lifecycle requires certified frozen history followed by genuinely prospective shadow',()=>{
  let h=engine.factory('1999-01-01T00:00:00Z')[0];
  const historyRows=rows(),frames=historyRows.map(r=>({...frame(h),issuedAt:r.asOf,recordedAt:r.asOf,signals:[{...frame(h).signals[0],phase:'RESEARCH',probability:r.probability,regime:r.regime}]}));
  const ledger=historyRows.map(r=>({...r,horizon:10}));
  const uncertified=frames.map(f=>({...f,signals:f.signals.map(s=>({...s,pointInTimeVerified:false}))}));
  assert.equal(engine.advance(h,uncertified,[],'2015-01-01T00:00:00Z','fixture',ledger).status,'INSUFFICIENT_DATA');
  h=engine.advance(h,frames,[],'2015-01-01T00:00:00Z','fixture',ledger);
  assert.equal(h.status,'SHADOW');assert.equal(h.weight,0);
  const shadowRows=rows(40,2016),shadowFrames=shadowRows.map(r=>({...frame(h),issuedAt:r.asOf,recordedAt:r.asOf,
    signals:[{...frame(h).signals[0],phase:'SHADOW',probability:r.probability,regime:r.regime}]}));
  const allLedger=[...ledger,...shadowRows.map(r=>({...r,horizon:10}))];
  assert.equal(engine.advance(h,[...frames,...shadowFrames.map(f=>({...f,origin:'ARCHIVED_SNAPSHOT'}))],[],'2022-01-01T00:00:00Z','fixture',allLedger).status,'SHADOW');
  const next=engine.advance(h,[...frames,...shadowFrames],[],'2022-01-01T00:00:00Z','fixture',allLedger);
  assert.equal(next.status,'VALIDATED');assert.equal(next.weight,0);
});
test('allocation starts small, grows once per new look, and deactivates on lost edge, stale proof or kill switch',()=>{
  const h=qualified(),first=adapter.allocation(h,h,on,at);
  assert.equal(first.weight,.005);assert.equal(first.status,'PRODUCTION');
  const next={...first,look:3,shadow:{...first.shadow,blocks:50,alpha:engine.alphaFor(3)}};
  const grown=adapter.allocation(next,first,on,at);assert.equal(grown.weight,.006);
  assert.equal(adapter.allocation(grown,grown,on,at).weight,.006);
  const weak={...grown,look:4,shadow:{...grown.shadow,blocks:2000,stability:.55,alpha:engine.alphaFor(4)}};
  const reduced=adapter.allocation(weak,grown,on,at);assert.equal(reduced.weight,.003);assert.equal(reduced.status,'DEGRADED');
  assert.equal(adapter.allocation(reduced,reduced,on,at).weight,.003);
  assert.equal(adapter.allocation({...grown,shadow:{...grown.shadow,improvement:0}},grown,on,at).weight,0);
  assert.equal(adapter.allocation({...grown,lastEvidenceAt:'2020-01-01'},grown,on,at).weight,0);
  assert.equal(adapter.allocation(grown,grown,{enabled:false,requestedWeight:.05},at).weight,0);
  assert.equal(adapter.allocation(grown,grown,{enabled:true,requestedWeight:0},at).weight,0);
  assert.equal(adapter.allocation({...grown,qualificationVersion:undefined},grown,on,at).weight,0);
  assert.equal(adapter.allocation({...grown,shadow:{...grown.shadow,alpha:.9}},grown,on,at).weight,0);
});
test('production mapping is bounded, horizon-specific, deduplicated and preserves confidence',()=>{
  const original=qualified(),h=adapter.allocation(original,original,on,at),p=payload(),core=model.buildPairForecast(p,'EUR','USD');
  const f=frame(h,core[0].probability),overlay=adapter.buildOverlay([h,{...h,id:'z-copy'}],f,on,at);
  assert.equal(overlay.items.length,1);
  const adjusted=adapter.applyPairOverlay(core,'EUR/USD',at,overlay,at);
  assert.notEqual(adjusted,core);assert.equal(adjusted[0].hypothesis.weight,.005);
  assert.ok(Math.abs(adjusted[0].probability-core[0].probability)<=.025);
  assert.equal(adjusted[0].confidence,core[0].confidence);assert.equal(adjusted[1],core[1]);
  assert.ok(adjusted[0].low<=adjusted[0].probability&&adjusted[0].high>=adjusted[0].probability);
  assert.equal(adapter.applyPairOverlay(core,'EUR/JPY',at,overlay,at),core);
  assert.equal(adapter.applyPairOverlay(core,'EUR/USD','2026-09-15T00:00:00Z',overlay,at),core);
  assert.equal(adapter.applyPairOverlay(core,'EUR/USD',at,overlay,'2026-09-20T00:00:00Z'),core);
  assert.equal(adapter.applyPairOverlay(core,'EUR/USD',at,{...overlay,items:[overlay.items[0],overlay.items[0]]},at),core);
  assert.equal(adapter.applyPairOverlay(core,'EUR/USD',at,{...overlay,items:[{...overlay.items[0],weight:Infinity}]},at),core);
  assert.equal(adapter.applyPairOverlay(core,'EUR/USD',at,{...overlay,items:[{...overlay.items[0],baseline:.99}]},at),core);
});
test('zero contribution preserves API responses by identity and never needs research storage',async()=>{
  const env={DB:{prepare(){throw new Error('MUST_NOT_READ');}}};
  for(const path of ['/api/terminal','/api/forecast','/api/refresh']) {
    const response=Response.json({asOf:at,value:'unchanged'}),request=new Request('https://terminal'+path);
    assert.equal(await integration.integrateResponse(request,response,env,at),response);
    assert.equal(await integration.integrateResponse(request,response,{...env,HYPOTHESIS_PRODUCTION_WEIGHT:'.05',HYPOTHESIS_ENGINE_ENABLED:'false'},at),response);
  }
});
test('read-boundary integration uses committed successful research and fails closed after failed research',async()=>{
  const {sql,db}=sqlite(),p=payload(),original=qualified(),h=adapter.allocation(original,original,on,at),core=model.buildPairForecast(p,'EUR','USD');
  const overlay=adapter.buildOverlay([h],frame(h,core[0].probability),on,at),env={DB:db,HYPOTHESIS_PRODUCTION_WEIGHT:'.05'};
  sql.prepare('INSERT INTO terminal_settings VALUES (?,?,?)').run('hypothesis:v1:state',JSON.stringify({updatedAt:at,productionOverlay:overlay}),at);
  sql.prepare('INSERT INTO terminal_settings VALUES (?,?,?)').run('hypothesis:v1:last-run',JSON.stringify({at,status:'SUCCESS'}),at);
  const body={asOf:at,pair:'EUR/USD',forecasts:core},request=new Request('https://terminal/api/forecast');
  const result=await integration.integrateResponse(request,Response.json(body),env,at),value=await result.json();
  assert.ok(value.forecasts[0].hypothesis);assert.equal(value.forecasts[1].probability,core[1].probability);
  sql.prepare('UPDATE terminal_settings SET value=? WHERE key=?').run(JSON.stringify({at,status:'FAILED'}),'hypothesis:v1:last-run');
  const response=Response.json(body);assert.equal(await integration.integrateResponse(request,response,env,at),response);
});
