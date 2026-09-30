import { ADAPTIVE_VERSION, combineEvidence, factorFingerprint, type EvidenceComponent, type EvidenceAttribution } from '../lib/adaptive-evidence';
import { digest } from '../lib/hypothesis/provenance';
import { currencies, forecastHorizons, type TerminalPayload } from '../lib/terminal-data';
import { dayMs, observationQuality, refreshSourceStatus, type Observation, type ProductionPayload } from '../lib/production-data';
import { advanceRecipe, agriculturalCommonCauseCheck, buildResearchFrame, certified, incrementalCertified, chooseChampions, comparisons, currencyPairs, discoverRecipes, modelInDistribution, modelScore, nonRedundant, outcomeHorizons, recipeSignal, researchSourceChecks, RESEARCH_VERSION, resolveFrameTargets, trainChallenger, validationGate, type CandidateModel, type Gate, type Recipe, type ResearchFrame, type ResolvedTarget } from '../lib/production-research';
import { dateClusters, dependence, VALIDATION_VERSION } from '../lib/temporal-validation';
import { independentBlocks } from '../lib/hypothesis/engine';
import type { ResearchDB } from './hypothesis-research';
import { buildPairForecast } from '../lib/model-engine';
import { sourceReliability } from '../lib/source-health';
import { effectiveRecipeWeight } from '../lib/production-research';
import { issueEventPredictions, resolveEventPredictions, eventTargetStatus, type EventOutcome } from '../lib/shadow-targets';
import { advanceContextModel, chooseContextChampions, contextScore, trainContextModel, type ContextModel } from '../lib/hypothesis-context';
import { researchCoverage } from '../lib/research-coverage';
import { coreRequirement } from '../lib/core-coverage';
import { unavailableClasses } from '../lib/observed-sources';
import { prepareModelMigration } from './model-migration';

export type ProductionEnv={DB:ResearchDB;ADAPTIVE_ENABLED?:string;ADAPTIVE_MAX_WEIGHT?:string;ML_ENABLED?:string;HYPOTHESIS_ENGINE_ENABLED?:string};
type State={at:string;registry:Recipe[];models:CandidateModel[];contextModels:ContextModel[];contextChampionIds:string[];trainingSequence:number;championIds:string[];lastRetrain:string|null;lastError:string|null;status:string;resolved:number;trainingExamples:number;rollbackCount:number};
const key='production:v2:state';
const emptyState=():State=>({at:'',registry:[],models:[],contextModels:[],contextChampionIds:[],trainingSequence:0,championIds:[],lastRetrain:null,lastError:null,status:'WAITING_FOR_DATA',resolved:0,trainingExamples:0,rollbackCount:0});
async function state(db:ResearchDB){const r=await db.prepare('SELECT value FROM terminal_settings WHERE key=?').bind(key).first<{value:string}>();return {...emptyState(),...(r?JSON.parse(r.value):{})} as State;}
function stateWrite(db:ResearchDB,s:State){return db.prepare('INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,JSON.stringify(s),s.at);}
function record(db:ResearchDB,kind:string,id:string,at:string,payload:unknown){return db.prepare('INSERT INTO production_records (id,kind,at,version,payload) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(id,kind,at,RESEARCH_VERSION,JSON.stringify(payload));}
async function batch(db:ResearchDB,rows:ReturnType<ResearchDB['prepare']>[]){for(let i=0;i<rows.length;i+=20)await db.batch(rows.slice(i,i+20));}
async function records<T>(db:ResearchDB,kind:string){const result:T[]=[];let cursor='';for(;;){const r=await db.prepare('SELECT id,payload FROM production_records WHERE kind=? AND id>? ORDER BY id LIMIT 100').bind(kind,cursor).all<{id:string;payload:string}>();result.push(...r.results.map(r=>JSON.parse(r.payload) as T));if(r.results.length<100)break;cursor=r.results.at(-1)!.id;}return result;}
async function verifiedEvents(db:ResearchDB){const rows=await records<EventOutcome&{digest:string}>(db,'event-outcome');for(const row of rows){const {digest:expected,...body}=row;if(!expected||expected!==await digest(body))throw new Error('EVENT_OUTCOME_INTEGRITY_FAILURE');}return rows;}
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
  const rows=await db.prepare("SELECT payload FROM observation_vintages WHERE metric IN ('fxReferenceUsd','vix') AND period>=? ORDER BY received_at ASC").bind(new Date(Date.parse(now)-200*dayMs).toISOString().slice(0,10)).all<{payload:string}>();
  return rows.results.map(r=>JSON.parse(r.payload) as Observation);
}
export async function archiveObservations(db:ResearchDB,rows:Observation[],at:string){
  const statements=[];
  for(const o of rows){
    if(observationQuality(o.metric,o.value,o.period,at)==='INVALID'||o.quality==='INVALID'||!Number.isFinite(o.value)||!Number.isFinite(Date.parse(o.receivedAt))||o.receivedAt>at||o.releaseDate&&(!Number.isFinite(Date.parse(o.releaseDate))||o.releaseDate>at)||o.publicationDate&&o.publicationDate>at.slice(0,10)||o.scheduledPublicationAt&&o.scheduledPublicationAt>at)continue;
    // A revision of an older component can change a normalized feature even when its latest raw value is unchanged.
    // Receipt clocks in nested dependencies are audit metadata, not economic revisions.
    const economicInputs=JSON.parse(JSON.stringify(o.rawInputs??null,(key,value)=>['receivedAt','retrievedAt','retrievalTime'].includes(key)?undefined:value));
    const contentHash=await digest({value:o.value,normalizedValue:o.normalizedValue??null,featureVersion:o.featureVersion??null,rawInputs:economicInputs,releaseDate:o.releaseDate??null,...(o.publicationDate!==undefined?{publicationDate:o.publicationDate,researchExposures:o.researchExposures??null}:{})});
    const id=await digest({currency:o.currency,metric:o.metric,period:o.period,source:o.source,contentHash,receivedAt:o.receivedAt});
    const payload={...o,rawValue:o.value,normalizedValue:o.normalizedValue??null,id,vintage:id,contentHash,releaseDate:o.releaseDate??null,availabilityBasis:'actual-receipt',freshness:Math.max(0,(Date.parse(at)-Date.parse(o.period.length===4?`${o.period}-12-31`:o.period))/dayMs)};
    statements.push(db.prepare("INSERT INTO observation_vintages (id,currency,metric,period,source,received_at,value,payload) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM observation_vintages WHERE currency=? AND metric=? AND period=? AND source=? AND json_extract(payload,'$.contentHash')=? AND received_at=(SELECT max(received_at) FROM observation_vintages WHERE currency=? AND metric=? AND period=? AND source=?))").bind(id,o.currency,o.metric,o.period,o.source,o.receivedAt,o.value,JSON.stringify(payload),o.currency,o.metric,o.period,o.source,contentHash,o.currency,o.metric,o.period,o.source));
  }await batch(db,statements);
  const current=await db.prepare('SELECT currency,metric,period,source,id,max(received_at) AS received_at FROM observation_vintages GROUP BY currency,metric,period,source').all<{currency:string;metric:string;period:string;source:string;id:string}>();
  const ids=new Map(current.results.map(r=>[[r.currency,r.metric,r.period,r.source].join('|'),r.id]));
  return rows.map(r=>ids.get([r.currency,r.metric,r.period,r.source].join('|'))).filter((id):id is string=>!!id);
}
async function resolvePending(db:ResearchDB,history:ResearchFrame[],prices:Observation[],now:string){
  const recent=history.filter(f=>Date.parse(f.at)>=Date.parse(now)-105*dayMs);
  for(const f of recent){const resolved=resolveFrameTargets(f,prices,now);const writes=[];
    for(const o of resolved){const {pricePath,...base}=o;const body={...base,pricePathDigest:await digest(pricePath)};writes.push(record(db,`outcome:${o.horizon}`,`outcome:${o.horizon}:${o.currency}:${o.frameId}`,now,{...body,pricePath,digest:await digest(body)}));}
    for(const event of resolveEventPredictions(f,f.eventPredictions??[],resolved,prices,now))writes.push(record(db,'event-outcome',event.id,now,{...event,digest:await digest(event)}));
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
export function configuration(env:ProductionEnv){const flag=(s:string|undefined)=>s===undefined||s.trim().toLowerCase()==='true';const parsed=Number(env.ADAPTIVE_MAX_WEIGHT??'.1');return {enabled:flag(env.ADAPTIVE_ENABLED),cap:Number.isFinite(parsed)&&parsed>=0?Math.min(.15,parsed):0,ml:flag(env.ML_ENABLED),hypothesis:flag(env.HYPOTHESIS_ENGINE_ENABLED)};}

export function validationSummaries(outcomes:ResolvedTarget[],models:CandidateModel[]){return outcomeHorizons.map(horizon=>{
  const labels=outcomes.filter(o=>o.horizon===horizon),rows=labels.map(o=>({...o,pair:o.currency,probability:.5,baseline:.5,regime:o.regime}));
  const labelDependence=dependence(rows,r=>r.label),model=models.filter(m=>m.horizon===horizon).sort((a,b)=>b.trainedAt.localeCompare(a.trainedAt))[0];
  return {horizon,version:VALIDATION_VERSION,rawObservations:labels.length,uniqueForecastDates:dateClusters(rows).clusters.length,oldIndependentBlocks:independentBlocks(rows,horizon).length,overlappingLabelRatio:labelDependence.overlappingLabelRatio,labelProcessEffectiveSampleSize:labelDependence.effectiveSampleSize,trainingExamples:model?.trainingSamples??0,effectiveSampleSize:model?.historicalGate?.diagnostics?.effectiveSampleSize??0,folds:Math.max(0,(model?.folds.length??0)-1),purgedRows:model?.folds.reduce((n,f)=>n+(f.removed?.length??0),0)??0,oosSamples:model?.historicalGate?.samples??0,holdoutStatus:model?.holdoutGate?.reason??'WAITING_FOR_DATA',shadowStatus:model?.status??'WAITING_FOR_DATA',shadowEffectiveSampleSize:(model?.lastDates??0)>0?model?.gate?.diagnostics?.effectiveSampleSize??0:0,blocker:!model?'WAITING_FOR_DATA':!certified(model)?model.historicalGate?.passed?model.holdoutGate?.reason??'HOLDOUT_PENDING':model.historicalGate?.reason??'HISTORICAL_VALIDATION_PENDING':model.status==='ACTIVE'?'MONITORING_REAL_OUTCOMES':'PROSPECTIVE_SHADOW_AND_REGIMES',purpose:horizon<10?'AUXILIARY / HYPOTHESIS SCREENING; no substitution for long-horizon labels':'MAIN ML + CURRENCY / PAIR CONTEXT'};
});}

/** Called from the real refresh, before snapshot publication. No background waitUntil tail can lose it. */
export async function prepareProductionSnapshot(env:ProductionEnv,p:ProductionPayload,observations:Observation[]){
  const db=env.DB,now=p.asOf;
  const migration=await prepareModelMigration(db,p.model,now);p.model=migration.model;
  const inputIds=await archiveObservations(db,observations,now);
  const old=await state(db),history=await frames(db),prices=await priceArchive(db,now);
  // Runtime state is mutable; predictions and labels are immutable records with stable IDs.
  await resolvePending(db,history,prices,now);
  p.researchCoverage=researchCoverage(observations,p.sourceChecks??[],now);
  const current=buildResearchFrame(p,observations),config=configuration(env);
  const previousSources=await db.prepare("SELECT payload FROM production_records WHERE kind='sources' ORDER BY at DESC LIMIT 30").all<{payload:string}>();
  const reliability=sourceReliability(researchSourceChecks(current,p.sourceChecks??[]),previousSources.results.map(r=>researchSourceChecks(current,JSON.parse(r.payload).checks??[])));
  current.sourceReliability=Math.min(current.sourceReliability,...Object.values(reliability).map(s=>s.score));
  const catalog=discoverRecipes(old.registry,current,history);
  const allOutcomes:ResolvedTarget[]=[];
  for(const horizon of outcomeHorizons)allOutcomes.push(...await targets(db,horizon));
  const registry=catalog.map(r=>{const next=advanceRecipe(r,comparisons(history,allOutcomes,r.id,r.horizon,'hypotheses'),4096,now);if(next.status!=='ACTIVE')return next;
    const audit=agriculturalCommonCauseCheck(next,history);return audit.passed?{...next,commonCauseAudit:audit}:{...next,commonCauseAudit:audit,status:(audit.reason==='REDUNDANT_WITH_CORE_OR_COMMON_CAUSE'?'REJECTED':'DEGRADED') as Recipe['status'],weight:0,reason:audit.reason,lastChangedAt:now};});
  const models=old.models.map(model=>{
    if(model.status==='REJECTED')return model;
    if(!certified(model))return {...model,status:'SHADOW' as const,weight:0};
    const rows=comparisons(history,allOutcomes,model.id,model.horizon,'ml').filter(r=>r.asOf>model.shadowStartedAt);
    const nextLook=model.look+1,gate=validationGate(rows,model.horizon,Math.max(4,old.trainingSequence*(old.trainingSequence+1)*4),nextLook);
    const dates=gate.diagnostics?.uniqueForecastDates??0;if(dates<(model.lastDates??0)+10)return model;
    const next={...model,gate,look:nextLook,lastBlocks:gate.blocks,lastDates:dates},mature=gate.blocks>=30;
    if((mature||model.status==='ACTIVE')&&!gate.passed)return {...next,status:'DEGRADED' as const,weight:0,lastChangedAt:now};
    if(!gate.passed||model.status==='DEGRADED'&&Date.parse(now)-Date.parse(model.lastChangedAt)<30*dayMs)return {...next,weight:0};
    return {...next,status:'ACTIVE' as const,weight:gate.stability<.75&&model.weight>0?model.weight*.5:Math.min(.025,model.weight+.005),lastValidatedAt:now};
  });
  // Loss of a challenger falls back only to an independently current qualified champion.
  const champions=chooseChampions(models,old.championIds,history,allOutcomes,now);
  const contextModels=old.contextModels.map(m=>advanceContextModel(m,history,allOutcomes,now,old.trainingSequence));
  const contextChampions=chooseContextChampions(contextModels,old.contextChampionIds,history,allOutcomes,now);
  const currencyContextChampions=contextChampions.filter(m=>m.scope==='currency');
  const consumed=registry.filter(r=>currencyContextChampions.some(m=>m.recipeIds.includes(r.id))||champions.some(m=>m.featureKeys.some(k=>r.feature==='factor.'+k||r.other==='factor.'+k)));
  const activeRecipes=nonRedundant(registry,history,allOutcomes).filter(r=>!consumed.some(s=>s.id===r.id||s.lineage?.some(x=>r.lineage?.includes(x))||s.economicCauses?.some(x=>r.economicCauses?.includes(x))));
  for(const r of registry.filter(r=>r.status!=='REJECTED')){
    current.hypotheses[r.id]={};for(const c of currencies){const s=recipeSignal(r,current,history,c);if(s!==null)current.hypotheses[r.id][c]=.5+.4*s;}
  }
  for(const m of models.filter(m=>m.status!=='REJECTED'))current.ml[m.id]=Object.fromEntries(currencies.map(c=>[c,modelScore(m,current,c)]));
  current.modelIds=models.filter(m=>m.status!=='REJECTED').map(m=>m.id);
  const qualityOK=current.quality==='VALID'&&current.regimeVerified===true&&current.sourceReliability>=.8;
  for(const c of p.currencies){
    const components:EvidenceComponent[]=[];
    if(config.ml&&qualityOK)for(const m of champions){if(!modelInDistribution(m,current,c.code))continue;
      components.push({id:m.id,kind:'ML',score:modelScore(m,current,c.code),weight:m.weight/Math.max(1,champions.length+currencyContextChampions.length),confidence:m.gate.confidence,regimeFit:m.gate.regimeFit[current.regime]??0,sourceReliability:current.sourceReliability,validated:m.gate.passed});
    }
    if(config.ml&&qualityOK)for(const m of currencyContextChampions){const prediction=contextScore(m,current,c.code);if(!prediction)continue;
      components.push({id:m.id,kind:'ML',score:prediction.candidate,weight:m.weight/Math.max(1,champions.length+currencyContextChampions.length),confidence:Math.min(m.gate.confidence,m.incrementalGate.confidence),regimeFit:Math.min(m.gate.regimeFit[current.regime]??0,m.incrementalGate.regimeFit[current.regime]??0),sourceReliability:current.sourceReliability,validated:m.gate.passed&&m.incrementalGate.passed});
    }
    if(config.hypothesis&&qualityOK)for(const r of activeRecipes){const score=current.hypotheses[r.id]?.[c.code];if(!Number.isFinite(score)||!r.gate)continue;
      components.push({id:r.id,kind:'HYPOTHESIS',score,weight:effectiveRecipeWeight(r,now)/Math.max(1,activeRecipes.length),confidence:r.gate.confidence,regimeFit:r.gate.regimeFit[current.regime]??0,sourceReliability:current.sourceReliability,validated:r.gate.passed});
    }
    c.evidenceAttribution=combineEvidence(c,components,{at:now,cap:config.cap,enabled:config.enabled,modelVersion:[...champions,...currencyContextChampions].map(m=>m.id).join(',')||null,regime:current.regime});
    current.final[c.code]=c.evidenceAttribution.finalEvidenceScore;current.attributions[c.code]=c.evidenceAttribution;
    c.history[0]={ageDays:0,score:current.final[c.code],coreScore:current.core[c.code]};
  }
  current.inputIds=inputIds;
  current.pairEvents=currencyPairs(current);
  const baseline=structuredClone(p);for(const c of baseline.currencies)delete c.evidenceAttribution;
  current.pairForecasts=currencies.flatMap((a,i)=>currencies.slice(i+1).flatMap(b=>{const core=buildPairForecast(baseline,a,b),adaptive=buildPairForecast(p,a,b);return core.map((c,j)=>({pair:`${a}/${b}`,horizon:c.horizon,core:c.probability,adaptive:adaptive[j].probability}));}));
  current.eventPredictions=issueEventPredictions(current,observations,await verifiedEvents(db));
  current.contextPredictions={};
  for(const model of contextModels.filter(m=>m.status!=='REJECTED')){
    const entities=model.scope==='currency'?[...currencies]:currencyPairs(current).map(p=>p.pair);
    current.contextPredictions[model.id]=Object.fromEntries(entities.flatMap(entity=>{const prediction=contextScore(model,current,entity);return prediction?[[entity,prediction]]:[];}));
  }
  current.digest=await digest(current);
  const championIds=champions.map(m=>m.id),lostChampion=old.championIds.some(id=>!championIds.includes(id)&&!models.some(m=>m.id===id&&m.status==='ACTIVE'&&m.gate.passed));
  const contextChampionIds=contextChampions.map(m=>m.id),lostContextChampion=old.contextChampionIds.some(id=>!contextChampionIds.includes(id)&&contextModels.some(m=>m.id===id&&m.status==='DEGRADED'));
  const next:State={...old,at:now,registry,models,championIds,contextModels,contextChampionIds,status:qualityOK?(allOutcomes.length?'SHADOW':'WAITING_FOR_DATA'):'WAITING_FOR_QUALITY_DATA',resolved:allOutcomes.length,trainingExamples:allOutcomes.filter(o=>forecastHorizons.includes(o.horizon as 10)).length,lastError:null,rollbackCount:old.rollbackCount+Number(lostChampion||lostContextChampion)};
  if(p.currencies.some(c=>c.evidenceAttribution!.status==='ACTIVE'))next.status='ACTIVE';
  // New daily predictions are immutable; intraday refreshes retain separate evidence history.
  const firstToday=!history.some(f=>f.quality==='VALID'&&f.regimeVerified===true&&f.sourceReliability>=.8&&f.at.slice(0,10)===now.slice(0,10));
  const writes=[stateWrite(db,next),record(db,'decision',`decision:${now}`,now,{oldChampions:old.championIds,champions:championIds,oldContextChampions:old.contextChampionIds,contextChampions:contextChampionIds,rollback:lostChampion||lostContextChampion,contextRollback:lostContextChampion,registry:registry.map(r=>({id:r.id,status:r.status,weight:r.weight,reason:r.reason})),quality:current.quality}),record(db,'evidence',`evidence:${now}`,now,{asOf:now,attributions:current.attributions,pairs:currencyPairs(current),previous:history.at(-1)?.final??null}),record(db,'sources',`sources:${now}`,now,{checks:p.sourceChecks,quality:current.quality,reliability:current.sourceReliability,providers:reliability})];
  if(firstToday)writes.push(record(db,'frame',current.id,now,current));
  const totals=await db.prepare('SELECT (SELECT count(*) FROM terminal_snapshots) AS snapshots,(SELECT count(*) FROM currency_observations) AS observations,(SELECT count(*) FROM observation_vintages) AS vintages').first<{snapshots:number;observations:number;vintages:number}>();
  writes.push(record(db,'coverage',`coverage:${now}`,now,{sourceCoverage:p.sourceCoverage,researchCoverage:p.researchCoverage,coreFactors:p.coreFactors,alternatives:Object.keys(current.featureOrigins??{}).filter(k=>k.startsWith('alt.')||k.startsWith('proxy.')),notConnected:unavailableClasses}));
  // Individually inspectable diagnostics: large aggregate JSON cells may be truncated by admin readers.
  for(const [currency,factors] of Object.entries(p.coreFactors??{}))for(const [factor,origin] of Object.entries(factors))
    writes.push(record(db,'factor-status',`factor-status:${now}:${currency}:${factor}`,now,{currency,factor,...origin}));
  for(const research of p.researchCoverage.classes)writes.push(record(db,'research-status',`research-status:${now}:${research.name}`,now,research));
  for(const [index,check] of (p.sourceChecks??[]).entries())
    writes.push(record(db,'source-status',`source-status:${now}:${index}`,now,check));
  for(const recipe of registry)writes.push(record(db,'validation-hypothesis',`validation-hypothesis:${now}:${recipe.id}`,now,{id:recipe.id,feature:recipe.feature,horizon:recipe.horizon,status:recipe.status,reason:recipe.reason,progress:recipe.progress,regimeFit:recipe.gate?.regimeFit,validationVersion:VALIDATION_VERSION}));
  for(const recipe of registry){
    if(recipe.commonCauseAudit)writes.push(record(db,'common-cause-audit',`common-cause:${now}:${recipe.id}`,now,{id:recipe.id,...recipe.commonCauseAudit}));
    if(recipe.historicalAudit&&recipe.historicalEpoch!==old.registry.find(r=>r.id===recipe.id)?.historicalEpoch){
      const {removed,...audit}=recipe.historicalAudit;writes.push(record(db,'hypothesis-split',`hypothesis-split:${recipe.id}:${audit.epoch}`,now,{id:recipe.id,...audit,removedCount:removed.length}));
      for(const [i,removal] of removed.entries())writes.push(record(db,'purge-audit',`purge:${recipe.id}:${audit.epoch}:${i}`,now,{recipeId:recipe.id,epoch:audit.epoch,...removal}));
    }
  }
  for(const summary of validationSummaries(allOutcomes,models))writes.push(record(db,'validation-horizon',`validation-horizon:${now}:${summary.horizon}`,now,summary));

  writes.push(record(db,'status',`status:${now}`,now,{status:next.status,mlVersion:[...championIds,...currencyContextChampions.map(m=>m.id)].join(',')||'DETERMINISTIC_CORE',hypothesisCount:registry.length,active:registry.filter(r=>r.status==='ACTIVE').length,shadow:registry.filter(r=>r.status==='SHADOW').length,testing:registry.filter(r=>['DISCOVERY','TESTING','VALIDATING'].includes(r.status)).length,rejected:registry.filter(r=>r.status==='REJECTED').length,resolved:next.resolved,trainingExamples:next.trainingExamples,lastRetrain:next.lastRetrain,rollbackCount:next.rollbackCount,mlInfluence:Math.max(0,...p.currencies.map(c=>c.evidenceAttribution!.mlWeight)),hypothesisInfluence:Math.max(0,...p.currencies.map(c=>c.evidenceAttribution!.hypothesisWeight)),snapshotCount:(totals?.snapshots??0)+1,observationCountBeforeRefreshUpsert:totals?.observations??0,immutableVintages:totals?.vintages??0,coverage:p.sourceCoverage}));
  // Commit frame, attribution, lifecycle state and public snapshot atomically.
  // Source receipts may be archived earlier, but an aborted refresh publishes no prediction.
  return {commit:()=>db.batch([...migration.writes,...writes,db.prepare('INSERT INTO terminal_snapshots (as_of,source_mode,payload) VALUES (?,?,?)').bind(p.asOf,p.sourceMode,JSON.stringify(p))])};
}

export async function productionRetrain(env:ProductionEnv,now=new Date().toISOString()){
  const db=env.DB,old=await state(db),history=await frames(db),prices=await priceArchive(db,now);
  await resolvePending(db,history,prices,now);
  const sequence=old.trainingSequence+1,candidates:CandidateModel[]=[],contexts:ContextModel[]=[];let samples=0;
  for(const horizon of forecastHorizons){const labels=await targets(db,horizon);samples+=labels.length;
    const candidate=trainChallenger(history,labels,horizon,now,sequence);if(candidate)candidates.push(candidate);
    for(const scope of ['currency','pair'] as const){const context=trainContextModel(history,labels,horizon,scope,now,sequence);if(context)contexts.push(context);}
  }
  const writes=candidates.map(m=>record(db,'model',m.id,now,m));
  writes.push(...contexts.map(m=>record(db,'context-model',m.id,now,m)));
  for(const model of [...candidates,...contexts])for(const [fold,details] of model.folds.entries())for(const [index,removal] of (details.removed??[]).entries())writes.push(record(db,'purge-audit',`purge:${model.id}:${fold}:${index}`,now,{modelId:model.id,fold,...removal}));
  const attempt={at:now,status:candidates.length||contexts.length?'SHADOW_TRAINED':'WAITING_FOR_DATA',samples,candidateIds:[...candidates,...contexts].map(m=>m.id),accepted:[...candidates,...contexts].filter(m=>m.status==='SHADOW').map(m=>m.id),legacyModelChanged:false};
  const next={...old,at:now,lastRetrain:now,trainingSequence:sequence,models:[...old.models.filter(m=>m.status!=='REJECTED'),...candidates],contextModels:[...old.contextModels.filter(m=>m.status!=='REJECTED'),...contexts],resolved:Math.max(old.resolved,samples),trainingExamples:samples,lastError:old.lastError};
  writes.push(stateWrite(db,next),record(db,'retrain',`retrain:${now}`,now,attempt));await batch(db,writes);
  return {status:'waiting',samples,minimum:100,validation:candidates.length||contexts.length?'Challenger versions stored; prospective shadow gate pending':'WAITING_FOR_DATA',candidateVersion:candidates[0]?.id??contexts[0]?.id??null,attempt};
}

export async function productionHealth(env:ProductionEnv){
  const s=await state(env.DB);const counts=await env.DB.prepare("SELECT kind,count(*) AS count FROM production_records GROUP BY kind").all<{kind:string;count:number}>();
  const row=await env.DB.prepare('SELECT count(*) AS observations FROM currency_observations').first<{observations:number}>();
  const snapshots=await env.DB.prepare('SELECT count(*) AS count,max(as_of) AS latest FROM terminal_snapshots').first<{count:number;latest:string|null}>();
  const vintageCount=await env.DB.prepare('SELECT count(*) AS count FROM observation_vintages').first<{count:number}>();
  const snapshot=await env.DB.prepare("SELECT payload FROM terminal_snapshots ORDER BY as_of DESC LIMIT 1").first<{payload:string}>();
  const sources=await env.DB.prepare("SELECT payload FROM production_records WHERE kind='sources' ORDER BY at DESC LIMIT 1").first<{payload:string}>();
  const history=await env.DB.prepare("SELECT payload FROM production_records WHERE kind='evidence' ORDER BY at DESC LIMIT 30").all<{payload:string}>();
  const last=history.results[0]?JSON.parse(history.results[0].payload):null;
  const config=configuration(env),fresh=config.enabled&&!s.lastError&&!!last&&Date.now()-Date.parse(last.asOf)<36*3600000;
  const guarded=snapshot?await guardProductionPayload(env,JSON.parse(snapshot.payload) as TerminalPayload):null;
  const attributions=(fresh?guarded?.currencies.flatMap(c=>c.evidenceAttribution?[c.evidenceAttribution]:[])??[]:[]) as EvidenceAttribution[];
  const sourceStatus=sources?JSON.parse(sources.payload):null;
  const coreInputQuality=(guarded as ProductionPayload|null)?.coreFactors??null;
  const coveragePayload={asOf:snapshots?.latest??'',coreFactors:coreInputQuality} as ProductionPayload;
  refreshSourceStatus(coveragePayload);
  const readRun=async(type:string,cronOnly=false,successOnly=false)=>{
    const found=await env.DB.prepare("SELECT value FROM terminal_settings WHERE key LIKE 'automation:run:%' AND json_extract(value,'$.type')=? AND (?=0 OR json_extract(value,'$.source')='CLOUDFLARE_CRON') AND (?=0 OR (json_extract(value,'$.status')='SUCCESS' AND json_extract(value,'$.snapshotAdvanced')=1)) AND (?!='WEEKLY_RETRAIN' OR json_extract(value,'$.httpStatus')=200) ORDER BY updated_at DESC LIMIT 1").bind(type,Number(cronOnly),Number(successOnly),type).first<{value:string}>();
    return found?JSON.parse(found.value) as {id:string;timestamp:string;completedAt:string|null;source:string;status:string;snapshotAfter:string|null;trainingSamples:number|null}:null;
  };
  const [lastSuccessfulDailyRefresh,lastSuccessfulRealCronRefresh,lastRegularWeeklyRetrain]=await Promise.all([readRun('DAILY_REFRESH',false,true),readRun('DAILY_REFRESH',true,true),readRun('WEEKLY_RETRAIN',true)]);
  const originRows=Object.entries((coreInputQuality??{}) as NonNullable<ProductionPayload['coreFactors']>).flatMap(([currency,factors])=>Object.entries(factors).map(([factor,origin])=>({currency,factor,...origin})));
  const coverage={...coveragePayload.sourceCoverage!,asOf:snapshots?.latest??null,scope:'Current Core certification; critical dependencies and isolated context gaps are explicit'};
  const researchAt=new Date().toISOString();
  let researchReceipts=(guarded as ProductionPayload|null)?.researchCoverage?.receipts;
  // Older immutable snapshots predate the coverage field. Read their real archive,
  // without rewriting snapshots or making already-collected Research look absent.
  if(!researchReceipts){
    const archived=await env.DB.prepare("SELECT payload FROM (SELECT payload,row_number() OVER (PARTITION BY currency,metric ORDER BY received_at DESC,period DESC,id DESC) AS rank FROM observation_vintages WHERE (metric LIKE 'alt.%' OR metric LIKE 'proxy.%') AND received_at<=?) WHERE rank=1").bind(researchAt).all<{payload:string}>();
    researchReceipts=archived.results.map(r=>JSON.parse(r.payload) as Observation);
  }
  const research=researchCoverage(researchReceipts,sourceStatus?.checks??[],researchAt);
  const requirements=originRows.map(r=>({currency:r.currency,factor:r.factor,...coreRequirement(r.factor as Parameters<typeof coreRequirement>[0],r.currency as Parameters<typeof coreRequirement>[1])}));
  const eventTargets=eventTargetStatus(await verifiedEvents(env.DB));
  const mlInfluence=config.ml?Math.max(0,...attributions.map(a=>a.mlWeight)):0;
  const hypothesisInfluence=config.hypothesis?Math.max(0,...attributions.map(a=>a.hypothesisWeight)):0;
  const adaptiveTotalInfluence=Math.max(0,...attributions.map(a=>(config.ml?a.mlWeight:0)+(config.hypothesis?a.hypothesisWeight:0)));
  const allModels=[...s.models,...s.contextModels];
  const validationOutcomes:ResolvedTarget[]=[];for(const horizon of outcomeHorizons)validationOutcomes.push(...await targets(env.DB,horizon));
  const validation=validationSummaries(validationOutcomes,s.models);
  const mlStatus=!config.enabled||!config.ml?'DISABLED':mlInfluence>0?'ACTIVE':allModels.some(m=>m.status==='DEGRADED')?'DEGRADED':allModels.some(m=>m.status==='SHADOW')?'SHADOW':s.trainingExamples<100?'WAITING_FOR_DATA':'VALIDATING';
  const runtimeFlags={ADAPTIVE_ENABLED:config.enabled,ML_ENABLED:config.ml,HYPOTHESIS_ENGINE_ENABLED:config.hypothesis};
  const runtimeGateStatus=!config.enabled||config.cap===0?'DISABLED':!config.ml||!config.hypothesis?'PARTIALLY_DISABLED':'AUTOMATIC_QUALIFICATION_ENABLED';
  const lifecycleCounts=Object.fromEntries(['DISCOVERY','TESTING','VALIDATING','SHADOW','ACTIVE','DEGRADED','REJECTED'].map(status=>[status,s.registry.filter(r=>r.status===status).length]));
  const diagnostics={mlStatus,runtimeFlags,runtimeGateStatus,adaptiveTotalInfluence,adaptiveCap:config.cap,dataSourceStatus:coveragePayload.sourceMode,hypothesisLifecycle:lifecycleCounts,validation,validationVersion:VALIDATION_VERSION,evidencePipelineStatus:!fresh?'CORE_FALLBACK':adaptiveTotalInfluence>0?'GATED_ADAPTIVE_ACTIVE':'CORE_ONLY_WAITING_FOR_VALIDATION',automaticActivationRequires:'Frozen OOS + prospective shadow, date-cluster HAC effective information, calibration, multiple testing, >=2 regimes, incremental value, current source quality and qualification; retrain alone never activates'};
  const rest={lastSuccessfulDailyRefresh,lastSuccessfulRealCronRefresh,lastRegularWeeklyRetrain,researchCoverage:research,coreRequirements:requirements,weeklyVerification:lastRegularWeeklyRetrain?'REGULAR_INVOCATION_OBSERVED':'WAITING_FOR_NEXT_SCHEDULED_RUN',coverage,carriedInputs:originRows.filter(r=>r.status!=='OBSERVED'),notConnected:unavailableClasses,sourceChecks:sourceStatus?.checks??[],eventTargets,contextLearning:{status:s.contextModels.length?'SHADOW_OR_VALIDATING':'WAITING_FOR_DATA',champions:s.contextChampionIds,models:s.contextModels.map(m=>({id:m.id,scope:m.scope,horizon:m.horizon,status:m.status,samples:m.trainingSamples,gate:m.gate,incrementalGate:m.incrementalGate,historicalGate:m.historicalGate,historicalIncrementalGate:m.historicalIncrementalGate,holdoutGate:m.holdoutGate,holdoutIncrementalGate:m.holdoutIncrementalGate,folds:m.folds.length,purgedRows:m.folds.reduce((n,f)=>n+(f.removed?.length??0),0)}))},testingHypotheses:s.registry.filter(r=>['DISCOVERY','TESTING','VALIDATING'].includes(r.status)).length};
  return {...rest,...diagnostics,version:ADAPTIVE_VERSION,status:fresh?s.status:'CORE_FALLBACK',lastSuccessfulSnapshot:snapshots?.latest??null,snapshotCount:snapshots?.count??0,observationCount:row?.observations??0,observationVintages:vintageCount?.count??0,coreInputQuality,sourceReliability:sourceStatus?.providers??{},counts:counts.results,trainingExamples:s.trainingExamples,resolvedOutcomes:counts.results.filter(c=>c.kind.startsWith('outcome:')).reduce((n,c)=>n+c.count,0),lastRetrain:s.lastRetrain,currentMlVersion:[...s.championIds,...s.contextChampionIds.filter(id=>s.contextModels.some(m=>m.id===id&&m.scope==='currency'))].join(',')||'DETERMINISTIC_CORE',challengerVersions:s.models.map(m=>({id:m.id,status:m.status,samples:m.trainingSamples,gate:m.gate})),mlInfluence,hypothesisInfluence,hypothesisCount:s.registry.length,activeHypotheses:s.registry.filter(r=>r.status==='ACTIVE').length,shadowHypotheses:s.registry.filter(r=>r.status==='SHADOW').length,rejectedHypotheses:s.registry.filter(r=>r.status==='REJECTED').length,registry:s.registry,failedDataSources:sourceStatus?.checks?.filter((c:{status:string})=>c.status!=='SUCCESS')??[],lastError:s.lastError,rollbackCount:s.rollbackCount,evidenceHistory:history.results.map(r=>JSON.parse(r.payload)),config:configuration(env),notice:'Prospective currency-basket validation. Daily fixing excursions are not intraday MFE/MAE. Model-generated dispersion is not an empirical confidence interval.'};
}

/** Fail closed also on read: runtime kill switches never wait for tomorrow's snapshot. */
export async function guardProductionPayload(env:ProductionEnv,p:TerminalPayload){
  try{const s=await state(env.DB),config=configuration(env);if(!config.enabled||s.lastError||Date.now()-Date.parse(s.at)>36*3600000)throw new Error('ADAPTIVE_DISABLED');
    for(const c of p.currencies){const a=c.evidenceAttribution;if(!a)continue;
      if(a.version!==ADAPTIVE_VERSION||a.factorFingerprint!==factorFingerprint(c)||!Number.isFinite(Date.parse(a.expiresAt))||Date.parse(a.expiresAt)<Date.now()||!Number.isFinite(a.cap)){delete c.evidenceAttribution;continue;}
      const current=(m:{status:string;gate:Gate;historicalGate?:Gate;holdoutGate?:Gate;lastValidatedAt?:string;lastChangedAt:string})=>m.status==='ACTIVE'&&certified(m)&&m.gate.validationVersion===VALIDATION_VERSION&&m.gate.passed&&Date.now()-Date.parse(m.lastValidatedAt??m.lastChangedAt)<180*dayMs;
      const valid=a.components.filter(x=>x.kind==='ML'?config.ml&&(s.championIds.includes(x.id)&&s.models.some(m=>m.id===x.id&&current(m))||s.contextChampionIds.includes(x.id)&&s.contextModels.some(m=>m.id===x.id&&m.scope==='currency'&&current(m)&&incrementalCertified(m)&&m.incrementalGate.validationVersion===VALIDATION_VERSION&&m.incrementalGate.passed)):config.hypothesis&&s.registry.some(r=>r.id===x.id&&effectiveRecipeWeight(r,new Date().toISOString())>0));
      c.evidenceAttribution=combineEvidence(c,valid,{at:a.at,cap:Math.min(config.cap,a.cap),enabled:true,modelVersion:a.modelVersion,regime:a.regime});
    }
  }catch{for(const c of p.currencies)delete c.evidenceAttribution;}return p;
}

export async function productionFailure(env:ProductionEnv,at:string,stage:string){
  try{const s=await state(env.DB);await env.DB.batch([stateWrite(env.DB,{...s,at,status:'FAILED_CORE_FALLBACK',lastError:stage}),record(env.DB,'error',`error:${at}:${stage}`,at,{stage,adaptiveInfluence:0})]);}catch{console.error('PRODUCTION_RECORD_FAILURE');}
}
