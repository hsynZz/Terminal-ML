import { currencies, factorMeta, getBaselinePayload, rebuildDerivedScores, strengthScore, type CurrencyCode, type FactorKey, type TerminalPayload } from './terminal-data';
import type { Receipt } from './hypothesis/provenance';
import { coreEvidence, evidenceShift } from './adaptive-evidence';

export const DATA_VERSION = 'observed-core-v2';
export type Observation = Receipt & { sourceUrl:string; unit:string; releaseDate:string|null; normalizedValue?:number|null; quality:'VALID'|'STALE'|'INVALID'; frequency:string; definition?:string; featureVersion?:string; economicCause?:string; lineage?:string[]; rawInputs?:unknown[] };
export type SourceCheck = {at:string;source:string;url:string;currency:string;metrics:string[];status:'SUCCESS'|'FAILED'|'MISSING';cause:string|null;fallback:string;latencyMs:number};
export type FactorOrigin={status:string;source:string;period:string|null;availableAt:string|null;availability?:string;sourceUrls?:string[];qualityStatus?:string;releaseDate?:string|null;failure?:string|null;fallback?:string;frequency?:string;definition?:string};
export type ProductionPayload = TerminalPayload & { calculationVersion?:string; sourceChecks?:SourceCheck[]; observationSummary?:{count:number;changed:number;failedSources:string[]}; historyStatus?:string; coreFactors?:Record<string,Record<string,FactorOrigin>>; sourceCoverage?:{factors:number;fresh:number;carried:number;partial:number;ratio:number} };
export const dayMs=86400000;
const clamp=(v:number)=>Math.max(0,Math.min(1,v));
const rank=(v:number,a:number[])=>Math.max(...a)===Math.min(...a)?.5:(v-Math.min(...a))/(Math.max(...a)-Math.min(...a));

/** Versioned repair: same weights/formulas, stable risk anchor, rates reach their factors. */
export function repairDerivedScores(payload:ProductionPayload) {
  const anchor=getBaselinePayload().currencies;
  for(const c of payload.currencies)c.factors.risk=anchor.find(x=>x.code===c.code)!.factors.risk;
  rebuildDerivedScores(payload.currencies);
  for(const c of payload.currencies){
    const a=anchor.find(x=>x.code===c.code)!;
    c.factors.policy=clamp(a.factors.policy+rank(c.rate,payload.currencies.map(x=>x.rate))-rank(a.rate,anchor.map(x=>x.rate)));
    c.factors.yields=clamp(a.factors.yields+.5*(rank(c.yield2y,payload.currencies.map(x=>x.yield2y))-rank(a.yield2y,anchor.map(x=>x.yield2y)))+.5*(rank(c.yield10y,payload.currencies.map(x=>x.yield10y))-rank(a.yield10y,anchor.map(x=>x.yield10y))));
    c.history[0]={ageDays:0,score:strengthScore(c)};
  }
  payload.calculationVersion=DATA_VERSION;
  return payload;
}

export function historicalScores(payload:ProductionPayload, history:TerminalPayload[]) {
  for(const c of payload.currencies){
    const score=strengthScore(c);
    c.history=[0,10,30,60,90].map(ageDays=>{
      const cutoff=Date.parse(payload.asOf)-ageDays*dayMs;
      const row=ageDays?history.filter(p=>Date.parse(p.asOf)<=cutoff).sort((a,b)=>b.asOf.localeCompare(a.asOf))[0]:payload;
      const old=row?.currencies.find(x=>x.code===c.code);
      // Neutral projection when history is absent; status explicitly identifies the missing datum.
      return {ageDays,score:old?coreEvidence(old)+evidenceShift(old,Date.parse(row!.asOf)):score,observedAt:row?.asOf??null,available:!!old};
    });
  }
  payload.historyStatus='ARCHIVED_SNAPSHOTS; missing anchors use neutral projection, never synthetic history';
}

export function truthfulEvidence(payload:ProductionPayload, receipts:Receipt[]) {
  const dependencies:Record<FactorKey,string[]>={policy:['rate'],yields:['yield2y','yield10y'],inflation:['rate','inflation'],growth:['growth','unemployment'],risk:['currentAccount','debt'],momentum:['momentum'],sentiment:['nlpSentiment'],cot:['cot'],commodities:['commodities'],seasonality:['seasonality']};
  const factorStatus:NonNullable<ProductionPayload['coreFactors']>={};
  for(const c of payload.currencies){
    factorStatus[c.code]={};
    for(const factor of Object.keys(factorMeta) as FactorKey[]){
      const required=dependencies[factor],rows=required.map(metric=>receipts.find(r=>r.currency===c.code&&r.metric===metric));
      const available=rows.every(r=>r&&observationQuality(r.metric,r.value,r.period,payload.asOf)==='VALID');
      const ranked=['policy','yields','inflation','growth'].includes(factor),complete=!ranked||currencies.every(code=>required.every(metric=>receipts.some(r=>r.currency===code&&r.metric===metric&&observationQuality(metric,r.value,r.period,payload.asOf)==='VALID')));
      const received=rows.filter((r):r is Receipt=>!!r) as Observation[],latest=received.sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt))[0],prior=payload.coreFactors?.[c.code]?.[factor];
      const failures=payload.sourceChecks?.filter(r=>r.status!=='SUCCESS'&&(r.currency===c.code||r.currency==='ALL')&&r.metrics.some(m=>required.includes(m)))??[];
      const status=factor==='risk'?'PARTIAL_ANCHORED':available&&complete?'OBSERVED':available?'PARTIAL_CROSS_SECTION':'LEGACY_OR_CARRIED';
      factorStatus[c.code][factor]={status,availability:status==='OBSERVED'?'FRESH':received.some(r=>observationQuality(r.metric,r.value,r.period,payload.asOf)==='STALE')?'STALE':failures.length?'FALLBACK':'CARRIED INPUT',source:available?[...new Set(received.map(r=>r.source))].join(' + '):prior?.source??'Preserved baseline/carried factor',period:latest?.period??prior?.period??null,availableAt:available?latest!.receivedAt:prior?.availableAt??null,sourceUrls:[...new Set(received.flatMap(r=>(r.sourceUrl??'').split(/\s+/).filter(Boolean)))],qualityStatus:status==='OBSERVED'?'VALID':status,releaseDate:latest?.releaseDate??null,failure:failures.map(r=>`${r.source}: ${r.cause}`).join('; ')||null,fallback:status==='OBSERVED'?'none':available?'Cross-section or risk anchor contains carried values':'CARRIED INPUT; no fresh observation certified',frequency:latest?.frequency??(latest?.period.length===4?'annual':'unknown'),definition:latest?.definition};
    }
  }
  payload.coreFactors=factorStatus;
  const origins=Object.values(factorStatus).flatMap(Object.values),fresh=origins.filter(m=>m.status==='OBSERVED').length;
  payload.sourceCoverage={factors:origins.length,fresh,carried:origins.filter(m=>m.status==='LEGACY_OR_CARRIED').length,partial:origins.filter(m=>m.status.startsWith('PARTIAL')).length,ratio:fresh/Math.max(1,origins.length)};
  payload.evidence=payload.evidence.map(e=>{const m=factorStatus[e.currency][e.factor];return {...e,ageDays:m.availableAt?Math.max(0,(Date.parse(payload.asOf)-Date.parse(m.availableAt))/dayMs):e.ageDays,observedAt:m.availableAt??e.observedAt,source:m.source,quality:m.availability+'; '+m.status,observationPeriod:m.period,releaseDate:m.releaseDate??null};});
  return payload;
}

/** ECB fixes: X units per EUR -> USD per X; no assertion that these are market closes. */
export function parseEcbRates(xml:string,receivedAt:string):Observation[] {
  const result:Observation[]=[];
  const url='https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml';
  for(const group of xml.matchAll(/<Cube\s+time=['"]([\d-]+)['"]\s*>([\s\S]*?)<\/Cube>/g)){
    if(group[1]>receivedAt.slice(0,10))continue;
    const rates:Record<string,number>={EUR:1};
    for(const rate of group[2].matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g))rates[rate[1]]=Number(rate[2]);
    if(!currencies.every(c=>Number.isFinite(rates[c])&&rates[c]>0))continue;
    for(const currency of currencies)result.push({currency,metric:'fxReferenceUsd',value:rates.USD/rates[currency],period:group[1],source:'ECB reference fixing',sourceUrl:url,receivedAt,unit:'USD per currency',releaseDate:null,quality:'VALID',frequency:'business-daily'});
  }
  return result;
}
export function momentumFromObservations(rows:Observation[],currency:CurrencyCode){
  const values=rows.filter(r=>r.currency===currency).sort((a,b)=>b.period.localeCompare(a.period));
  if(values.length<20)return null;
  const short=Math.log(values[0].value/values[19].value),long=Math.log(values[0].value/values[Math.min(59,values.length-1)].value);
  return Math.max(.05,Math.min(.95,.5+short*4.5+long*2.2));
}

export function observationQuality(metric:string,value:number,period:string,at:string):Observation['quality']{
  if(!Number.isFinite(value)||!/^\d{4}(-\d{2}-\d{2})?$/.test(period)||!Number.isFinite(Date.parse(period))||Date.parse(period)>Date.parse(at))return 'INVALID';
  const bounds:Record<string,[number,number]>={rate:[-10,100],yield2y:[-10,100],yield10y:[-10,100],inflation:[-100,1000],growth:[-100,100],unemployment:[0,100],debt:[0,1000],currentAccount:[-100,100],momentum:[0,1],nlpSentiment:[0,1],vix:[0,200]};
  const range=metric==='cot'?[0,1]:bounds[metric];if(range&&(value<range[0]||value>range[1]))return 'INVALID';
  if(metric.startsWith('fx')&&(value<=0||value>1000))return 'INVALID';
  const annual=period.length===4,age=(Date.parse(at)-Date.parse(period+(annual?'-12-31':'')))/dayMs;
  const maxAge=annual?1095:metric==='rate'||metric==='cot'||metric.startsWith('alt.cot.')?14:metric.includes('funding.')||metric.includes('labor.')?21:metric.includes('consumption.')?75:10;
  return age>maxAge?'STALE':'VALID';
}
