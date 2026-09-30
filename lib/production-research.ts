import { currencies, factorMeta, type FactorKey, type FactorScores } from './terminal-data';
import { calibrationMetrics } from './calibration';
import { type Sample } from './hypothesis/engine';
import { VALIDATION_VERSION, dateClusters, dependence, historicalEpoch, purgeFold, type Dependence, type Removal } from './temporal-validation';
import { trainLearnedWeights, type TrainingExample } from './retraining';
import { coreEvidence, type EvidenceAttribution } from './adaptive-evidence';
import { observationQuality, DATA_VERSION, dayMs, type Observation, type ProductionPayload, type SourceCheck } from './production-data';
import type { EventPrediction } from './shadow-targets';
import type { ContextPrediction } from './hypothesis-context';

export const RESEARCH_VERSION='prospective-evidence-v2';
export const outcomeHorizons=[1,3,5,10,30,60,90] as const;
export type FeatureOrigin={definition:string;version:string;sourceUrls:string[];lineage:string[];economicCauses:string[];retrievedAt:string};
export type ResearchFrame={id:string;at:string;version:string;regime:string;sourceReliability:number;regimeVerified?:boolean;pairForecasts?:{pair:string;horizon:number;core:number;adaptive:number}[];features:Record<string,Record<string,number>>;sources:Record<string,string[]>;featureOrigins?:Record<string,FeatureOrigin>;eventPredictions?:EventPrediction[];contextPredictions?:Record<string,Record<string,ContextPrediction>>;core:Record<string,number>;final:Record<string,number>;ml:Record<string,Record<string,number>>;hypotheses:Record<string,Record<string,number>>;modelIds:string[];prices:Record<string,number>;volatility:Record<string,number>;attributions:Record<string,EvidenceAttribution>;quality:string;digest?:string;inputIds?:string[];pairEvents?:ReturnType<typeof currencyPairs>};
export type ResolvedTarget={frameId:string;currency:string;horizon:number;asOf:string;entryDate:string;labelEnd:string;resolvedAt:string;label:0|1;forwardReturn:number;mfe:number;mae:number;volatilityAdjustedReturn:number|null;volatilityExpansion:boolean|null;targetVersion:string;source:string;pricePath:{date:string;value:number}[];regime:string;core:number;adaptive:number;digest?:string};
export type Recipe={id:string;version:string;feature:string;other?:string;operator:'level'|'change'|'lag'|'interaction'|'season'|'regime'|'threshold'|'zscore'|'acceleration';lag:number;horizon:number;direction:1|-1;target:'direction';createdAt:string;status:'DISCOVERY'|'TESTING'|'VALIDATING'|'SHADOW'|'ACTIVE'|'DEGRADED'|'REJECTED';reason:string;weight:number;look:number;lastBlocks:number;lastDates?:number;lastChangedAt:string;shadowStartedAt?:string;gate?:Gate;incrementalGate?:Gate;historicalGate?:Gate;holdoutGate?:Gate;historicalIncrementalGate?:Gate;holdoutIncrementalGate?:Gate;historicalEpoch?:number;historicalAudit?:{epoch:number;developmentDates:number;trainingDates:number;validationDates:number;holdoutDates:number;testStart:string;testEnd:string;removed:Removal[]};commonCauseAudit?:{passed:boolean;reason:string;correlations:Record<string,number>;dates:number};progress?:{historical:Dependence;shadow:Dependence;nextCondition:string;holdoutStatus:string;nextHistoricalDates:number};previousActiveVersion?:string;lastValidatedAt?:string;rationale?:string;lineage?:string[];economicCauses?:string[]};
export type Comparison=Sample&{candidate:number;entryDate?:string;resolvedAt?:string;controlBaseline?:number};
export type Gate={passed:boolean;reason:string;blocks:number;samples:number;adjustedP:number;confidence:number;stability:number;regimeFit:Record<string,number>;improvement:number|null;core:ReturnType<typeof calibrationMetrics>;adaptive:ReturnType<typeof calibrationMetrics>;recentImprovement:number|null;foldImprovements:number[];validationVersion?:string;diagnostics?:Dependence};
const clamp=(v:number,lo=-1,hi=1)=>Math.max(lo,Math.min(hi,v));
const mean=(a:number[])=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const addDays=(at:string,n:number)=>new Date(Date.parse(at.slice(0,10))+n*dayMs).toISOString().slice(0,10);

/** A failed unrelated metric must not disqualify independently received, validated features. */
export function researchSourceChecks(frame:Pick<ResearchFrame,'features'|'sources'>,checks:SourceCheck[]){
  const dependencies:Record<string,string[]>={policy:['rate'],yields:['yield2y','yield10y'],inflation:['rate','inflation'],growth:['growth','unemployment'],risk:['currentAccount','debt'],momentum:['momentum'],sentiment:['nlpSentiment'],cot:['cot']};
  const keys=[...new Set(Object.values(frame.features).flatMap(Object.keys))],metrics=new Set(['vix']);
  const used=new Set(keys.flatMap(k=>(frame.sources[k]??[]).flatMap(s=>s.split(' + '))));used.add('FRED');
  for(const k of keys){if(k.startsWith('factor.'))for(const m of dependencies[k.slice(7)]??[])metrics.add(m);else if(k.startsWith('fx.'))metrics.add('fxReferenceUsd');else if(k.startsWith('proxy.')||k.startsWith('alt.'))metrics.add(k);}
  if(keys.some(k=>k.startsWith('alt.narrative.')))metrics.add('nlpSentiment');
  return checks.filter(c=>{
    if(!(used.has(c.source)||used.has('Official central bank RSS')&&c.metrics.includes('nlpSentiment'))||!c.metrics.some(m=>metrics.has(m)||m.endsWith('.')&&keys.some(k=>k.startsWith(m))))return false;
    if(c.currency==='ALL'||c.currency==='GLOBAL')return true;
    // A missing country that supplies no feature must not veto a different country's observed input.
    const local=Object.keys(frame.features[c.currency]??{});
    return c.metrics.some(m=>m==='vix'||local.some(k=>k===m||m.endsWith('.')&&k.startsWith(m)||k.startsWith('factor.')&&(dependencies[k.slice(7)]??[]).includes(m)||k.startsWith('fx.')&&m==='fxReferenceUsd'||k.startsWith('alt.narrative.')&&m==='nlpSentiment'));
  });
}

export function buildResearchFrame(p:ProductionPayload,observations:Observation[],at=p.asOf):ResearchFrame{
  const features:ResearchFrame['features']={},sources:ResearchFrame['sources']={},featureOrigins:Record<string,FeatureOrigin>={},prices:Record<string,number>={},volatility:Record<string,number>={};
  const valid=observations.filter(o=>o.quality==='VALID'&&Number.isFinite(Date.parse(o.receivedAt))&&o.receivedAt<=at&&(!o.releaseDate||Number.isFinite(Date.parse(o.releaseDate))&&o.releaseDate<=at)&&(!o.publicationDate||o.publicationDate<=at.slice(0,10))&&(!o.scheduledPublicationAt||o.scheduledPublicationAt<=at)&&o.period<=at.slice(0,10));
  for(const c of p.currencies){
    const f:Record<string,number>={};
    for(const [key,meta] of Object.entries(p.coreFactors?.[c.code]??{}))if(meta.status==='OBSERVED'){
      f['factor.'+key]=2*c.factors[key as FactorKey]-1;sources['factor.'+key]=[...new Set([...(sources['factor.'+key]??[]),meta.source])];
      const name='factor.'+key,old=featureOrigins[name];
      featureOrigins[name]={definition:meta.definition??`Existing deterministic ${key} factor; weights and normalization unchanged.`,version:DATA_VERSION,sourceUrls:[...new Set([...(old?.sourceUrls??[]),...meta.sourceUrls??[]])],lineage:[...new Set([...(old?.lineage??[]),...meta.sourceUrls??[meta.source+':'+key]])],economicCauses:[key==='cot'?'speculative-positioning':key==='sentiment'?'central-bank-communication':key],retrievedAt:meta.availableAt??at};
    }
    const raw=valid.filter(o=>o.currency===c.code&&o.metric==='fxReferenceUsd').sort((a,b)=>b.period.localeCompare(a.period));
    if(raw.length>=20&&raw.every(r=>Number.isFinite(r.value)&&r.value>0&&r.value<=1000)&&(Date.parse(at)-Date.parse(raw[0].period))/dayMs<5){
      prices[c.code]=raw[0].value;
      const returns=raw.slice(0,19).map((x,i)=>{
        const other=currencies.filter(k=>k!==c.code).flatMap(k=>{
          const a=valid.find(r=>r.currency===k&&r.metric==='fxReferenceUsd'&&r.period===x.period);
          const b=valid.find(r=>r.currency===k&&r.metric==='fxReferenceUsd'&&r.period===raw[i+1].period);
          return a&&b?[Math.log(a.value/b.value)]:[];
        });return Math.log(x.value/raw[i+1].value)-mean(other);
      });
      if(returns.some(r=>!Number.isFinite(r)||Math.abs(r)>.35)){delete prices[c.code];features[c.code]=f;continue;}
      volatility[c.code]=Math.sqrt(mean(returns.map(x=>(x-mean(returns))**2)));
      f['fx.trend']=clamp(Math.log(raw[0].value/raw[19].value)*10);
      f['fx.acceleration']=clamp((mean(returns.slice(0,5))-mean(returns.slice(5,15)))*100);
      f['fx.volatility']=clamp(volatility[c.code]*100,0,1);
      f['fx.reversal']=clamp(-returns[0]*50);
      f['fx.dispersion']=clamp(Math.max(...returns)-Math.min(...returns),0,1);
      for(const key of Object.keys(f).filter(k=>k.startsWith('fx.')))sources[key]=['ECB reference fixing'];
    }
    for(const o of valid.filter(o=>(o.researchExposures?o.researchExposures.some(e=>e.currency===c.code):o.currency===c.code||o.currency==='GLOBAL')&&(o.metric.startsWith('proxy.')||o.metric.startsWith('alt.')))){
      if(!o.definition||!o.featureVersion||observationQuality(o.metric,o.value,o.period,at)!=='VALID')continue;
      f[o.metric]=clamp(o.normalizedValue??o.value);sources[o.metric]=[...new Set([...(sources[o.metric]??[]),o.source])];
      const old=featureOrigins[o.metric];featureOrigins[o.metric]={definition:o.definition,version:o.featureVersion,sourceUrls:[...new Set([...(old?.sourceUrls??[]),...o.sourceUrl.split(/\s+/)])],lineage:[...new Set([...(old?.lineage??[]),...o.lineage??[o.sourceUrl]])],economicCauses:[...new Set([...(old?.economicCauses??[]),o.economicCause??o.metric])],retrievedAt:o.receivedAt};
    }
    features[c.code]=f;
  }
  // Equal treatment: each currency's feature is relative to the other seven, including USD.
  const relative:typeof features={};
  for(const c of currencies){relative[c]={};for(const [key,value] of Object.entries(features[c])){
    if(key.startsWith('alt.')){relative[c][key]=value;continue;} // Global or one-country observations are not fabricated cross-sections.
    const other=currencies.filter(x=>x!==c).map(x=>features[x][key]).filter(Number.isFinite);
    if(other.length>=3)relative[c][key]=clamp(value-mean(other));
  }}
  const checks=researchSourceChecks({features:relative,sources},p.sourceChecks??[]);
  const reliability=checks.length?checks.filter(x=>x.status==='SUCCESS').length/checks.length:0;
  return {id:`frame:${at}`,at,version:DATA_VERSION,regime:p.regime.label,sourceReliability:reliability,regimeVerified:valid.some(o=>o.currency==='GLOBAL'&&o.metric==='vix'),features:relative,sources,featureOrigins,core:Object.fromEntries(p.currencies.map(c=>[c.code,coreEvidence(c)])),final:Object.fromEntries(p.currencies.map(c=>[c.code,c.evidenceAttribution?.finalEvidenceScore??coreEvidence(c)])),ml:{},hypotheses:{},modelIds:[],prices,volatility,attributions:Object.fromEntries(p.currencies.filter(c=>c.evidenceAttribution).map(c=>[c.code,c.evidenceAttribution!])),quality:currencies.every(c=>prices[c]>0)?'VALID':'WAITING_FOR_PRICES'};
}

/** Frozen deterministic feature grammar; discovery uses observed features, never outcomes. */
export function discoverRecipes(existing:Recipe[],frame:ResearchFrame,history:ResearchFrame[]=[]):Recipe[]{
  const result=[...existing],ids=new Set(existing.map(r=>r.id));
  const prior=history.filter(f=>f.at<frame.at&&f.version===frame.version).slice(-120);
  const priority=(key:string)=>{const origin=frame.featureOrigins?.[key],values=prior.flatMap(f=>Object.values(f.features).flatMap(v=>Number.isFinite(v[key])?[v[key]]:[])),depth=new Set(prior.filter(f=>Object.values(f.features).some(v=>Number.isFinite(v[key]))).map(f=>f.at.slice(0,10))).size,variation=values.length?Math.max(...values)-Math.min(...values):0;
    // Scheduling metadata, not predictive confidence. No outcome enters the discovery priority.
    return Number(!!origin?.economicCauses.length)+Number(!!origin?.sourceUrls.length)+Math.min(1,depth/90)+Math.min(1,variation)+Number(!!origin&&origin.retrievedAt<=frame.at);};
  const keys=[...new Set(Object.values(frame.features).flatMap(Object.keys))].sort((a,b)=>existing.filter(r=>r.feature===a).length-existing.filter(r=>r.feature===b).length||priority(b)-priority(a)||a.localeCompare(b));
  const definitions:Omit<Recipe,'id'|'createdAt'|'status'|'reason'|'weight'|'look'|'lastBlocks'|'lastChangedAt'>[]=[];
  for(const variant of [0,1,2,3,4,5,6,7])for(const [index,key] of keys.entries()){
    const operator=(['level','change','lag','interaction','season','regime','threshold','zscore','acceleration'] as const)[(variant+index)%9],horizon=[1,3,5,10][(Math.floor(variant/2)+index)%4];
    const peers=keys.filter(k=>k!==key&&Object.values(frame.features).some(v=>Number.isFinite(v[key])&&Number.isFinite(v[k]))&&!frame.featureOrigins?.[k]?.lineage.some(s=>frame.featureOrigins?.[key]?.lineage.includes(s)));
    const other=operator==='interaction'?peers[(variant+index)%Math.max(1,peers.length)]:operator==='season'?['season:mam','season:jja','season:son','season:djf'][(variant+index)%4]:operator==='regime'?'regime:'+frame.regime:undefined;
    if(operator==='interaction'&&!other)continue;
    definitions.push({version:operator==='level'||operator==='change'||operator==='lag'||operator==='interaction'?RESEARCH_VERSION:RESEARCH_VERSION+'-grammar3',feature:key,other,operator,lag:operator==='change'||operator==='lag'||operator==='acceleration'?7:0,horizon,direction:variant<4?1:-1,target:'direction'});
  }
  // A bounded registry controls resource use and multiplicity. Permanent IDs include exact formula.
  let added=0;
  for(const d of definitions){const id=[d.version,d.feature,d.operator,d.other??'',d.lag,d.horizon,d.direction].join(':');
    if(ids.has(id))continue;if(result.filter(r=>r.status!=='REJECTED').length>=128||result.length>=4096||added>=8)break;
    const origins=[frame.featureOrigins?.[d.feature],d.other?frame.featureOrigins?.[d.other]:undefined].filter((o):o is FeatureOrigin=>!!o);
    const lineage=[...new Set(origins.flatMap(o=>o.lineage))],economicCauses=[...new Set(origins.flatMap(o=>o.economicCauses))];
    const rationale=origins.length?`Test whether ${economicCauses.join(' / ')} carries incremental information through rates, risk appetite or trade demand; direction and lag are unproven. ${origins.map(o=>o.definition).join(' ')}`:'Observed relative macro or FX dynamics may transmit through monetary policy, capital flows and positioning; sign and lag require prospective validation.';
    result.push({...d,id,createdAt:frame.at,status:'DISCOVERY',reason:'New reproducible candidate; influence zero',weight:0,look:0,lastBlocks:0,lastChangedAt:frame.at,lineage,economicCauses,rationale:rationale+' Null hypothesis: coincidence, a common third cause, or information already explained by Core and existing hypotheses. Association alone does not establish causation.'});ids.add(id);added++;
  }
  return result;
}
export function recipeSignal(r:Recipe,f:ResearchFrame,history:ResearchFrame[],currency:string):number|null{
  const value=f.features[currency]?.[r.feature];if(!Number.isFinite(value))return null;
  const old=history.filter(h=>h.version===f.version&&h.at<=new Date(Date.parse(f.at)-r.lag*dayMs).toISOString()&&h.at>=new Date(Date.parse(f.at)-(r.lag+4)*dayMs).toISOString()).at(-1);
  const lag=old?.features[currency]?.[r.feature];
  if((r.operator==='change'||r.operator==='lag')&&!Number.isFinite(lag))return null;
  const other=r.other?f.features[currency]?.[r.other]:0;
  if(r.operator==='interaction'&&!Number.isFinite(other))return null;
  let signal:number;
  if(r.operator==='season'){const windows:Record<string,number[]>={'season:mam':[2,3,4],'season:jja':[5,6,7],'season:son':[8,9,10],'season:djf':[11,0,1]},months=windows[r.other??''];if(!months||!months.includes(new Date(f.at).getUTCMonth()))return null;signal=value;}
  else if(r.operator==='regime'){if(r.other!=='regime:'+f.regime)return null;signal=value;}
  else if(r.operator==='threshold'){if(Math.abs(value)<=.5)return null;signal=Math.sign(value)*(Math.abs(value)-.5)/.5;}
  else if(r.operator==='zscore'){const dated=new Map<string,number>();for(const h of history.filter(h=>h.version===f.version&&h.at<f.at&&h.at.slice(0,10)<f.at.slice(0,10))){const x=h.features[currency]?.[r.feature];if(Number.isFinite(x))dated.set(h.at.slice(0,10),x);}const past=[...dated.entries()].sort(([a],[b])=>a.localeCompare(b)).slice(-60).map(([,x])=>x);if(past.length<20)return null;const m=mean(past),sd=Math.sqrt(mean(past.map(x=>(x-m)**2)));if(sd<1e-8)return null;signal=Math.tanh((value-m)/sd/3);}
  else if(r.operator==='acceleration'){const older=history.filter(h=>h.version===f.version&&h.at<=new Date(Date.parse(f.at)-2*r.lag*dayMs).toISOString()&&h.at>=new Date(Date.parse(f.at)-(2*r.lag+4)*dayMs).toISOString()).at(-1)?.features[currency]?.[r.feature];if(!Number.isFinite(lag)||!Number.isFinite(older))return null;signal=value-2*lag!+older!;}
  else signal=r.operator==='level'?value:r.operator==='change'?value-lag!:r.operator==='lag'?lag!:value*other!;
  return clamp(r.direction*signal);
}

/** Resolve only future, complete fixes. Each target includes the exact immutable price path. */
export function resolveFrameTargets(frame:ResearchFrame,prices:Observation[],now:string):ResolvedTarget[]{
  if(frame.quality!=='VALID')return [];
  const dates=[...new Set(prices.filter(p=>p.metric==='fxReferenceUsd'&&p.source==='ECB reference fixing'&&p.period<now.slice(0,10)).map(p=>p.period))].sort();
  const series=new Map<string,Record<string,number>>();
  // First observed vintage wins for resolution. Subsequent revisions cannot rewrite a label.
  for(const row of [...prices].sort((a,b)=>a.receivedAt.localeCompare(b.receivedAt)))if(row.receivedAt<=now&&row.value>0&&row.quality==='VALID'&&row.metric==='fxReferenceUsd'){
    const values=series.get(row.period)??{};values[row.currency]??=row.value;series.set(row.period,values);
  }
  const complete=dates.filter(d=>currencies.every(c=>Number.isFinite(series.get(d)?.[c])&&series.get(d)![c]>0));
  const entry=complete.find(d=>d>frame.at.slice(0,10)&&d<=addDays(frame.at,4));if(!entry)return [];
  const result:ResolvedTarget[]=[];
  for(const horizon of outcomeHorizons){const target=addDays(entry,horizon),end=complete.find(d=>d>=target&&d<=addDays(target,4));if(!end)continue;
    for(const currency of currencies){
      const path=complete.filter(d=>d>=entry&&d<=end).map(date=>{
        const own=Math.log(series.get(date)![currency]/series.get(entry)![currency]);
        const others=currencies.filter(c=>c!==currency).map(c=>Math.log(series.get(date)![c]/series.get(entry)![c]));
        return {date,value:own-mean(others)};
      });
      const ret=path.at(-1)!.value,vol=frame.volatility[currency];
      result.push({frameId:frame.id,currency,horizon,asOf:frame.at,entryDate:entry,labelEnd:end,resolvedAt:now,label:ret>0?1:0,forwardReturn:ret,mfe:Math.max(...path.map(p=>p.value)),mae:Math.min(...path.map(p=>p.value)),volatilityAdjustedReturn:vol>0?ret/(vol*Math.sqrt(horizon)):null,volatilityExpansion:vol>0?Math.abs(ret)>vol*Math.sqrt(horizon):null,targetVersion:'currency-vs-equal-basket-fixing-v1',source:'ECB reference fixing; MFE/MAE measured only at daily fixes',pricePath:path,regime:frame.regime,core:frame.core[currency],adaptive:frame.final[currency]});
    }
  }return result;
}
export function comparisons(frames:ResearchFrame[],outcomes:ResolvedTarget[],id:string,horizon:number,kind:'ml'|'hypotheses'):Comparison[]{
  const index=new Map(frames.map(f=>[f.id,f]));
  return outcomes.filter(o=>o.horizon===horizon).flatMap(o=>{
    const f=index.get(o.frameId),candidate=f?.[kind][id]?.[o.currency];
    if(!f||f.version!==DATA_VERSION||f.quality!=='VALID'||f.regimeVerified!==true||f.sourceReliability<.8||!Number.isFinite(candidate))return [];
    // A frozen leave-one-component-out benchmark preserves all contemporaneous Core/other adaptive inputs.
    const attribution=f.attributions[o.currency],controlBaseline=attribution?clamp(attribution.coreEvidenceScore+attribution.components.filter(x=>x.id!==id).reduce((n,x)=>n+x.contribution,0),.001,.999):o.core;
    return [{asOf:o.asOf,entryDate:o.entryDate,labelEnd:o.labelEnd,resolvedAt:o.resolvedAt,pair:o.currency,probability:clamp(o.core+.05*(candidate!-o.core),.001,.999),candidate:candidate!,baseline:o.core,controlBaseline,label:o.label,regime:o.regime,pointInTimeVerified:true}];
  });
}
export function validationGate(rows:Comparison[],horizon:number,family:number,look:number,minBlocks=30):Gate{
  void horizon; // Dependence uses actual label intervals, not nominal calendar spacing.
  const eligible=rows.filter(r=>r.pointInTimeVerified===true&&Number.isFinite(r.probability)&&r.probability>0&&r.probability<1&&Number.isFinite(r.baseline)&&r.baseline>0&&r.baseline<1&&(r.label===0||r.label===1)),blocks=dateClusters(eligible).clusters,all=blocks.flatMap(b=>b.rows),core=calibrationMetrics(all.map(r=>({...r,probability:r.baseline}))),adaptive=calibrationMetrics(all);
  const diagnostics=dependence(eligible,r=>(r.baseline-r.label)**2-(r.probability-r.label)**2);
  const effects=blocks.map(b=>mean(b.rows.map(r=>(r.baseline-r.label)**2-(r.probability-r.label)**2)));
  const adjustedP=Math.min(1,diagnostics.pValue*Math.max(1,family)*Math.max(1,look)*(Math.max(1,look)+1));
  const regimeFit:Record<string,number>={};
  for(const regime of [...new Set(all.map(r=>r.regime))]){const sub=all.filter(r=>r.regime===regime),info=dependence(sub,r=>(r.baseline-r.label)**2-(r.probability-r.label)**2);regimeFit[regime]=info.effectiveSampleSize>=10&&mean(sub.map(r=>(r.baseline-r.label)**2-(r.probability-r.label)**2))>0?1:0;}
  const folds=[0,1,2].map(i=>mean(effects.slice(Math.floor(i*effects.length/3),Math.floor((i+1)*effects.length/3))));
  const last=Date.parse(blocks.at(-1)?.asOf??'1970-01-01'),recency=blocks.map(b=>Math.exp(-Math.LN2*(last-Date.parse(b.asOf))/(180*dayMs)));
  const improvement=effects.length?effects.reduce((n,e,i)=>n+e*recency[i],0)/recency.reduce((a,b)=>a+b,0):null,recent=effects.length?mean(effects.slice(-20)):null,stability=effects.length?effects.filter(x=>x>0).length/effects.length:0;
  const passed=diagnostics.effectiveSampleSize>=minBlocks&&adjustedP<=.05&&!!core&&!!adaptive&&adaptive.logLoss<core.logLoss&&adaptive.expectedCalibrationError<=core.expectedCalibrationError+.01&&folds.every(x=>x>0)&&stability>=.65&&recent!==null&&recent>0&&improvement!==null&&improvement>0&&Object.values(regimeFit).filter(x=>x>0).length>=2;
  return {passed,reason:passed?'OOS_HAC_CALIBRATION_REGIMES_PASSED':diagnostics.effectiveSampleSize<minBlocks?'INSUFFICIENT_SAMPLE':'VALIDATION_NOT_PASSED',blocks:Math.floor(diagnostics.effectiveSampleSize),samples:all.length,adjustedP,confidence:passed?1-adjustedP:0,stability,regimeFit,improvement,core,adaptive,recentImprovement:recent,foldImprovements:folds,validationVersion:VALIDATION_VERSION,diagnostics};
}
export function certified(m:{historicalGate?:Gate;holdoutGate?:Gate}){return m.historicalGate?.passed===true&&m.holdoutGate?.passed===true&&m.historicalGate.validationVersion===VALIDATION_VERSION&&m.holdoutGate.validationVersion===VALIDATION_VERSION;}
const incrementalRows=(rows:Comparison[])=>rows.map(r=>({...r,baseline:r.controlBaseline??r.baseline,probability:clamp((r.controlBaseline??r.baseline)+.05*(r.candidate-(r.controlBaseline??r.baseline)),.001,.999)}));
export function incrementalCertified(m:{historicalIncrementalGate?:Gate;holdoutIncrementalGate?:Gate}){return m.historicalIncrementalGate?.passed===true&&m.holdoutIncrementalGate?.passed===true&&m.historicalIncrementalGate.validationVersion===VALIDATION_VERSION&&m.holdoutIncrementalGate.validationVersion===VALIDATION_VERSION;}
export function recipeCertified(r:Recipe){return certified(r)&&incrementalCertified(r);}
/** Match contemporaneous predictions; a challenger cannot displace a qualified incumbent on selection rank alone. */
export function chooseChampions(models:CandidateModel[],incumbents:string[],frames:ResearchFrame[],outcomes:ResolvedTarget[],now:string){
  return [10,30,60,90].flatMap(horizon=>{
    const qualified=models.filter(m=>m.horizon===horizon&&m.status==='ACTIVE'&&certified(m)&&m.gate.passed&&m.gate.validationVersion===VALIDATION_VERSION&&Date.parse(now)-Date.parse(m.lastValidatedAt??m.lastChangedAt)<180*dayMs).sort((a,b)=>(b.gate.improvement??0)-(a.gate.improvement??0));
    const incumbent=qualified.find(m=>incumbents.includes(m.id));if(!incumbent)return qualified.slice(0,1);
    const challenger=qualified.find(m=>m.id!==incumbent.id);if(!challenger)return [incumbent];
    const rows=comparisons(frames,outcomes,challenger.id,horizon,'ml');
    const baseline=new Map(comparisons(frames,outcomes,incumbent.id,horizon,'ml').map(r=>[r.asOf+':'+r.pair,r.probability]));
    const common=rows.flatMap(r=>baseline.has(r.asOf+':'+r.pair)?[{...r,baseline:baseline.get(r.asOf+':'+r.pair)!}]:[]);
    return [validationGate(common,horizon,Math.max(4,models.length*(models.length+1)),challenger.look).passed?challenger:incumbent];
  });
}
export function advanceRecipe(r:Recipe,rows:Comparison[],family:number,now:string):Recipe{
  if(r.status==='REJECTED')return {...r,weight:0};
  const known=rows.filter(x=>x.asOf>=r.createdAt&&x.asOf<now&&x.labelEnd<now.slice(0,10)&&(!x.resolvedAt||x.resolvedAt<=now)),historical=known.filter(x=>!r.shadowStartedAt||x.asOf<r.shadowStartedAt),prospective=known.filter(x=>!!r.shadowStartedAt&&x.asOf>r.shadowStartedAt);
  const historicalInfo=dependence(historical,x=>(x.baseline-x.label)**2-(x.probability-x.label)**2),shadowInfo=dependence(prospective,x=>(x.baseline-x.label)**2-(x.probability-x.label)**2);
  const epoch=historicalEpoch(historical),progress={historical:historicalInfo,shadow:shadowInfo,nextCondition:'Historical ESS 120; validation ESS 60; untouched holdout ESS 20; two supported regimes; incremental over frozen Core + other contributions',holdoutStatus:recipeCertified(r)?'PASSED':r.holdoutGate?.reason??'NOT YET TESTED',nextHistoricalDates:epoch?.nextDateCount??120};
  if(!r.shadowStartedAt||!recipeCertified(r)){
    const pending={...r,progress,weight:0,shadowStartedAt:undefined,status:(historicalInfo.uniqueForecastDates>=100?'VALIDATING':'TESTING') as Recipe['status']};
    if(!epoch)return {...pending,reason:`${historicalInfo.uniqueForecastDates}/120 historical dates; ESS ${historicalInfo.effectiveSampleSize.toFixed(1)}`};
    if(r.historicalEpoch===epoch.epoch)return pending;
    const look=r.look+1,purged=purgeFold(epoch.validation,epoch.holdout),validation=validationGate(purged.kept,r.horizon,family,look,60),holdout=validationGate(epoch.holdout,r.horizon,family,look,20);
    const historicalIncrementalGate=validationGate(incrementalRows(purged.kept),r.horizon,family,look,60),holdoutIncrementalGate=validationGate(incrementalRows(epoch.holdout),r.horizon,family,look,20);
    const enough=historicalInfo.effectiveSampleSize>=120&&validation.blocks>=60&&holdout.blocks>=20,passed=enough&&validation.passed&&holdout.passed&&historicalIncrementalGate.passed&&holdoutIncrementalGate.passed;
    const mature=enough&&Object.values(validation.regimeFit).filter(Boolean).length>=2&&Object.values(holdout.regimeFit).filter(Boolean).length>=2;
    return {...pending,status:passed?'SHADOW':mature?'REJECTED':'VALIDATING',reason:passed?'Historical HAC and frozen holdout passed; new prospective shadow required':mature?'Frozen validation/holdout failed':'WAITING_FOR_EFFECTIVE_INFORMATION_OR_REGIMES',shadowStartedAt:passed?now:undefined,historicalGate:validation,holdoutGate:holdout,historicalIncrementalGate,holdoutIncrementalGate,gate:holdout,historicalEpoch:epoch.epoch,historicalAudit:{epoch:epoch.epoch,developmentDates:dateClusters(epoch.development).clusters.length,trainingDates:dateClusters(epoch.training).clusters.length,validationDates:dateClusters(purged.kept).clusters.length,holdoutDates:dateClusters(epoch.holdout).clusters.length,testStart:purged.testStart,testEnd:purged.testEnd,removed:purged.removed},look,lastDates:0,lastChangedAt:now,progress:{...progress,holdoutStatus:holdout.reason,nextCondition:passed?'Future shadow ESS 30, two regimes, calibration and family/repeated-look gates':progress.nextCondition}};
  }
  const dates=shadowInfo.uniqueForecastDates;
  if(dates<(r.lastDates??0)+10)return {...r,progress:{...progress,nextCondition:'10 new forecast dates for the next prospective look; shadow ESS 30 and quality gates'}};
  const look=r.look+1,gate=validationGate(prospective,r.horizon,family,look),incrementalGate=validationGate(incrementalRows(prospective),r.horizon,family,look),count=gate.blocks;
  if(!incrementalGate.passed){gate.passed=false;gate.confidence=0;gate.reason='INCREMENTAL_'+incrementalGate.reason;}
  const next={...r,incrementalGate,progress:{...progress,nextCondition:gate.passed?'Continue future quality monitoring':gate.reason},lastDates:dates};
  const materiallyBad=gate.recentImprovement!==null&&gate.recentImprovement<-.002;
  const wait=Date.parse(now)-Date.parse(r.lastChangedAt)<30*dayMs;
  if(materiallyBad||gate.blocks>=30&&!gate.passed||r.status==='ACTIVE'&&!gate.passed)return {...next,status:'DEGRADED',weight:0,reason:gate.reason,gate,look,lastBlocks:count,lastChangedAt:now};
  if(!gate.passed||r.status==='DEGRADED'&&wait)return {...next,gate,look,lastBlocks:count,weight:0};
  return {...next,status:'ACTIVE',weight:gate.stability<.75&&r.weight>0?r.weight*.5:Math.min(.025,r.weight>0?r.weight+.005:.005),reason:'Prospective HAC evidence passed',gate,look,lastBlocks:count,lastChangedAt:r.status==='ACTIVE'?r.lastChangedAt:now,lastValidatedAt:now};
}
export function effectiveRecipeWeight(r:Recipe,now:string){const age=Math.max(0,Date.parse(now)-Date.parse(r.lastValidatedAt??r.lastChangedAt));return r.status==='ACTIVE'&&recipeCertified(r)&&r.incrementalGate?.passed&&r.incrementalGate.validationVersion===VALIDATION_VERSION&&r.gate?.validationVersion===VALIDATION_VERSION&&r.gate?.passed&&age<180*dayMs?r.weight*Math.exp(-Math.LN2*age/(180*dayMs)):0;}
export function correlation(a:number[],b:number[]){if(a.length!==b.length||a.length<10)return 1;const ma=mean(a),mb=mean(b),va=a.map(x=>x-ma),vb=b.map(x=>x-mb),den=Math.sqrt(va.reduce((s,x)=>s+x*x,0)*vb.reduce((s,x)=>s+x*x,0));return den?va.reduce((s,x,i)=>s+x*vb[i],0)/den:1;}
export function agriculturalCommonCauseCheck(r:Recipe,frames:ResearchFrame[]){
  if(!r.feature.startsWith('alt.agri.')&&!r.other?.startsWith('alt.agri.'))return {passed:true,reason:'NOT_AGRICULTURAL',correlations:{},dates:0};
  const history=frames.filter(f=>f.quality==='VALID'&&f.regimeVerified&&f.sourceReliability>=.8).slice(-240),keys=[...new Set(history.flatMap(f=>Object.values(f.features).flatMap(Object.keys)))].filter(k=>k.startsWith('factor.')||k.startsWith('fx.trend')||k.startsWith('alt.global.energy.')||k.startsWith('alt.proxy.'));
  const correlations:Record<string,number>={};let dates=0;
  for(const key of keys){const paired=history.flatMap(f=>currencies.flatMap(c=>{const signal=f.hypotheses[r.id]?.[c],control=f.features[c]?.[key];return Number.isFinite(signal)&&Number.isFinite(control)?[{date:f.at.slice(0,10),signal,control}]:[];}));
    const count=new Set(paired.map(x=>x.date)).size;dates=Math.max(dates,count);if(count<30||Math.max(...paired.map(x=>x.control))-Math.min(...paired.map(x=>x.control))<1e-8)continue;
    correlations[key]=Math.abs(correlation(paired.map(x=>x.signal),paired.map(x=>x.control)));
  }
  const reason=Object.values(correlations).some(x=>x>.8)?'REDUNDANT_WITH_CORE_OR_COMMON_CAUSE':Object.keys(correlations).length<3?'WAITING_FOR_VARIABLE_COMMON_CAUSE_CONTROLS':'COMMON_CAUSE_SCREEN_PASSED_NOT_CAUSAL_PROOF';
  return {passed:reason==='COMMON_CAUSE_SCREEN_PASSED_NOT_CAUSAL_PROOF',reason,correlations,dates};
}
export function nonRedundant(recipes:Recipe[],frames:ResearchFrame[],outcomes:ResolvedTarget[]=[]){
  const selected:Recipe[]=[];
  const vector=(r:Recipe,mode:'feature'|'signal'|'outcome')=>new Map(mode==='outcome'?comparisons(frames,outcomes,r.id,r.horizon,'hypotheses').slice(-960).map(x=>[x.asOf+':'+x.pair+':'+x.labelEnd,(x.probability-x.label)**2]):frames.slice(-120).flatMap(f=>currencies.flatMap(c=>{const v=mode==='feature'?f.features[c]?.[r.feature]:f.hypotheses[r.id]?.[c];return Number.isFinite(v)?[[f.at+':'+c,v] as [string,number]]:[];})));
  const correlated=(a:Recipe,b:Recipe,mode:'feature'|'signal'|'outcome')=>{const x=vector(a,mode),y=vector(b,mode),keys=[...x.keys()].filter(k=>y.has(k));return Math.abs(correlation(keys.map(k=>x.get(k)!),keys.map(k=>y.get(k)!)))>.8;};
  for(const r of recipes.filter(r=>r.status==='ACTIVE').sort((a,b)=>(b.gate?.improvement??0)-(a.gate?.improvement??0))){
    if(selected.some(s=>s.feature===r.feature||s.other===r.feature||s.feature===r.other||s.lineage?.some(x=>r.lineage?.includes(x))||s.economicCauses?.some(x=>r.economicCauses?.includes(x))||correlated(s,r,'feature')||correlated(s,r,'signal')||correlated(s,r,'outcome')))continue;
    selected.push(r);
  }return selected;
}
export type CandidateModel={id:string;horizon:number;version:string;trainedAt:string;weights:FactorScores;trainingSamples:number;status:'SHADOW'|'ACTIVE'|'DEGRADED'|'REJECTED';gate:Gate;historicalGate?:Gate;holdoutGate?:Gate;shadowStartedAt:string;lastChangedAt:string;lastValidatedAt?:string;weight:number;look:number;lastBlocks:number;lastDates?:number;featureKeys:string[];featureRange:Record<string,[number,number]>;folds:{trainEnd:string;testStart:string;samples:number;removed?:Removal[];embargoEnd?:string|null}[]};
export function modelFeatures(frame:ResearchFrame,currency:string):FactorScores{
  return Object.fromEntries((Object.keys(factorMeta) as FactorKey[]).map(k=>[k,frame.features[currency]?.['factor.'+k]??0])) as FactorScores;
}
export function modelScore(m:CandidateModel,f:ResearchFrame,c:string){const values=modelFeatures(f,c);return 1/(1+Math.exp(-5*Object.keys(factorMeta).reduce((n,k)=>n+values[k as FactorKey]*m.weights[k as FactorKey],0)));}
export function trainChallenger(frames:ResearchFrame[],outcomes:ResolvedTarget[],horizon:number,now:string,sequence:number):CandidateModel|null{
  const frameMap=new Map(frames.map(f=>[f.id,f]));
  const dataset=outcomes.filter(o=>o.horizon===horizon&&o.labelEnd<now.slice(0,10)&&o.resolvedAt<=now&&o.asOf<now).flatMap(o=>{
    const f=frameMap.get(o.frameId);if(!f||f.version!==DATA_VERSION||f.quality!=='VALID'||f.regimeVerified!==true||f.sourceReliability<.8)return [];
    return [{features:modelFeatures(f,o.currency),label:o.label,asOf:o.asOf,entryDate:o.entryDate,labelEnd:o.labelEnd,resolvedAt:o.resolvedAt,pair:o.currency,horizon,core:o.core,regime:o.regime}] as (TrainingExample&{core:number;regime:string})[];
  });
  const days=[...new Set(dataset.map(x=>x.asOf!.slice(0,10)))].sort();if(dataset.length<100||days.length<40)return null;
  const initial=Object.fromEntries(Object.entries(factorMeta).map(([k,m])=>[k,m.weight])) as FactorScores;
  const results:Comparison[]=[],folds:CandidateModel['folds']=[];
  const timed=dateClusters(dataset.map(x=>({...x,asOf:x.asOf!,labelEnd:x.labelEnd!}))).clusters.flatMap(c=>c.rows),holdoutStart=Math.floor(days.length*.8),step=Math.max(1,Math.floor(holdoutStart/6));
  const holdout=timed.filter(x=>x.asOf.slice(0,10)>=days[holdoutStart]);
  const development=timed.filter(x=>x.asOf.slice(0,10)<days[holdoutStart]);let priorTest:typeof timed=[];
  const predict=(row:typeof timed[number],weights:FactorScores):Comparison=>{const candidate=1/(1+Math.exp(-5*Object.entries(row.features).reduce((s,[k,v])=>s+v*weights[k as FactorKey],0)));return {asOf:row.asOf,entryDate:row.entryDate,labelEnd:row.labelEnd,resolvedAt:row.resolvedAt,pair:row.pair!,label:row.label,baseline:row.core,probability:row.core+.05*(candidate-row.core),candidate,regime:row.regime,pointInTimeVerified:true};};
  for(let i=Math.floor(holdoutStart*.5);i<holdoutStart;i+=step){
    const start=days[i],end=days[Math.min(holdoutStart-1,i+step-1)];
    const test=development.filter(x=>x.asOf.slice(0,10)>=start&&x.asOf.slice(0,10)<=end),purged=purgeFold(development.filter(x=>x.asOf.slice(0,10)<start),test,priorTest),train=purged.kept;priorTest=test;
    if(train.length<60||!test.length)continue;
    const fitted=trainLearnedWeights(train,initial,180);
    for(const row of test)results.push(predict(row,fitted.weights));
    folds.push({trainEnd:train.map(x=>x.labelEnd).sort().at(-1)!,testStart:start,samples:test.length,removed:purged.removed,embargoEnd:purged.embargoEnd});
  }
  const family=4*sequence*(sequence+1),historicalGate=validationGate(results,horizon,family,1,60);
  const frozen=purgeFold(development,holdout,priorTest),training=frozen.kept;if(training.length<60)return null;
  const trained=trainLearnedWeights(training,initial,240),holdoutGate=validationGate(holdout.map(r=>predict(r,trained.weights)),horizon,family,1,20);
  folds.push({trainEnd:training.map(x=>x.labelEnd).sort().at(-1)!,testStart:days[holdoutStart],samples:holdout.length,removed:frozen.removed,embargoEnd:frozen.embargoEnd});
  if(folds.length<4){historicalGate.passed=false;historicalGate.reason='INSUFFICIENT_WALK_FORWARD_FOLDS';historicalGate.confidence=0;}
  const featureRange=Object.fromEntries(Object.keys(factorMeta).map(k=>{const v=training.map(d=>d.features[k as FactorKey]);return [k,[Math.min(...v),Math.max(...v)] as [number,number]];}));
  const mature=historicalGate.blocks>=60&&holdoutGate.blocks>=20;
  return {id:`ml:${RESEARCH_VERSION}:${horizon}:${now}`,horizon,version:DATA_VERSION,trainedAt:now,weights:trained.weights,trainingSamples:training.length,status:mature&&(!historicalGate.passed||!holdoutGate.passed)?'REJECTED':'SHADOW',gate:historicalGate,historicalGate,holdoutGate,shadowStartedAt:now,lastChangedAt:now,weight:0,look:1,lastBlocks:0,lastDates:0,featureKeys:Object.keys(factorMeta).filter(k=>featureRange[k][0]!==featureRange[k][1]),featureRange,folds};
}
export function modelInDistribution(m:CandidateModel,f:ResearchFrame,c:string){const x=modelFeatures(f,c);return m.version===f.version&&m.featureKeys.length>0&&m.featureKeys.every(k=>Number.isFinite(f.features[c]?.['factor.'+k]))&&Object.entries(m.featureRange).every(([k,[lo,hi]])=>Number.isFinite(x[k as FactorKey])&&x[k as FactorKey]>=lo-.15&&x[k as FactorKey]<=hi+.15);}
export function currencyPairs(frame:ResearchFrame){return currencies.flatMap((a,i)=>currencies.slice(i+1).map(b=>({pair:`${a}/${b}`,coreEvidence:.5+(frame.core[a]-frame.core[b])/2,finalEvidence:.5+(frame.final[a]-frame.final[b])/2,features:Object.fromEntries(Object.entries(frame.features[a]).filter(([k])=>Number.isFinite(frame.features[b]?.[k])).map(([k,v])=>[k,clamp(v-frame.features[b][k])]))})));}
