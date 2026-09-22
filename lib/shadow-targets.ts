import { currencies } from './terminal-data';
import { dayMs, type Observation } from './production-data';
import { outcomeHorizons, validationGate, type ResearchFrame, type ResolvedTarget, type Comparison } from './production-research';

export const TARGET_VERSION='fixing-events-v1';
export type EventTarget='BREAKOUT'|'REVERSAL'|'REGIME_TRANSITION'|'VOLATILITY_EXPANSION';
export type EventPrediction={id:string;target:EventTarget;currency:string;horizon:number;asOf:string;version:string;forecast:number;baseline:number|null;baselineSamples:number;calibrated:false;influence:0;upper:number;lower:number;trend:number;sigma:number;vix:number|null};
export type EventOutcome={id:string;predictionId:string;frameId:string;currency:string;target:EventTarget;horizon:number;asOf:string;labelEnd:string;resolvedAt:string;label:0|1;forecast:number;baseline:number|null;regime:string;version:string;source:string};
export const targetDefinitions:Record<EventTarget,string>={
  BREAKOUT:'Daily reference-fixing basket breaches frozen prior 20-fixing range after next-fixing entry. Not intraday breakout.',
  REVERSAL:'End basket return since next-fixing entry opposes frozen 20-fixing trend by more than one frozen sigma*sqrt(horizon).',
  VOLATILITY_EXPANSION:'Absolute basket return exceeds frozen sigma*sqrt(horizon). Magnitude, not direction.',
  REGIME_TRANSITION:'VIX fixing changes side of 20 at target date. Narrow volatility-regime proxy, not the full macro classifier.',
};
const mean=(a:number[])=>a.reduce((s,v)=>s+v,0)/Math.max(1,a.length);
const sigmoid=(n:number)=>Math.max(.05,Math.min(.95,1/(1+Math.exp(-n))));
function pricesAt(rows:Observation[],date:string,now:string){
  const prices:Record<string,number>={};
  for(const r of rows.filter(r=>r.metric==='fxReferenceUsd'&&r.source==='ECB reference fixing'&&r.period===date&&r.receivedAt<=now&&r.quality==='VALID').sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)))prices[r.currency]??=r.value;
  return currencies.every(c=>prices[c]>0)?prices:null;
}
const basket=(a:Record<string,number>,b:Record<string,number>,c:string)=>Math.log(a[c]/b[c])-mean(currencies.filter(k=>k!==c).map(k=>Math.log(a[k]/b[k])));
export function issueEventPredictions(frame:ResearchFrame,rows:Observation[],past:EventOutcome[]):EventPrediction[]{
  if(frame.quality!=='VALID')return [];
  const now=frame.at,dates=[...new Set(rows.filter(r=>r.metric==='fxReferenceUsd'&&r.receivedAt<=now&&r.period<=now.slice(0,10)).map(r=>r.period))].sort().slice(-25);
  const fixes=dates.flatMap(d=>{const p=pricesAt(rows,d,now);return p?[{date:d,prices:p}]:[];}).slice(-20);
  if(fixes.length<20||currencies.some(c=>frame.prices[c]!==fixes.at(-1)!.prices[c]))return [];
  const vix=rows.filter(r=>r.metric==='vix'&&r.currency==='GLOBAL'&&r.receivedAt<=now&&r.period<=now.slice(0,10)&&Date.parse(now)-Date.parse(r.period)<10*dayMs&&r.quality==='VALID').sort((a,b)=>b.period.localeCompare(a.period))[0]?.value??null;
  const result:EventPrediction[]=[];
  const add=(currency:string,target:EventTarget,horizon:number,forecast:number,upper:number,lower:number,trend:number,sigma:number)=>{
    const completed=past.filter(o=>o.currency===currency&&o.target===target&&o.horizon===horizon&&o.version===TARGET_VERSION&&o.resolvedAt<now&&o.labelEnd<now.slice(0,10));
    result.push({id:`event:${TARGET_VERSION}:${frame.id}:${currency}:${target}:${horizon}`,target,currency,horizon,asOf:now,version:TARGET_VERSION,forecast,baseline:completed.length>=30?mean(completed.map(o=>o.label)):null,baselineSamples:completed.length,calibrated:false,influence:0,upper,lower,trend,sigma,vix});
  };
  for(const c of currencies){
    const path=fixes.map(p=>basket(p.prices,frame.prices,c)),upper=Math.max(...path),lower=Math.min(...path),trend=Math.sign(-path[0]),sigma=frame.volatility[c];
    if(!(sigma>0))continue;
    for(const h of outcomeHorizons){
      // Distances exclude the current fixing itself, which is zero by definition.
      const prior=path.slice(0,-1),distance=Math.min(Math.abs(Math.max(...prior)),Math.abs(Math.min(...prior)));
      add(c,'BREAKOUT',h,sigmoid(1-distance/(sigma*Math.sqrt(h))),upper,lower,trend,sigma);
      if(trend)add(c,'REVERSAL',h,sigmoid(-Math.abs(path[0])/Math.max(sigma*4,1e-8)),upper,lower,trend,sigma);
      add(c,'VOLATILITY_EXPANSION',h,sigmoid((frame.features[c]?.['fx.volatility']??0)-1),upper,lower,trend,sigma);
    }
  }
  if(vix!==null)for(const h of outcomeHorizons)add('GLOBAL','REGIME_TRANSITION',h,sigmoid(1-Math.abs(vix-20)/5),0,0,0,0);
  return result;
}
export function resolveEventPredictions(frame:ResearchFrame,predictions:EventPrediction[],outcomes:ResolvedTarget[],prices:Observation[],now:string):EventOutcome[]{
  return predictions.flatMap(p=>{
    if(p.version!==TARGET_VERSION||p.asOf!==frame.at)return [];
    const o=outcomes.find(o=>o.frameId===frame.id&&o.horizon===p.horizon&&o.currency===(p.currency==='GLOBAL'?'USD':p.currency));if(!o||o.labelEnd>=now.slice(0,10))return [];
    let label:0|1;
    if(p.target==='REGIME_TRANSITION'){
      const v=prices.filter(r=>r.metric==='vix'&&r.currency==='GLOBAL'&&r.receivedAt<=now&&r.period<=o.labelEnd&&Date.parse(o.labelEnd)-Date.parse(r.period)<=4*dayMs&&r.quality==='VALID').sort((a,b)=>b.period.localeCompare(a.period)||a.receivedAt.localeCompare(b.receivedAt))[0];
      if(!v||p.vix===null)return [];
      label=Number((v.value>=20)!==(p.vix>=20)) as 0|1;
    }else if(p.target==='BREAKOUT'){
      const entry=pricesAt(prices,o.entryDate,now);if(!entry)return [];
      const offset=basket(entry,frame.prices,p.currency);
      label=Number(o.pricePath.some(x=>x.date>o.entryDate&&(x.value+offset>p.upper||x.value+offset<p.lower))) as 0|1;
    }else if(p.target==='REVERSAL')label=Number(o.forwardReturn*p.trend < -p.sigma*Math.sqrt(p.horizon)) as 0|1;
    else label=Number(Math.abs(o.forwardReturn)>p.sigma*Math.sqrt(p.horizon)) as 0|1;
    return [{id:`event-outcome:${p.id}`,predictionId:p.id,frameId:frame.id,currency:p.currency,target:p.target,horizon:p.horizon,asOf:frame.at,labelEnd:o.labelEnd,resolvedAt:now,label,forecast:p.forecast,baseline:p.baseline,regime:frame.regime,version:p.version,source:p.target==='REGIME_TRANSITION'?'FRED VIXCLS':'ECB daily reference fixing'}];
  });
}
export function eventTargetStatus(outcomes:EventOutcome[]){
  return (Object.keys(targetDefinitions) as EventTarget[]).flatMap(target=>outcomeHorizons.map(horizon=>{
    const selected=outcomes.filter(o=>o.target===target&&o.horizon===horizon&&o.version===TARGET_VERSION);
    const rows=selected.filter(o=>o.baseline!==null).map(o=>({asOf:o.asOf,labelEnd:o.labelEnd,pair:o.currency,label:o.label,candidate:o.forecast,probability:o.forecast,baseline:o.baseline!,regime:o.regime,pointInTimeVerified:true})) as Comparison[];
    const gate=validationGate(rows,horizon,4096,Math.max(1,rows.length));
    return {target,horizon,status:gate.passed?'SHADOW_VALIDATED':rows.length?'SHADOW':'WAITING_FOR_DATA',resolved:selected.length,gate,influence:0,definition:targetDefinitions[target],reason:'Uncalibrated candidate forecasts; no automatic bullish/bearish Evidence mapping.'};
  }));
}
