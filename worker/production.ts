import { ADAPTIVE_VERSION, combineEvidence, factorFingerprint, type EvidenceComponent, type EvidenceAttribution } from '../lib/adaptive-evidence';
import { digest } from '../lib/hypothesis/provenance';
import { currencies, forecastHorizons, type TerminalPayload } from '../lib/terminal-data';
import { dayMs, type Observation, type ProductionPayload } from '../lib/production-data';
import { advanceRecipe, buildResearchFrame, chooseChampions, comparisons, currencyPairs, discoverRecipes, modelInDistribution, modelScore, nonRedundant, outcomeHorizons, recipeSignal, RESEARCH_VERSION, resolveFrameTargets, trainChallenger, validationGate, type CandidateModel, type Recipe, type ResearchFrame, type ResolvedTarget } from '../lib/production-research';
import type { ResearchDB } from './hypothesis-research';
import { buildPairForecast } from '../lib/model-engine';
import { sourceReliability } from '../lib/source-health';

export type ProductionEnv={DB:ResearchDB;ADAPTIVE_ENABLED?:string;ADAPTIVE_MAX_WEIGHT?:string;ML_ENABLED?:string;HYPOTHESIS_ENGINE_ENABLED?:string};
type State={at:string;registry:Recipe[];models:CandidateModel[];trainingSequence:number;championIds:string[];lastRetrain:string|null;lastError:string|null;status:string;resolved:number;trainingExamples:number;rollbackCount:number};
const key='production:v2:state';
const emptyState=():State=>({at:'',registry:[],models:[],trainingSequence:0,championIds:[],lastRetrain:null,lastError:null,status:'WAITING_FOR_DATA',resolved:0,trainingExamples:0,rollbackCount:0});
async function state(db:ResearchDB){const r=await db.prepare('SELECT value FROM terminal_settings WHERE key=?').bind(key).first<{value:string}>();return r?JSON.parse(r.value) as State:emptyState();}
function stateWrite(db:ResearchDB,s:State){return db.prepare('INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,JSON.stringify(s),s.at);}
function record(db:ResearchDB,kind:string,id:string,at:string,payload:unknown){return db.prepare('INSERT INTO production_records (id,kind,at,version,payload) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id,kind,at,RESEARCH_VERSION,JSON.stringify(payload));}
async function batch(db:ResearchDB,rows:ReturnType<ResearchDB['prepare']>[]){for(let i=0;i<rows.length;i+=20)await db.batch(rows.slice(i,i+20));}
async function records<T>(db:ResearchDB,kind:string){const result:T[]=[];let cursor='';for(;;){const r=await db.prepare('SELECT id,payload FROM production_records WHERE kind=? AND id>? ORDER BY id LIMIT 100').bind(kind,cursor).all<{id:string;payload:string}>();result.push(...r.results.map(r=>JSON.parse(r.payload) as T));if(r.results.length<100)break;cursor=r.results.at(-1)!.id;}return result;}
async function frames(db:ResearchDB){
  const result=await records<ResearchFrame>(db,'frame');
  for(const f of result){const {digest:expected,...body}=f;if(!expected||expected!==await digest(body))throw new Error('FRAME_INTEGRITY_FAILURE');}
  return result;
}
async function targets(db:ResearchDB,horizon:number){
  const rows=await db.prepare("SELECT json_remove(payload,'$.pricePath') AS payload FROM production_records WHERE kind=? ORDER BY at ASC").bind(`outcome:${horizon}`).all<{payload:string}>();
  const result:ResolvedTarget[]=[];
  for(const r of rows.results){const o=JSON.parse(r.payload);const {digest:expected,...body}=o;if(!expected||expected!==await digest(body))throw new Error('OUTCOME_INTEGRITY_FAILURE');result.push(o);}
  return result;
}
async function priceArchive(db:ResearchDB,now:string){
  const rows=await db.prepare("SELECT payload FROM observation_vintages WHERE metric='fxReferenceUsd' AND period>=? ORDER BY received_at ASC").bind(new Date(Date.parse(now)-200*dayMs).toISOString().slice(0,10)).all<{payload:string}>();
  return rows.results.map(r=>JSON.parse(r.payload) as Observation);
}
export async function archiveObservations(db:ResearchDB,rows:Observation[],at:string){
  const statements=[];
  for(const o of rows){
    if(o.quality==='INVALID'||!Number.isFinite(o.value)||o.receivedAt>at)continue;
    const id=await digest({currency:o.currency,metric:o.metric,period:o.period,source:o.source,value:o.value,receivedAt:o.receivedAt});
    const payload={...o,rawValue:o.value,normalizedValue:o.normalizedValue??null,id,vintage:id,releaseDate:o.releaseDate??null,availabilityBasis:'actual-receipt',freshness:Math.max(0,(Date.parse(at)-Date.parse(o.period.length===4?`${o.period}-12-31`:o.period))/dayMs)};
    statements.push(db.prepare('INSERT INTO observation_vintages (id,currency,metric,period,source,received_at,value,payload) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM observation_vintages WHERE currency=? AND metric=? AND period=? AND source=? AND value=? AND received_at=(SELECT max(received_at) FROM observation_vintages WHERE currency=? AND metric=? AND period=? AND source=?))').bind(id,o.currency,o.metric,o.period,o.source,o.receivedAt,o.value,JSON.stringify(payload),o.currency,o.metric,o.period,o.source,o.value,o.currency,o.metric,o.period,o.source));
  }await batch(db,statements);
  const current=await db.prepare('SELECT currency,metric,period,source,id,max(received_at) AS received_at FROM observation_vintages GROUP BY currency,metric,period,source').all<{currency:string;metric:string;period:string;source:string;id:string}>();
  const ids=new Map(current.results.map(r=>[[r.currency,r.metric,r.period,r.source].join('|'),r.id]));
  return rows.map(r=>ids.get([r.currency,r.metric,r.period,r.source].join('|'))).filter((id):id is string=>!!id);
}
async function resolvePending(db:ResearchDB,history:ResearchFrame[],prices:Observation[],now:string){
  const recent=history.filter(f=>Date.parse(f.at)>=Date.parse(now)-105*dayMs);
  for(const f of recent){const resolved=resolveFrameTargets(f,prices,now);const writes=[];
    for(const o of resolved){const {pricePath,...base}=o;const body={...base,pricePathDigest:await digest(pricePath)};writes.push(record(db,`outcome:${o.horizon}`,`outcome:${o.horizon}:${o.currency}:${o.frameId}`,now,{...body,pricePath,digest:await digest(body)}));}
    for(const prediction of f.pairForecasts??[]){
      const [base,quote]=prediction.pair.split('/'),a=resolved.find(o=>o.currency===base&&o.horizon===prediction.horizon),b=resolved.find(o=>o.currency===quote&&o.horizon===prediction.horizon);
      if(!a||!b||a.entryDate!==b.entryDate||a.labelEnd!==b.labelEnd)continue;
      const path=a.pricePath.map(p=>({date:p.date,value:(p.value-b.pricePath.find(q=>q.date===p.date)!.value)*7/8}));
      const forwardReturn=path.at(-1)!.value,label=forwardReturn>0?1:0;
      const body={...prediction,frameId:f.id,asOf:f.at,resolvedAt:now,entryDate:a.entryDate,labelEnd:a.labelEnd,forwardReturn,label,coreLoss:(prediction.core-label)**2,adaptiveLoss:(prediction.adaptive-label)**2,mfe:Math.max(...path.map(x=>x.value)),mae:Math.min(...path.map(x=>x.value)),targetVersion:'pair-fixing-v1',source:a.source};
      writes.push(record(db,`pair-outcome:${prediction.horizon}`,`pair-outcome:${prediction.horizon}:${prediction.pair}:${f.id}`,now,{...body,digest:await digest(body)}));
    }
    await batch(db,writes);
  }
}
function configuration(env:ProductionEnv){const parsed=Number(env.ADAPTIVE_MAX_WEIGHT??'.1');return {enabled:env.ADAPTIVE_ENABLED!=='false',cap:Number.isFinite(parsed)&&parsed>=0?Math.min(.15,parsed):0,ml:env.ML_ENABLED!=='false',hypothesis:env.HYPOTHESIS_ENGINE_ENABLED!=='false'};}

/** Called from the real refresh, before snapshot publication. No background waitUntil tail can lose it. */
export async function prepareProductionSnapshot(env:ProductionEnv,p:ProductionPayload,observations:Observation[]){
  const db=env.DB,now=p.asOf;
  const inputIds=await archiveObservations(db,observations,now);
  const old=await state(db),history=await frames(db),prices=await priceArchive(db,now);
  // Runtime state is mutable; predictions and labels are immutable records with stable IDs.
  await resolvePending(db,history,prices,now);
  const current=buildResearchFrame(p,observations),config=configuration(env);
  const previousSources=await db.prepare("SELECT payload FROM production_records WHERE kind='sources' ORDER BY at DESC LIMIT 30").all<{payload:string}>();
  const reliability=sourceReliability(p.sourceChecks??[],previousSources.results.map(r=>JSON.parse(r.payload).checks??[]));
  const used=[...new Set(Object.values(current.sources).flatMap(s=>s.flatMap(x=>x.split(' + '))))];
  current.sourceReliability=Math.min(current.sourceReliability,...used.filter(s=>reliability[s]).map(s=>reliability[s].score));
  const catalog=discoverRecipes(old.registry,current);
  const allOutcomes:ResolvedTarget[]=[];
  for(const horizon of outcomeHorizons)allOutcomes.push(...await targets(db,horizon));
  const registry=catalog.map(r=>advanceRecipe(r,comparisons(history,allOutcomes,r.id,r.horizon,'hypotheses'),4096,now));
  const models=old.models.map(model=>{
    if(model.status==='REJECTED')return model;
    const rows=comparisons(history,allOutcomes,model.id,model.horizon,'ml').filter(r=>r.asOf>model.shadowStartedAt);
    const nextLook=model.look+1,gate=validationGate(rows,model.horizon,Math.max(4,old.trainingSequence*(old.trainingSequence+1)*4),nextLook);
    if(gate.blocks<model.lastBlocks+10)return model;
    const mature=gate.blocks>=30;
    if(mature&&!gate.passed)return {...model,status:'DEGRADED' as const,weight:0,gate,look:nextLook,lastBlocks:gate.blocks,lastChangedAt:now};
    if(!gate.passed||model.status==='DEGRADED'&&Date.parse(now)-Date.parse(model.lastChangedAt)<30*dayMs)return {...model,gate,look:nextLook,lastBlocks:gate.blocks};
    return {...model,status:'ACTIVE' as const,weight:gate.stability<.75&&model.weight>0?model.weight*.5:Math.min(.025,model.weight+.005),gate,look:nextLook,lastBlocks:gate.blocks,lastValidatedAt:now};
  });
  // Loss of a challenger falls back only to an independently current qualified champion.
  const champions=chooseChampions(models,old.championIds,history,allOutcomes,now);
  const activeRecipes=nonRedundant(registry,history,allOutcomes);
  for(const r of registry.filter(r=>r.status!=='REJECTED')){
    current.hypotheses[r.id]={};for(const c of currencies){const s=recipeSignal(r,current,history,c);if(s!==null)current.hypotheses[r.id][c]=.5+.4*s;}
  }
  for(const m of models.filter(m=>m.status!=='REJECTED'))current.ml[m.id]=Object.fromEntries(currencies.map(c=>[c,modelScore(m,current,c)]));
  current.modelIds=models.filter(m=>m.status!=='REJECTED').map(m=>m.id);
  const qualityOK=current.quality==='VALID'&&current.regimeVerified===true&&current.sourceReliability>=.8;
  for(const c of p.currencies){
    const components:EvidenceComponent[]=[];
    if(config.ml&&qualityOK)for(const m of champions){if(!modelInDistribution(m,current,c.code))continue;
      components.push({id:m.id,kind:'ML',score:modelScore(m,current,c.code),weight:m.weight/Math.max(1,champions.length),confidence:m.gate.confidence,regimeFit:m.gate.regimeFit[current.regime]??0,sourceReliability:current.sourceReliability,validated:m.gate.passed});
    }
    if(config.hypothesis&&qualityOK)for(const r of activeRecipes){const score=current.hypotheses[r.id]?.[c.code];if(!Number.isFinite(score)||!r.gate)continue;
      components.push({id:r.id,kind:'HYPOTHESIS',score,weight:r.weight/Math.max(1,activeRecipes.length),confidence:r.gate.confidence,regimeFit:r.gate.regimeFit[current.regime]??0,sourceReliability:current.sourceReliability,validated:r.gate.passed});
    }
    c.evidenceAttribution=combineEvidence(c,components,{at:now,cap:config.cap,enabled:config.enabled,modelVersion:champions.map(m=>m.id).join(',')||null,regime:current.regime});
    current.final[c.code]=c.evidenceAttribution.finalEvidenceScore;current.attributions[c.code]=c.evidenceAttribution;
  }
  current.inputIds=inputIds;
  current.pairEvents=currencyPairs(current);
  const baseline=structuredClone(p);for(const c of baseline.currencies)delete c.evidenceAttribution;
  current.pairForecasts=currencies.flatMap((a,i)=>currencies.slice(i+1).flatMap(b=>{const core=buildPairForecast(baseline,a,b),adaptive=buildPairForecast(p,a,b);return core.map((c,j)=>({pair:`${a}/${b}`,horizon:c.horizon,core:c.probability,adaptive:adaptive[j].probability}));}));
  current.digest=await digest(current);
  const championIds=champions.map(m=>m.id),lostChampion=old.championIds.some(id=>!championIds.includes(id)&&!models.some(m=>m.id===id&&m.status==='ACTIVE'&&m.gate.passed));
  const next:State={...old,at:now,registry,models,championIds,status:qualityOK?(allOutcomes.length?'SHADOW':'WAITING_FOR_DATA'):'WAITING_FOR_QUALITY_DATA',resolved:allOutcomes.length,trainingExamples:allOutcomes.filter(o=>forecastHorizons.includes(o.horizon as 10)).length,lastError:null,rollbackCount:old.rollbackCount+Number(lostChampion)};
  if(p.currencies.some(c=>c.evidenceAttribution!.status==='ACTIVE'))next.status='ACTIVE';
  // New daily predictions are immutable; intraday refreshes retain separate evidence history.
  const firstToday=!history.some(f=>f.quality==='VALID'&&f.at.slice(0,10)===now.slice(0,10));
  const writes=[stateWrite(db,next),record(db,'decision',`decision:${now}`,now,{oldChampions:old.championIds,champions:championIds,rollback:lostChampion,registry:registry.map(r=>({id:r.id,status:r.status,weight:r.weight,reason:r.reason})),quality:current.quality}),record(db,'evidence',`evidence:${now}`,now,{asOf:now,attributions:current.attributions,pairs:currencyPairs(current),previous:history.at(-1)?.final??null}),record(db,'sources',`sources:${now}`,now,{checks:p.sourceChecks,quality:current.quality,reliability:current.sourceReliability,providers:reliability})];
  if(firstToday)writes.push(record(db,'frame',current.id,now,current));
  // Commit frame, attribution, lifecycle state and public snapshot atomically.
  // Source receipts may be archived earlier, but an aborted refresh publishes no prediction.
  return {commit:()=>db.batch([...writes,db.prepare('INSERT INTO terminal_snapshots (as_of,source_mode,payload) VALUES (?,?,?)').bind(p.asOf,p.sourceMode,JSON.stringify(p))])};
}

export async function productionRetrain(env:ProductionEnv,now=new Date().toISOString()){
  const db=env.DB,old=await state(db),history=await frames(db),prices=await priceArchive(db,now);
  await resolvePending(db,history,prices,now);
  const sequence=old.trainingSequence+1,candidates:CandidateModel[]=[];let samples=0;
  for(const horizon of forecastHorizons){const labels=await targets(db,horizon);samples+=labels.length;
    const candidate=trainChallenger(history,labels,horizon,now,sequence);if(candidate)candidates.push(candidate);
  }
  const writes=candidates.map(m=>record(db,'model',m.id,now,m));
  const attempt={at:now,status:candidates.length?'SHADOW_TRAINED':'WAITING_FOR_DATA',samples,candidateIds:candidates.map(m=>m.id),accepted:candidates.filter(m=>m.status==='SHADOW').map(m=>m.id),legacyModelChanged:false};
  const next={...old,at:now,lastRetrain:now,trainingSequence:sequence,models:[...old.models.filter(m=>m.status!=='REJECTED'),...candidates],resolved:Math.max(old.resolved,samples),trainingExamples:samples,lastError:old.lastError};
  writes.push(stateWrite(db,next),record(db,'retrain',`retrain:${now}`,now,attempt));await batch(db,writes);
  return {status:'waiting',samples,minimum:100,validation:candidates.length?'Challenger versions stored; prospective shadow gate pending':'WAITING_FOR_DATA',candidateVersion:candidates[0]?.id??null,attempt};
}

export async function productionHealth(env:ProductionEnv){
  const s=await state(env.DB);const counts=await env.DB.prepare("SELECT kind,count(*) AS count FROM production_records GROUP BY kind").all<{kind:string;count:number}>();
  const row=await env.DB.prepare('SELECT count(*) AS observations FROM currency_observations').first<{observations:number}>();
  const snapshots=await env.DB.prepare('SELECT count(*) AS count,max(as_of) AS latest FROM terminal_snapshots').first<{count:number;latest:string|null}>();
  const vintageCount=await env.DB.prepare('SELECT count(*) AS count FROM observation_vintages').first<{count:number}>();
  const quality=await env.DB.prepare("SELECT json_extract(payload,'$.coreFactors') AS quality FROM terminal_snapshots ORDER BY as_of DESC LIMIT 1").first<{quality:string|null}>();
  const sources=await env.DB.prepare("SELECT payload FROM production_records WHERE kind='sources' ORDER BY at DESC LIMIT 1").first<{payload:string}>();
  const history=await env.DB.prepare("SELECT payload FROM production_records WHERE kind='evidence' ORDER BY at DESC LIMIT 30").all<{payload:string}>();
  const last=history.results[0]?JSON.parse(history.results[0].payload):null;
  const config=configuration(env),fresh=config.enabled&&!s.lastError&&!!last&&Date.now()-Date.parse(last.asOf)<36*3600000;
  const attributions=(fresh?Object.values(last?.attributions??{}):[]) as EvidenceAttribution[];
  const sourceStatus=sources?JSON.parse(sources.payload):null;
  const coreInputQuality=quality?.quality?JSON.parse(quality.quality):null;
  return {version:ADAPTIVE_VERSION,status:fresh?s.status:'CORE_FALLBACK',lastSuccessfulSnapshot:snapshots?.latest??null,snapshotCount:snapshots?.count??0,observationCount:row?.observations??0,observationVintages:vintageCount?.count??0,coreInputQuality,sourceReliability:sourceStatus?.providers??{},counts:counts.results,trainingExamples:s.trainingExamples,resolvedOutcomes:counts.results.filter(c=>c.kind.startsWith('outcome:')).reduce((n,c)=>n+c.count,0),lastRetrain:s.lastRetrain,currentMlVersion:s.championIds.length?s.championIds.join(','):'DETERMINISTIC_CORE',challengerVersions:s.models.map(m=>({id:m.id,status:m.status,samples:m.trainingSamples,gate:m.gate})),mlInfluence:config.ml?Math.max(0,...attributions.map(a=>a.mlWeight)):0,hypothesisInfluence:config.hypothesis?Math.max(0,...attributions.map(a=>a.hypothesisWeight)):0,hypothesisCount:s.registry.length,activeHypotheses:s.registry.filter(r=>r.status==='ACTIVE').length,shadowHypotheses:s.registry.filter(r=>r.status==='SHADOW').length,rejectedHypotheses:s.registry.filter(r=>r.status==='REJECTED').length,registry:s.registry,failedDataSources:sourceStatus?.checks?.filter((c:{status:string})=>c.status!=='SUCCESS')??[],lastError:s.lastError,rollbackCount:s.rollbackCount,evidenceHistory:history.results.map(r=>JSON.parse(r.payload)),config:configuration(env),notice:'Prospective currency-basket validation. Daily fixing excursions are not intraday MFE/MAE. Model-generated dispersion is not an empirical confidence interval.'};
}

/** Fail closed also on read: runtime kill switches never wait for tomorrow's snapshot. */
export async function guardProductionPayload(env:ProductionEnv,p:TerminalPayload){
  try{const s=await state(env.DB),config=configuration(env);if(!config.enabled||s.lastError||Date.now()-Date.parse(s.at)>36*3600000)throw new Error('ADAPTIVE_DISABLED');
    for(const c of p.currencies){const a=c.evidenceAttribution;if(!a)continue;
      if(a.version!==ADAPTIVE_VERSION||a.factorFingerprint!==factorFingerprint(c)||!Number.isFinite(Date.parse(a.expiresAt))||Date.parse(a.expiresAt)<Date.now()||!Number.isFinite(a.cap)){delete c.evidenceAttribution;continue;}
      const valid=a.components.filter(x=>x.kind==='ML'?config.ml&&s.championIds.includes(x.id):config.hypothesis&&s.registry.some(r=>r.id===x.id&&r.status==='ACTIVE'));
      c.evidenceAttribution=combineEvidence(c,valid,{at:a.at,cap:Math.min(config.cap,a.cap),enabled:true,modelVersion:a.modelVersion,regime:a.regime});
    }
  }catch{for(const c of p.currencies)delete c.evidenceAttribution;}return p;
}

export async function productionFailure(env:ProductionEnv,at:string,stage:string){
  try{const s=await state(env.DB);await env.DB.batch([stateWrite(env.DB,{...s,at,status:'FAILED_CORE_FALLBACK',lastError:stage}),record(env.DB,'error',`error:${at}:${stage}`,at,{stage,adaptiveInfluence:0})]);}catch{console.error('PRODUCTION_RECORD_FAILURE');}
}
