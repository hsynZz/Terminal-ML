import { currencies, factorMeta, type FactorKey, type TerminalPayload } from '../terminal-data';

export const PROVENANCE_VERSION = 'as-received-v1';
export type Receipt = {
  currency:string; metric:string; value:number; period:string; source:string; receivedAt:string;
  observations?:{period:string;value:number}[];
  sourceUrl?:string;
};
export type InputRecord = {
  value:number|null; availableAt:string|null; source:string; period:string|null;
  status:'OBSERVED'|'CARRIED'|'UNVERIFIED'; receipt?:Receipt;
};
export type FactorRecord = {
  value:number; availableAt:string|null; verified:boolean; dependencies:string[]; method:string;
};
export type Provenance = {
  version:typeof PROVENANCE_VERSION; snapshotAsOf:string; capturedAt:string;
  inputs:Record<string,InputRecord>; factors:Record<string,FactorRecord>; regimeVerified:boolean; digest:string;
};
export type ProvenancePayload = TerminalPayload & {inputProvenance?:Provenance};
const atOrBefore=(value:unknown,cutoff:string)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=Date.parse(cutoff);
export async function digest(value:unknown) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function verifyProvenance(value:Provenance|undefined) {
  if(!value||value.version!==PROVENANCE_VERSION||!value.inputs||!value.factors)return false;
  const {digest:expected,...body}=value;
  return expected===await digest(body);
}

/** Availability means actual receipt, never the economic period or an invented release date.
 * This metadata records the existing calculation; it does not change any core input. */
export async function captureProvenance(payload:TerminalPayload,prior:ProvenancePayload|undefined,receipts:Receipt[]):Promise<Provenance> {
  const at=payload.asOf,old=prior?.inputProvenance;
  const priorOK=await verifyProvenance(old)&&!!old&&old.snapshotAsOf===prior?.asOf&&atOrBefore(old.capturedAt,at);
  const inputs:Record<string,InputRecord>={},factors:Record<string,FactorRecord>={};
  const rawKeys=['rate','inflation','growth','unemployment','currentAccount','debt','yield2y','yield10y'] as const;
  for(const c of payload.currencies)for(const metric of rawKeys) {
    const id=c.code+':'+metric,value=c[metric];
    const fresh=receipts.find(r=>r.currency===c.code&&r.metric===metric&&r.value===value&&atOrBefore(r.receivedAt,at));
    const previous=priorOK?old?.inputs[id]:undefined;
    inputs[id]=fresh?{value,availableAt:fresh.receivedAt,source:fresh.source,period:fresh.period,status:'OBSERVED',receipt:fresh}
      :previous&&previous.value===value&&previous.status!=='UNVERIFIED'&&atOrBefore(previous.availableAt,at)?{...previous,status:'CARRIED'}
      :{value,availableAt:null,source:'Unknown legacy or fallback input',period:null,status:'UNVERIFIED'};
  }
  for(const c of payload.currencies)for(const key of Object.keys(factorMeta) as FactorKey[]) {
    const id=c.code+':'+key,value=c.factors[key],previous=priorOK?old?.factors[id]:undefined;
    factors[id]=previous?.verified&&previous.value===value&&atOrBefore(previous.availableAt,at)
      ?{...previous}:{value,availableAt:null,verified:false,dependencies:[],method:'legacy-or-fallback'};
    if(factors[id].verified)for(const dep of factors[id].dependencies)if(!inputs[dep]&&old?.inputs[dep])inputs[dep]=old.inputs[dep];
  }
  function derived(id:string,value:number,deps:string[],method:string,extraOK=true) {
    const rows=deps.map(key=>inputs[key]);
    const verified=extraOK&&Number.isFinite(value)&&rows.length>0&&rows.every(r=>r&&r.status!=='UNVERIFIED'&&typeof r.value==='number'&&Number.isFinite(r.value)&&atOrBefore(r.availableAt,at));
    factors[id]={value,dependencies:deps,method,verified,availableAt:verified?rows.map(r=>r.availableAt!).sort().at(-1)!:null};
  }
  const momentum=receipts.filter(r=>r.metric==='momentum'&&atOrBefore(r.receivedAt,at));
  for(const r of momentum) {
    const id=r.currency+':momentum-receipt';
    inputs[id]={value:r.value,availableAt:r.receivedAt,source:r.source,period:r.period,status:'OBSERVED',receipt:r};
    const c=payload.currencies.find(c=>c.code===r.currency),closes=r.observations??[];
    const complete=closes.length>=2&&closes.every(x=>Number.isFinite(x.value)&&x.value>0&&/^\d{4}-\d{2}-\d{2}$/.test(x.period)&&x.period<=r.receivedAt.slice(0,10));
    if(c?.factors.momentum===r.value)derived(r.currency+':momentum',r.value,[id],'alpha-momentum-v1',complete);
  }
  const usd=payload.currencies.find(c=>c.code==='USD');
  if(usd&&momentum.length)derived('USD:momentum',usd.factors.momentum,momentum.map(r=>r.currency+':momentum-receipt'),'one-minus-received-mean-v1',
    usd.factors.momentum===1-momentum.reduce((s,r)=>s+r.value,0)/momentum.length&&momentum.every(r=>factors[r.currency+':momentum']?.verified));
  for(const c of payload.currencies) {
    derived(c.code+':inflation',c.factors.inflation,[c.code+':rate',c.code+':inflation'],'existing-inflation-v1');
    derived(c.code+':growth',c.factors.growth,currencies.flatMap(code=>[code+':growth',code+':unemployment']),'existing-cross-sectional-growth-v1');
    // The legacy half of the recursive risk factor must never silently become certified.
    const previous=priorOK?old?.factors[c.code+':risk']:undefined,id=c.code+':previous-risk';
    inputs[id]={value:prior?.currencies.find(p=>p.code===c.code)?.factors.risk??null,availableAt:previous?.availableAt??null,
      source:'Previous archived risk factor',period:old?.snapshotAsOf??null,status:previous?.verified?'CARRIED':'UNVERIFIED'};
    derived(c.code+':risk',c.factors.risk,[id,...currencies.flatMap(code=>[code+':currentAccount',code+':debt'])],'existing-recursive-risk-v1',!!previous?.verified);
  }
  const vix=receipts.find(r=>r.currency==='GLOBAL'&&r.metric==='vix'&&r.value===payload.regime.vix&&atOrBefore(r.receivedAt,at));
  if(vix)inputs['GLOBAL:vix']={value:vix.value,availableAt:vix.receivedAt,source:vix.source,period:vix.period,status:'OBSERVED',receipt:vix};
  const body={version:PROVENANCE_VERSION,snapshotAsOf:at,capturedAt:at,inputs,factors,
    regimeVerified:!!vix&&currencies.every(c=>factors[c+':risk']?.verified&&factors[c+':momentum']?.verified)} as const;
  return {...body,digest:await digest(body)};
}
type FrameInput={issuedAt:string;snapshotAsOf:string;factors:Record<string,Partial<Record<FactorKey,number>>>;provenance?:Provenance};
export function inputVerified(frame:FrameInput,currency:string,key:FactorKey) {
  const p=frame.provenance,r=p?.factors[currency+':'+key];
  return !!r?.verified&&p?.version===PROVENANCE_VERSION&&p.snapshotAsOf===frame.snapshotAsOf&&atOrBefore(p.capturedAt,frame.issuedAt)&&
    atOrBefore(r.availableAt,frame.issuedAt)&&r.value===frame.factors[currency]?.[key]&&Number.isFinite(r.value)&&r.dependencies.length>0&&
    r.dependencies.every(id=>{const v=p.inputs[id];return v&&v.status!=='UNVERIFIED'&&typeof v.value==='number'&&Number.isFinite(v.value)&&atOrBefore(v.availableAt,frame.issuedAt);});
}
export function signalProvenance(h:{kind:string;inputs:FactorKey[];lag:number},frame:FrameInput,history:FrameInput[],currency:string) {
  const check=(f:FrameInput|undefined,keys:FactorKey[])=>!!f&&keys.every(k=>inputVerified(f,currency,k)&&inputVerified(f,'USD',k));
  const lag=(days:number)=>[...history].filter(f=>Date.parse(f.issuedAt)<=Date.parse(frame.issuedAt)-days*86400000&&Date.parse(f.issuedAt)>=Date.parse(frame.issuedAt)-(days+4)*86400000).sort((a,b)=>b.issuedAt.localeCompare(a.issuedAt))[0];
  if(!check(frame,h.inputs))return false;
  if(h.lag&&!check(lag(30),[h.kind==='growth-acceleration'?'growth':h.kind==='lagged-yields'?'yields':'policy']))return false;
  if(h.lag===60&&!check(lag(60),['growth']))return false;
  return frame.provenance?.regimeVerified===true;
}
