import type { PairForecastPoint } from '../model-engine';
import { alphaFor, type Frame, type Hypothesis } from './engine';
import { PROVENANCE_VERSION } from './provenance';
import { nextWeight } from './safety';

export const ADAPTER_VERSION='usd-pair-probability-v1';
export type RuntimePolicy={enabled:boolean;requestedWeight:number};
export type OverlayItem={id:string;pair:string;horizon:number;signal:number;baseline:number;weight:number};
export type Overlay={version:typeof ADAPTER_VERSION;snapshotAsOf:string;issuedAt:string;expiresAt:string;items:OverlayItem[]};
const fresh=(at:string|undefined,now:string)=>!!at&&Number.isFinite(Date.parse(at))&&Date.parse(now)>=Date.parse(at)&&Date.parse(now)-Date.parse(at)<=48*3600000;
export function allocation(h:Hypothesis,previous:Hypothesis,policy:RuntimePolicy,now:string):Hypothesis {
  const zero={...h,weight:0};
  if(!policy.enabled||!Number.isFinite(policy.requestedWeight)||policy.requestedWeight<=0||policy.requestedWeight>.05)return {...zero,status:h.status==='PRODUCTION'?'VALIDATED':h.status};
  const e=h.shadow,history=h.historical;
  if(!e||!history?.passed||h.qualificationVersion!==PROVENANCE_VERSION||!h.pointInTimeVerified||!fresh(h.lastEvidenceAt,now)||
    !['VALIDATED','PRODUCTION','DEGRADED'].includes(h.status)||e.blocks<30||!e.metrics||!e.baseline||
    !Number.isInteger(h.look)||h.look<2||!Number.isInteger(e.blocks)||!Number.isFinite(previous.weight)||previous.weight<0||
    ![e.stability,e.metrics.logLoss,e.baseline.logLoss,e.metrics.expectedCalibrationError,e.baseline.expectedCalibrationError].every(Number.isFinite)||
    e.stability<0||e.stability>1||!Number.isFinite(e.p)||e.p<0||e.alpha!==alphaFor(h.look)||e.p>e.alpha||
    history.folds.length!==3||history.final.blocks<20||history.final.p>history.final.alpha)return zero;
  const regimes=h.regime==='all'?Object.values(e.regimes).filter(n=>n>=10).length>=2:(e.regimes[h.regime]??0)>=30;
  if(!regimes)return zero;
  if(e.improvement===null||!Number.isFinite(e.improvement)||e.improvement<=0||e.metrics.logLoss>=e.baseline.logLoss||
    e.metrics.expectedCalibrationError>e.baseline.expectedCalibrationError)return {...zero,status:'DEGRADED',reason:'Edge or calibration deterioration'};
  // A lookup/read can never grow or repeatedly halve the allocation for the same look.
  if(previous.lastAllocationLook===h.look)return {...h,weight:Math.min(previous.weight,policy.requestedWeight,.01),lastAllocationLook:previous.lastAllocationLook,lastAllocationBlocks:previous.lastAllocationBlocks};
  const decision=nextWeight({id:h.id,family:h.kind,regime:h.regime,signal:0,weight:previous.weight,evaluatedAt:h.lastEvidenceAt!,historicalPassed:true,shadowPassed:true,
    pointInTimeVerified:true,blocks:e.blocks,previousBlocks:previous.lastAllocationBlocks??e.blocks,meanImprovement:e.improvement??NaN,
    logLossImprovement:e.baseline.logLoss-e.metrics.logLoss,stability:e.stability,
    calibrationDegraded:e.metrics.expectedCalibrationError>e.baseline.expectedCalibrationError,recentSignals:[]},now);
  const weight=Math.min(decision.weight,policy.requestedWeight);
  return {...h,weight,status:weight>0?(decision.status==='DEGRADED'?'DEGRADED':'PRODUCTION'):decision.status==='DEGRADED'?'DEGRADED':h.status,
    reason:decision.reason,lastAllocationLook:h.look,lastAllocationBlocks:e.blocks,lastWeightChange:weight!==previous.weight?now:previous.lastWeightChange};
}

/** One qualified idea per pair/horizon. No unverified diversification or cross-pair extrapolation. */
export function buildOverlay(hypotheses:Hypothesis[],frame:Frame|undefined,policy:RuntimePolicy,now:string):Overlay|null {
  if(!policy.enabled||!Number.isFinite(policy.requestedWeight)||policy.requestedWeight<=0||policy.requestedWeight>.05||!frame||!fresh(frame.issuedAt,now)||!fresh(frame.snapshotAsOf,now))return null;
  const items:OverlayItem[]=[],seen=new Set<string>();
  for(const h of [...hypotheses].sort((a,b)=>a.id.localeCompare(b.id))) {
    if(h.qualificationVersion!==PROVENANCE_VERSION||!h.pointInTimeVerified||!h.historical?.passed||!h.shadow||h.shadow.blocks<30||!fresh(h.lastEvidenceAt,now)||
      allocation(h,h,policy,now).weight<=0||
      !['PRODUCTION','DEGRADED'].includes(h.status)||!Number.isFinite(h.weight)||h.weight<=0||h.weight>.01)continue;
    for(const s of frame.signals.filter(s=>s.id===h.id&&s.horizon===h.horizon&&s.phase==='SHADOW'&&s.pointInTimeVerified)) {
      const key=s.pair+':'+s.horizon;
      if(seen.has(key)||!s.pair.endsWith('/USD')||!Number.isFinite(s.signal)||Math.abs(s.signal)>1||!Number.isFinite(s.baseline)||s.baseline<=0||s.baseline>=1||
        (h.regime!=='all'&&h.regime!==frame.regime))continue;
      items.push({id:h.id,pair:s.pair,horizon:s.horizon,signal:s.signal,baseline:s.baseline,weight:Math.min(h.weight,policy.requestedWeight)});seen.add(key);
    }
  }
  if(!items.length)return null;
  return {version:ADAPTER_VERSION,snapshotAsOf:frame.snapshotAsOf,issuedAt:frame.issuedAt,
    expiresAt:new Date(Math.min(Date.parse(frame.issuedAt),Date.parse(frame.snapshotAsOf),...hypotheses.filter(h=>items.some(i=>i.id===h.id)).map(h=>Date.parse(h.lastEvidenceAt!)))+48*3600000).toISOString(),items};
}

export type AdjustedForecast=PairForecastPoint & {hypothesis?:{coreProbability:number;adjustment:number;weight:number;id:string}};
/** Same probability target as the predeclared experiment, with a smaller convex weight.
 * Fundamental scores and currency-cloud latent states are different targets and are not remapped. */
export function applyPairOverlay(core:PairForecastPoint[],pair:string,asOf:string,overlay:Overlay|null|undefined,now=new Date().toISOString()):AdjustedForecast[] {
  if(!overlay||overlay.version!==ADAPTER_VERSION||overlay.snapshotAsOf!==asOf||!fresh(overlay.issuedAt,now)||
    !Number.isFinite(Date.parse(overlay.expiresAt))||Date.parse(overlay.expiresAt)<Date.parse(now)||!Array.isArray(overlay.items))return core;
  let changed=false;
  const result=core.map(p=>{
    const matching=overlay.items.filter(x=>x.pair===pair&&x.horizon===p.horizon);
    if(matching.length!==1)return p;
    const i=matching[0];
    if(!pair.endsWith('/USD')||![i.signal,i.baseline,i.weight,p.probability].every(Number.isFinite)||i.weight<=0||i.weight>.01||Math.abs(i.signal)>1||Math.abs(i.baseline-p.probability)>1e-12)return p;
    const adjustment=Math.max(-.025,Math.min(.025,i.weight*(.5+.4*i.signal-p.probability)));
    if(adjustment===0)return p;
    changed=true;
    const probability=p.probability+adjustment;
    return {...p,probability,low:Math.min(probability,Math.max(0,p.low+adjustment)),high:Math.max(probability,Math.min(1,p.high+adjustment)),
      signal:Math.abs(probability-.5)<=p.neutralThreshold?'neutral' as const:probability>.5?'up' as const:'down' as const,
      hypothesis:{coreProbability:p.probability,adjustment,weight:i.weight,id:i.id}};
  });
  return changed?result:core;
}
