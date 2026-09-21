import { factorMeta, type CurrencySnapshot, type FactorKey } from './terminal-data';
export const ADAPTIVE_VERSION='adaptive-evidence-v2';
export type EvidenceComponent={id:string;kind:'ML'|'HYPOTHESIS';score:number;weight:number;confidence:number;regimeFit:number;sourceReliability:number;validated:boolean};
export type EvidenceAttribution={version:string;at:string;expiresAt:string;factorFingerprint:string;coreEvidenceScore:number;mlContribution:number;hypothesisContribution:number;finalEvidenceScore:number;mlWeight:number;hypothesisWeight:number;cap:number;status:string;components:(EvidenceComponent&{effectiveWeight:number;contribution:number})[];modelVersion:string|null;regime:string};
export const factorFingerprint=(c:Pick<CurrencySnapshot,'factors'>)=>JSON.stringify(Object.keys(factorMeta).map(k=>c.factors[k as FactorKey]));
export const coreEvidence=(c:Pick<CurrencySnapshot,'factors'>)=>Math.max(0,Math.min(1,Object.entries(factorMeta).reduce((n,[key,m])=>n+c.factors[key as FactorKey]*m.weight,0)));
const unit=(v:number)=>Number.isFinite(v)&&v>=0&&v<=1;
/** A convex mixture with one shared mass cap for both adaptive layers. */
export function combineEvidence(c:Pick<CurrencySnapshot,'factors'>,components:EvidenceComponent[],options:{at:string;cap?:number;enabled?:boolean;modelVersion?:string|null;regime?:string}):EvidenceAttribution{
  const core=coreEvidence(c),cap=Math.min(.15,Math.max(0,Number.isFinite(options.cap)?options.cap!:.1));
  const valid=options.enabled===false?[]:components.filter(x=>x.validated&&[x.score,x.weight,x.confidence,x.regimeFit,x.sourceReliability].every(unit));
  const raw=valid.map(c=>({...c,effectiveWeight:c.weight*c.confidence*c.regimeFit*c.sourceReliability}));
  const mass=raw.reduce((n,c)=>n+c.effectiveWeight,0),scale=mass>cap?cap/mass:1;
  const parts=raw.map(c=>({...c,effectiveWeight:c.effectiveWeight*scale,contribution:c.effectiveWeight*scale*(c.score-core)}));
  const sum=(kind:EvidenceComponent['kind'],field:'contribution'|'effectiveWeight')=>parts.filter(c=>c.kind===kind).reduce((n,c)=>n+c[field],0);
  const ml=sum('ML','contribution'),hyp=sum('HYPOTHESIS','contribution');
  return {version:ADAPTIVE_VERSION,at:options.at,expiresAt:new Date(Date.parse(options.at)+36*3600000).toISOString(),factorFingerprint:factorFingerprint(c),coreEvidenceScore:core,mlContribution:ml,hypothesisContribution:hyp,finalEvidenceScore:Math.max(0,Math.min(1,core+ml+hyp)),mlWeight:sum('ML','effectiveWeight'),hypothesisWeight:sum('HYPOTHESIS','effectiveWeight'),cap,status:parts.some(p=>p.effectiveWeight>0)?'ACTIVE':'SHADOW',components:parts,modelVersion:options.modelVersion??null,regime:options.regime??'unknown'};
}
export function evidenceShift(c:Pick<CurrencySnapshot,'factors'>&{evidenceAttribution?:EvidenceAttribution},now=Date.now()){
  const a=c.evidenceAttribution;
  if(!a||a.version!==ADAPTIVE_VERSION||a.status!=='ACTIVE'||!Number.isFinite(Date.parse(a.at))||!Number.isFinite(Date.parse(a.expiresAt))||Date.parse(a.at)>now||Date.parse(a.expiresAt)<now||a.factorFingerprint!==factorFingerprint(c))return 0;
  const core=coreEvidence(c),delta=a.mlContribution+a.hypothesisContribution;
  if(![core,a.coreEvidenceScore,a.finalEvidenceScore,a.mlWeight,a.hypothesisWeight,a.cap].every(unit)||!Number.isFinite(delta)||Math.abs(a.coreEvidenceScore-core)>1e-12||Math.abs(a.finalEvidenceScore-core-delta)>1e-12||a.mlWeight+a.hypothesisWeight>Math.min(.15,a.cap)+1e-12)return 0;
  const reconstructed=combineEvidence(c,a.components,{at:a.at,cap:a.cap});
  if(Math.abs(reconstructed.mlContribution-a.mlContribution)>1e-12||Math.abs(reconstructed.hypothesisContribution-a.hypothesisContribution)>1e-12)return 0;
  return delta;
}
