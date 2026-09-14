import { advance, factory, flags, makeFrame, PROTOCOL, SEARCH_BUDGET, statuses, type Frame, type Hypothesis } from "../lib/hypothesis/engine";
import { buildPairForecast } from "../lib/model-engine";
import { currencies, sanitizeModelSettings, type TerminalPayload } from "../lib/terminal-data";
import type { AuditClose } from "../lib/calibration";
import { signalProvenance, verifyProvenance, PROVENANCE_VERSION, type ProvenancePayload } from "../lib/hypothesis/provenance";
import { allocation, buildOverlay } from "../lib/hypothesis/adapter";
import { archiveOutcomes } from "./hypothesis-outcomes";
import { productionOverlay } from "./hypothesis-integration";

interface Statement { bind(...v:unknown[]):Statement; first<T>():Promise<T|null>; all<T>():Promise<{results:T[]}>; run():Promise<{meta?:{changes?:number}}> }
export interface ResearchDB { prepare(sql:string):Statement; batch(statements:Statement[]):Promise<unknown> }
export type ResearchEnv={DB:ResearchDB;HYPOTHESIS_ENGINE_ENABLED?:string;HYPOTHESIS_PRODUCTION_WEIGHT?:string};
const PREFIX="hypothesis:v1:";
const FRAME_LIMIT=1024;
const json=<T>(value:string):T=>JSON.parse(value) as T;
export function captureReadiness(value:unknown): value is TerminalPayload {
  const p=value as Partial<TerminalPayload>|null;
  return !!p && typeof p.asOf==="string" && Number.isFinite(Date.parse(p.asOf)) &&
    !!p.regime && ["risk-on","neutral","risk-off"].includes(p.regime.label) &&
    Array.isArray(p.currencies) && currencies.every(code=>p.currencies!.some(c=>c.code===code && !!c.factors && Array.isArray(c.history) && c.history.length>=2));
}
function upsert(db:ResearchDB,key:string,value:unknown,at:string) {
  if(!key.startsWith(PREFIX)) throw new Error("RESEARCH_NAMESPACE_VIOLATION");
  return db.prepare("INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(key,JSON.stringify(value),at);
}
function insert(db:ResearchDB,key:string,value:unknown,at:string) {
  if(!key.startsWith(PREFIX)) throw new Error("RESEARCH_NAMESPACE_VIOLATION");
  return db.prepare("INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING").bind(key,JSON.stringify(value),at);
}
async function read<T>(db:ResearchDB,key:string) { const r=await db.prepare("SELECT value FROM terminal_settings WHERE key=?").bind(PREFIX+key).first<{value:string}>();return r?json<T>(r.value):null; }
async function frames(db:ResearchDB) {
  const r=await db.prepare("SELECT value FROM terminal_settings WHERE key>=? AND key<? ORDER BY key ASC LIMIT ?").bind(PREFIX+"frame:",PREFIX+"frame;",FRAME_LIMIT+1).all<{value:string}>();
  return {rows:r.results.slice(0,FRAME_LIMIT).map(r=>json<Frame>(r.value)),truncated:r.results.length>FRAME_LIMIT};
}
export async function researchStatus(env:ResearchEnv) {
  const [state,last,audit]=await Promise.all([read<{hypotheses:Hypothesis[];dataQuality:unknown;updatedAt:string}>(env.DB,"state"),read<unknown>(env.DB,"last-run"),env.DB.prepare("SELECT value FROM terminal_settings WHERE key>=? AND key<? ORDER BY key DESC LIMIT 50").bind(PREFIX+"audit:",PREFIX+"audit;").all<{value:string}>()]);
  const hypotheses=state?.hypotheses??[];
  const overlay=await productionOverlay(env);
  const contribution=overlay?Math.max(0,...overlay.items.map(i=>i.weight)):0;
  return {protocol:PROTOCOL,flags:flags(env),currentContribution:contribution,maxContribution:.05,productionIntegration:flags(env).requestedWeight===0?"READY_DISABLED":overlay?"ACTIVE_USD_PAIRS":"WAITING_FOR_VERIFIED_DATA",searchBudget:SEARCH_BUDGET,
    counts:Object.fromEntries(statuses.map(s=>[s,hypotheses.filter(h=>h.status===s).length])),hypotheses,lastRun:last,dataQuality:state?.dataQuality??null,
    updatedAt:state?.updatedAt??null,audit:audit.results.map(r=>json(r.value)),limits:{historicalBlocks:120,shadowBlocks:30,walkForwardFolds:3,frameReadLimit:FRAME_LIMIT},
    notice:"USD-pair probability adapter only. Fundamental scores, currency clouds, core model and training data stay unchanged."};
}
/** Independent lease, append-only frames, atomic state+audit. Core refresh responses are untouched. */
export async function runResearch(env:ResearchEnv,source="POST_REFRESH",now=new Date().toISOString()) {
  if(!flags(env).enabled) return {status:"DISABLED",productionContribution:0};
  const id=crypto.randomUUID(),db=env.DB;
  const lease=await db.prepare("INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE CAST(json_extract(terminal_settings.value,'$.expiresAt') AS INTEGER) < ?").bind(PREFIX+"lease",JSON.stringify({id,expiresAt:Date.parse(now)+120000}),now,Date.parse(now)).run();
  if(!lease.meta?.changes) return {status:"BUSY",productionContribution:0};
  let stage="LOAD_STATE";
  try {
    const previous=await read<{hypotheses:Hypothesis[];updatedAt:string}>(db,"state");
    if(previous?.updatedAt.slice(0,10)===now.slice(0,10)) return {status:"ALREADY_EVALUATED",productionContribution:0};
    const hypotheses=previous?.hypotheses??factory(now);
    if(hypotheses.length!==SEARCH_BUDGET||hypotheses.some(h=>h.version!==PROTOCOL)) throw new Error("REGISTRY_VERSION_MISMATCH");
    const stored=await frames(db);
    if(stored.truncated) throw new Error("FRAME_READ_BUDGET_EXCEEDED_REQUIRES_PAGED_RESEARCH");
    stage="READ_INPUTS";
    const [latest,model,prices]=await Promise.all([
      db.prepare("SELECT as_of,payload FROM terminal_snapshots ORDER BY as_of DESC LIMIT 1").first<{as_of:string;payload:string}>(),
      db.prepare("SELECT value FROM terminal_settings WHERE key='model'").first<{value:string}>(),
      db.prepare("SELECT currency,period,value FROM currency_observations WHERE metric=? AND source=? ORDER BY period DESC LIMIT 20001").bind("fxCloseUsd","Alpha Vantage").all<AuditClose>(),
    ]);
    if(prices.results.length>20000) throw new Error("PRICE_READ_BUDGET_EXCEEDED_REQUIRES_PAGED_RESEARCH");
    const all=[...stored.rows], writes:Statement[]=[], events:unknown[]=[];
    // Recheck stored certificates before any historical or lagged frame can qualify.
    for(const f of all)if(!await verifyProvenance(f.provenance))delete f.provenance;
    for(const f of all)for(const signal of f.signals) {
      const h=hypotheses.find(h=>h.id===signal.id);
      signal.pointInTimeVerified=!!h&&signalProvenance(h,f,all,signal.pair.split('/')[0]);
    }
    const importExcluded={incompatibleSnapshot:0,missingArchivedForecasts:0};
    if(!previous) {
      stage="IMPORT_SNAPSHOTS";
      events.push(...hypotheses.map(h=>({event:"Hypothesis Created",id:h.id,reason:h.rationale,oldWeight:0,newWeight:0})));
      // Retrospective ONLY. Baselines come from actual archived forecasts, never today's fitted model.
      const [snapshots,archives]=await Promise.all([
        db.prepare("SELECT as_of,payload FROM terminal_snapshots ORDER BY as_of ASC LIMIT 129").all<{as_of:string;payload:string}>(),
        db.prepare("SELECT pair,horizon,probability,observed_at FROM model_debug_logs ORDER BY observed_at ASC LIMIT 5001").all<{pair:string;horizon:number;probability:number;observed_at:string}>(),
      ]);
      if(snapshots.results.length>128||archives.results.length>5000) throw new Error("HISTORICAL_IMPORT_BUDGET_EXCEEDED");
      for(const s of snapshots.results) {
        if(!Number.isFinite(Date.parse(s.as_of))||s.as_of>=now) continue;
        const raw=json<TerminalPayload>(s.payload); if(!["live","partial-live"].includes(raw.sourceMode)) continue;
        if(!captureReadiness(raw)) { importExcluded.incompatibleSnapshot++; continue; }
        const baseline:Record<string,number>={};
        for(const a of archives.results.filter(a=>a.observed_at===s.as_of&&a.pair.endsWith("/USD"))) baseline[`${a.pair.split("/")[0]}/${a.horizon}`]=a.probability;
        if(!Object.keys(baseline).length) { importExcluded.missingArchivedForecasts++; continue; }
        if(!await verifyProvenance((raw as ProvenancePayload).inputProvenance))delete (raw as ProvenancePayload).inputProvenance;
        const f=makeFrame(raw,s.as_of,`snapshot:${s.as_of}`,hypotheses,all,baseline);
        f.origin="ARCHIVED_SNAPSHOT";f.recordedAt=now;
        all.push(f); writes.push(insert(db,PREFIX+"frame:"+s.as_of,f,now));
      }
    }
    if(latest) {
      stage="CAPTURE_CURRENT";
      const payload=json<TerminalPayload>(latest.payload);
      if(!captureReadiness(payload)) throw new Error("CURRENT_SNAPSHOT_FORMAT_UNSUPPORTED");
      if(model) payload.model=sanitizeModelSettings(json(model.value));
      if(!await verifyProvenance((payload as ProvenancePayload).inputProvenance))delete (payload as ProvenancePayload).inputProvenance;
      // Reject stale/baseline/malformed data rather than hydrating synthetic factor defaults.
      if(["live","partial-live"].includes(payload.sourceMode)&&Date.parse(now)-Date.parse(latest.as_of)<=48*3600000) {
        const baselines:Record<string,number>={};
        for(const c of currencies.filter(c=>c!=="USD")) for(const f of buildPairForecast(payload,c,"USD")) baselines[`${c}/${f.horizon}`]=f.probability;
        const f=makeFrame(payload,now,`snapshot:${latest.as_of};model:${payload.model.trainedAt??"bootstrap"}`,hypotheses,all,baselines);
        all.push(f);writes.push(insert(db,PREFIX+"frame:"+now,f,now));
      }
    }
    const dataVersion=`${PROTOCOL};frames=${all.length};through=${all.at(-1)?.issuedAt??"none"}`;
    stage="ARCHIVE_OUTCOMES";
    const ledger=await archiveOutcomes(db,all,prices.results,now);
    stage="EVALUATE";
    const next=hypotheses.map(h=>allocation(advance(h,all,prices.results,now,dataVersion,ledger),h,flags(env),now));
    const overlay=buildOverlay(next,all.at(-1),flags(env),now);
    const contribution=overlay?Math.max(0,...overlay.items.map(i=>i.weight)):0;
    for(let i=0;i<next.length;i++) {
      const a=hypotheses[i],b=next[i];
      if(a.status!==b.status||a.weight!==b.weight||a.look!==b.look) events.push({event:b.status,id:b.id,reason:b.reason,previousStatus:a.status,oldWeight:a.weight,newWeight:b.weight,metrics:b.shadow??b.historical?.final??null});
    }
    const quality={importExcluded,snapshotCount:all.length,prospectiveCaptures:all.filter(f=>f.origin==="PROSPECTIVE_CAPTURE").length,
      historicalCaptures:all.filter(f=>f.origin==="ARCHIVED_SNAPSHOT").length,first:all[0]?.issuedAt??null,last:all.at(-1)?.issuedAt??null,
      priceRows:prices.results.length,priceSource:"Alpha Vantage daily closes; existing calendar-day outcome definition",pointInTimeVerified:all.length>0&&all.every(f=>f.signals.length>0&&f.signals.every(s=>s.pointInTimeVerified)),
      provenanceVersion:PROVENANCE_VERSION,verifiedSignals:all.reduce((n,f)=>n+f.signals.filter(s=>s.pointInTimeVerified).length,0),archivedOutcomes:ledger.length,
      source:"Persisted terminal snapshots and archived pair forecasts; prospective captures use the saved core model",
      limitations:["New receipts record actual retrieval time and exact inputs. Legacy/fallback factors remain unverified; economic periods are not release dates.","No historical consensus surprise series: surprise ideas are not generated.","FX currencies share USD exposure; inference uses time blocks, not currency count.","Embargo does not prove independent observations; regime and serial-dependence research remains necessary.","Completed research labels and their exact prices are archived once; provider revisions cannot overwrite them. New source coverage may still be required for legacy factors."],
      freshSnapshot:!!latest&&Date.parse(now)-Date.parse(latest.as_of)<=48*3600000,readLimitReached:false};
    const run={id,source,at:now,status:"SUCCESS",result:next.every(h=>h.status==="INSUFFICIENT_DATA")?"WAITING_FOR_DATA":"EVALUATED",candidates:next.length,frames:all.length,productionContribution:contribution,dataVersion};
    // Frame inserts are idempotent. State and its complete decision trail commit together.
    stage="SAVE_FRAMES";
    for(let i=0;i<writes.length;i+=25) await db.batch(writes.slice(i,i+25));
    stage="SAVE_STATE";
    await db.batch([
      upsert(db,PREFIX+"state",{hypotheses:next,updatedAt:now,dataQuality:quality,productionOverlay:overlay},now),
      insert(db,PREFIX+`audit:${now}:${id}`,{at:now,runId:id,version:PROTOCOL,dataVersion,events},now),
      insert(db,PREFIX+`run:${now}:${id}`,run,now),upsert(db,PREFIX+"last-run",run,now),
    ]);
    return run;
  } catch (error) {
    const known=["CURRENT_SNAPSHOT_FORMAT_UNSUPPORTED","REGISTRY_VERSION_MISMATCH","FRAME_READ_BUDGET_EXCEEDED_REQUIRES_PAGED_RESEARCH","PRICE_READ_BUDGET_EXCEEDED_REQUIRES_PAGED_RESEARCH","HISTORICAL_IMPORT_BUDGET_EXCEEDED","NO_FRESH_LIVE_SNAPSHOT","OUTCOME_READ_BUDGET_EXCEEDED","OUTCOME_INTEGRITY_FAILURE"];
    const code=error instanceof Error&&known.includes(error.message)?error.message:"STORAGE_OR_INPUT_ERROR";
    const run={id,source,at:now,status:"FAILED",stage,productionContribution:0,message:`${code} at ${stage}; research failed closed; core untouched.`};
    await db.batch([insert(db,PREFIX+`run:${now}:${id}`,run,now),upsert(db,PREFIX+"last-run",run,now)]).catch(()=>{});
    return run;
  } finally {
    await db.prepare("UPDATE terminal_settings SET value=? WHERE key=? AND json_extract(value,'$.id')=?").bind(JSON.stringify({id,expiresAt:0}),PREFIX+"lease",id).run();
  }
}
export function queueResearch(env:ResearchEnv,ctx:{waitUntil(p:Promise<unknown>):void}) {
  ctx.waitUntil(runResearch(env).catch(()=>({status:"FAILED",productionContribution:0})));
}
