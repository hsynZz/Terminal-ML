import { currencies, factorMeta, type FactorKey, type FactorScores } from './terminal-data';
import { calibrationMetrics } from './calibration';
import { independentBlocks, signP, type Sample } from './hypothesis/engine';
import { trainLearnedWeights, type TrainingExample } from './retraining';
import { coreEvidence, type EvidenceAttribution } from './adaptive-evidence';
import { DATA_VERSION, dayMs, type Observation, type ProductionPayload, type SourceCheck } from './production-data';

export const RESEARCH_VERSION='prospective-evidence-v2';
export const outcomeHorizons=[1,3,5,10,30,60,90] as const;
export type ResearchFrame={id:string;at:string;version:string;regime:string;sourceReliability:number;regimeVerified?:boolean;pairForecasts?:{pair:string;horizon:number;core:number;adaptive:number}[];features:Record<string,Record<string,number>>;sources:Record<string,string[]>;core:Record<string,number>;final:Record<string,number>;ml:Record<string,Record<string,number>>;hypotheses:Record<string,Record<string,number>>;modelIds:string[];prices:Record<string,number>;volatility:Record<string,number>;attributions:Record<string,EvidenceAttribution>;quality:string;digest?:string;inputIds?:string[];pairEvents?:ReturnType<typeof currencyPairs>};
export type ResolvedTarget={frameId:string;currency:string;horizon:number;asOf:string;entryDate:string;labelEnd:string;resolvedAt:string;label:0|1;forwardReturn:number;mfe:number;mae:number;volatilityAdjustedReturn:number|null;volatilityExpansion:boolean|null;targetVersion:string;source:string;pricePath:{date:string;value:number}[];regime:string;core:number;adaptive:number;digest?:string};
export type Recipe={id:string;version:string;feature:string;other?:string;operator:'level'|'change'|'lag'|'interaction';lag:number;horizon:number;direction:1|-1;target:'direction';createdAt:string;status:'DISCOVERY'|'TESTING'|'VALIDATING'|'SHADOW'|'ACTIVE'|'DEGRADED'|'REJECTED';reason:string;weight:number;look:number;lastBlocks:number;lastChangedAt:string;shadowStartedAt?:string;gate?:Gate;previousActiveVersion?:string};
export type Comparison=Sample&{candidate:number};
export type Gate={passed:boolean;reason:string;blocks:number;samples:number;adjustedP:number;confidence:number;stability:number;regimeFit:Record<string,number>;improvement:number|null;core:ReturnType<typeof calibrationMetrics>;adaptive:ReturnType<typeof calibrationMetrics>;recentImprovement:number|null;foldImprovements:number[]};
const clamp=(v:number,lo=-1,hi=1)=>Math.max(lo,Math.min(hi,v));
const mean=(a:number[])=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const addDays=(at:string,n:number)=>new Date(Date.parse(at.slice(0,10))+n*dayMs).toISOString().slice(0,10);

/** A failed unrelated metric must not disqualify independently received, validated features. */
export function researchSourceChecks(frame:Pick<ResearchFrame,'features'|'sources'>,checks:SourceCheck[]){
  const dependencies:Record<string,string[]>={policy:['rate'],yields:['yield2y','yield10y'],inflation:['rate','inflation'],growth:['growth','unemployment'],risk:['currentAccount','debt'],momentum:['momentum'],sentiment:['nlpSentiment']};
  const keys=[...new Set(Object.values(frame.features).flatMap(Object.keys))],metrics=new Set(['vix']);
  const used=new Set(keys.flatMap(k=>(frame.sources[k]??[]).flatMap(s=>s.split(' + '))));used.add('FRED');
  for(const k of keys){if(k.startsWith('factor.'))for(const m of dependencies[k.slice(7)]??[])metrics.add(m);else if(k.startsWith('fx.'))metrics.add('fxReferenceUsd');else if(k.startsWith('proxy.'))metrics.add(k);}
  return checks.filter(c=>(used.has(c.source)||used.has('Official central bank RSS')&&c.metrics.includes('nlpSentiment'))&&c.metrics.some(m=>metrics.has(m)));
}

export function buildResearchFrame(p:ProductionPayload,observations:Observation[],at=p.asOf):ResearchFrame{
  const features:ResearchFrame['features']={},sources:ResearchFrame['sources']={},prices:Record<string,number>={},volatility:Record<string,number>={};
  const valid=observations.filter(o=>o.quality==='VALID'&&o.receivedAt<=at&&o.period<=at.slice(0,10));
  for(const c of p.currencies){
    const f:Record<string,number>={};
    for(const [key,meta] of Object.entries(p.coreFactors?.[c.code]??{}))if(meta.status==='OBSERVED'){
      f['factor.'+key]=2*c.factors[key as FactorKey]-1;sources['factor.'+key]=[...new Set([...(sources['factor.'+key]??[]),meta.source])];
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
    for(const o of valid.filter(o=>o.currency===c.code&&o.metric.startsWith('proxy.'))){f[o.metric]=clamp(o.normalizedValue??o.value);sources[o.metric]=[o.source];}
    features[c.code]=f;
  }
  // Equal treatment: each currency's feature is relative to the other seven, including USD.
  const relative:typeof features={};
  for(const c of currencies){relative[c]={};for(const [key,value] of Object.entries(features[c])){
    const other=currencies.filter(x=>x!==c).map(x=>features[x][key]).filter(Number.isFinite);
    if(other.length>=3)relative[c][key]=clamp(value-mean(other));
  }}
  const checks=researchSourceChecks({features:relative,sources},p.sourceChecks??[]);
  const reliability=checks.length?checks.filter(x=>x.status==='SUCCESS').length/checks.length:0;
  return {id:`frame:${at}`,at,version:DATA_VERSION,regime:p.regime.label,sourceReliability:reliability,regimeVerified:valid.some(o=>o.currency==='GLOBAL'&&o.metric==='vix'),features:relative,sources,core:Object.fromEntries(p.currencies.map(c=>[c.code,coreEvidence(c)])),final:Object.fromEntries(p.currencies.map(c=>[c.code,c.evidenceAttribution?.finalEvidenceScore??coreEvidence(c)])),ml:{},hypotheses:{},modelIds:[],prices,volatility,attributions:Object.fromEntries(p.currencies.filter(c=>c.evidenceAttribution).map(c=>[c.code,c.evidenceAttribution!])),quality:currencies.every(c=>prices[c]>0)?'VALID':'WAITING_FOR_PRICES'};
}

/** Frozen deterministic feature grammar; discovery uses observed features, never outcomes. */
export function discoverRecipes(existing:Recipe[],frame:ResearchFrame):Recipe[]{
  const result=[...existing],ids=new Set(existing.map(r=>r.id));
  const keys=[...new Set(Object.values(frame.features).flatMap(Object.keys))].sort((a,b)=>existing.filter(r=>r.feature===a).length-existing.filter(r=>r.feature===b).length||a.localeCompare(b));
  const definitions:Omit<Recipe,'id'|'createdAt'|'status'|'reason'|'weight'|'look'|'lastBlocks'|'lastChangedAt'>[]=[];
  for(const variant of [0,1,2,3,4,5,6,7])for(const [index,key] of keys.entries()){
    const operator=(['level','change','lag','interaction'] as const)[(variant+index)%4],horizon=[1,3,5,10][(Math.floor(variant/2)+index)%4];
    const other=operator==='interaction'?keys[(index+1)%keys.length]:undefined;
    definitions.push({version:RESEARCH_VERSION,feature:key,other,operator,lag:operator==='level'?0:7,horizon,direction:variant<4?1:-1,target:'direction'});
  }
  // A bounded registry controls resource use and multiplicity. Permanent IDs include exact formula.
  let added=0;
  for(const d of definitions){const id=[d.version,d.feature,d.operator,d.other??'',d.lag,d.horizon,d.direction].join(':');
    if(ids.has(id))continue;if(result.filter(r=>r.status!=='REJECTED').length>=128||result.length>=4096||added>=8)break;
    result.push({...d,id,createdAt:frame.at,status:'DISCOVERY',reason:'New reproducible candidate; influence zero',weight:0,look:0,lastBlocks:0,lastChangedAt:frame.at});ids.add(id);added++;
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
  return clamp(r.direction*(r.operator==='level'?value:r.operator==='change'?value-lag!:r.operator==='lag'?lag!:value*other!));
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
    return [{asOf:o.asOf,labelEnd:o.labelEnd,pair:o.currency,probability:clamp(o.core+.05*(candidate!-o.core),.001,.999),candidate:candidate!,baseline:o.core,label:o.label,regime:o.regime,pointInTimeVerified:true}];
  });
}
export function validationGate(rows:Comparison[],horizon:number,family:number,look:number,minBlocks=30):Gate{
  const blocks=independentBlocks(rows,horizon),all=blocks.flatMap(b=>b.rows),core=calibrationMetrics(all.map(r=>({...r,probability:r.baseline}))),adaptive=calibrationMetrics(all);
  const effects=blocks.map(b=>mean(b.rows.map(r=>(r.baseline-r.label)**2-(r.probability-r.label)**2)));
  const adjustedP=Math.min(1,signP(effects.filter(x=>x>0).length,effects.length)*Math.max(1,family)*Math.max(1,look)*(Math.max(1,look)+1));
  const regimeFit:Record<string,number>={};
  for(const regime of [...new Set(all.map(r=>r.regime))]){const sub=blocks.filter(b=>b.rows.some(r=>r.regime===regime));regimeFit[regime]=sub.length>=10&&mean(sub.map(b=>mean(b.rows.filter(r=>r.regime===regime).map(r=>(r.baseline-r.label)**2-(r.probability-r.label)**2))))>0?1:0;}
  const folds=[0,1,2].map(i=>mean(effects.slice(Math.floor(i*effects.length/3),Math.floor((i+1)*effects.length/3))));
  const last=Date.parse(blocks.at(-1)?.asOf??'1970-01-01'),recency=blocks.map(b=>Math.exp(-Math.LN2*(last-Date.parse(b.asOf))/(180*dayMs)));
  const improvement=effects.length?effects.reduce((n,e,i)=>n+e*recency[i],0)/recency.reduce((a,b)=>a+b,0):null,recent=effects.length?mean(effects.slice(-20)):null,stability=effects.length?effects.filter(x=>x>0).length/effects.length:0;
  const passed=blocks.length>=minBlocks&&adjustedP<=.05&&!!core&&!!adaptive&&adaptive.logLoss<core.logLoss&&adaptive.expectedCalibrationError<=core.expectedCalibrationError+.01&&folds.every(x=>x>0)&&stability>=.65&&recent!==null&&recent>0&&Object.values(regimeFit).filter(x=>x>0).length>=2;
  return {passed,reason:passed?'OOS_BLOCKS_CALIBRATION_REGIMES_PASSED':blocks.length<minBlocks?'INSUFFICIENT_SAMPLE':'VALIDATION_NOT_PASSED',blocks:blocks.length,samples:all.length,adjustedP,confidence:passed?1-adjustedP:0,stability,regimeFit,improvement,core,adaptive,recentImprovement:recent,foldImprovements:folds};
}
/** Match contemporaneous predictions; a challenger cannot displace a qualified incumbent on selection rank alone. */
export function chooseChampions(models:CandidateModel[],incumbents:string[],frames:ResearchFrame[],outcomes:ResolvedTarget[],now:string){
  return [10,30,60,90].flatMap(horizon=>{
    const qualified=models.filter(m=>m.horizon===horizon&&m.status==='ACTIVE'&&m.gate.passed&&Date.parse(now)-Date.parse(m.lastValidatedAt??m.lastChangedAt)<180*dayMs).sort((a,b)=>(b.gate.improvement??0)-(a.gate.improvement??0));
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
  const historical=rows.filter(x=>!r.shadowStartedAt||x.asOf<r.shadowStartedAt);
  const blocks=independentBlocks(historical,r.horizon);
  if(!r.shadowStartedAt){
    if(blocks.length<120)return {...r,status:blocks.length>=100?'VALIDATING':'TESTING',weight:0,reason:`${blocks.length}/120 non-overlapping historical blocks`};
    const first=blocks.slice(0,120).flatMap(b=>b.rows) as Comparison[];
    // First 40 blocks reserved for development; next 60 validation; final 20 untouched holdout.
    const validation=validationGate(first.filter(x=>x.asOf.slice(0,10)>=blocks[40].asOf&&x.asOf.slice(0,10)<blocks[100].asOf),r.horizon,family,1,60);
    const gate=validationGate(blocks.slice(100,120).flatMap(b=>b.rows) as Comparison[],r.horizon,family,1,20);
    const passed=validation.passed&&gate.passed;
    return {...r,status:passed?'SHADOW':'REJECTED',weight:0,reason:passed?'Frozen holdout passed; prospective shadow required':'Frozen validation/holdout failed',shadowStartedAt:passed?now:undefined,gate,look:1,lastChangedAt:now};
  }
  const prospective=rows.filter(x=>x.asOf>r.shadowStartedAt!),count=independentBlocks(prospective,r.horizon).length;
  if(count<r.lastBlocks+10)return r;
  const look=r.look+1,gate=validationGate(prospective,r.horizon,family,look);
  const materiallyBad=gate.recentImprovement!==null&&gate.recentImprovement<-.002;
  const wait=Date.parse(now)-Date.parse(r.lastChangedAt)<30*dayMs;
  if(materiallyBad||gate.blocks>=30&&!gate.passed)return {...r,status:'DEGRADED',weight:0,reason:gate.reason,gate,look,lastBlocks:count,lastChangedAt:now};
  if(!gate.passed||r.status==='DEGRADED'&&wait)return {...r,gate,look,lastBlocks:count,weight:0};
  return {...r,status:'ACTIVE',weight:gate.stability<.75&&r.weight>0?r.weight*.5:Math.min(.025,r.weight>0?r.weight+.005:.005),reason:'Prospective evidence passed',gate,look,lastBlocks:count,lastChangedAt:r.status==='ACTIVE'?r.lastChangedAt:now};
}
export function correlation(a:number[],b:number[]){if(a.length!==b.length||a.length<10)return 1;const ma=mean(a),mb=mean(b),va=a.map(x=>x-ma),vb=b.map(x=>x-mb),den=Math.sqrt(va.reduce((s,x)=>s+x*x,0)*vb.reduce((s,x)=>s+x*x,0));return den?va.reduce((s,x,i)=>s+x*vb[i],0)/den:1;}
export function nonRedundant(recipes:Recipe[],frames:ResearchFrame[],outcomes:ResolvedTarget[]=[]){
  const selected:Recipe[]=[];
  const vector=(r:Recipe,mode:'signal'|'outcome')=>mode==='signal'?frames.slice(-120).flatMap(f=>currencies.map(c=>f.hypotheses[r.id]?.[c]??.5)):comparisons(frames,outcomes,r.id,r.horizon,'hypotheses').slice(-120).map(x=>(x.probability-x.label)**2);
  for(const r of recipes.filter(r=>r.status==='ACTIVE').sort((a,b)=>(b.gate?.improvement??0)-(a.gate?.improvement??0))){
    if(selected.some(s=>s.feature===r.feature||s.other===r.feature||s.feature===r.other||Math.abs(correlation(vector(s,'signal'),vector(r,'signal')))>.8||Math.abs(correlation(vector(s,'outcome'),vector(r,'outcome')))>.8))continue;
    selected.push(r);
  }return selected;
}
export type CandidateModel={id:string;horizon:number;version:string;trainedAt:string;weights:FactorScores;trainingSamples:number;status:'SHADOW'|'ACTIVE'|'DEGRADED'|'REJECTED';gate:Gate;shadowStartedAt:string;lastChangedAt:string;lastValidatedAt?:string;weight:number;look:number;lastBlocks:number;featureKeys:string[];featureRange:Record<string,[number,number]>;folds:{trainEnd:string;testStart:string;samples:number}[]};
export function modelFeatures(frame:ResearchFrame,currency:string):FactorScores{
  return Object.fromEntries((Object.keys(factorMeta) as FactorKey[]).map(k=>[k,frame.features[currency]?.['factor.'+k]??0])) as FactorScores;
}
export function modelScore(m:CandidateModel,f:ResearchFrame,c:string){const values=modelFeatures(f,c);return 1/(1+Math.exp(-5*Object.keys(factorMeta).reduce((n,k)=>n+values[k as FactorKey]*m.weights[k as FactorKey],0)));}
export function trainChallenger(frames:ResearchFrame[],outcomes:ResolvedTarget[],horizon:number,now:string,sequence:number):CandidateModel|null{
  const frameMap=new Map(frames.map(f=>[f.id,f]));
  const dataset=outcomes.filter(o=>o.horizon===horizon&&o.labelEnd<now.slice(0,10)).flatMap(o=>{
    const f=frameMap.get(o.frameId);if(!f||f.version!==DATA_VERSION||f.quality!=='VALID'||f.regimeVerified!==true||f.sourceReliability<.8)return [];
    return [{features:modelFeatures(f,o.currency),label:o.label,asOf:o.asOf,labelEnd:o.labelEnd,pair:o.currency,horizon,core:o.core,regime:o.regime}] as (TrainingExample&{core:number;regime:string})[];
  });
  const days=[...new Set(dataset.map(x=>x.asOf!.slice(0,10)))].sort();if(dataset.length<100||days.length<40)return null;
  const initial=Object.fromEntries(Object.entries(factorMeta).map(([k,m])=>[k,m.weight])) as FactorScores;
  const results:Comparison[]=[],folds:CandidateModel['folds']=[];
  for(let i=Math.floor(days.length*.5);i<days.length;i+=Math.max(1,Math.floor(days.length/6))){
    const start=days[i],end=days[Math.min(days.length-1,i+Math.max(1,Math.floor(days.length/6))-1)];
    const train=dataset.filter(x=>x.labelEnd!<start),test=dataset.filter(x=>x.asOf!.slice(0,10)>=start&&x.asOf!.slice(0,10)<=end);
    if(train.length<60||!test.length)continue;
    const fitted=trainLearnedWeights(train,initial,180);
    for(const row of test){const candidate=1/(1+Math.exp(-5*Object.entries(row.features).reduce((s,[k,v])=>s+v*fitted.weights[k as FactorKey],0)));results.push({asOf:row.asOf!,labelEnd:row.labelEnd!,pair:row.pair!,label:row.label,baseline:row.core,probability:row.core+.05*(candidate-row.core),candidate,regime:row.regime});}
    folds.push({trainEnd:train.map(x=>x.labelEnd!).sort().at(-1)!,testStart:start,samples:test.length});
  }
  const gate=validationGate(results,horizon,4*sequence*(sequence+1),1,60),trained=trainLearnedWeights(dataset,initial,240);
  const featureRange=Object.fromEntries(Object.keys(factorMeta).map(k=>{const v=dataset.map(d=>d.features[k as FactorKey]);return [k,[Math.min(...v),Math.max(...v)] as [number,number]];}));
  return {id:`ml:${RESEARCH_VERSION}:${horizon}:${now}`,horizon,version:DATA_VERSION,trainedAt:now,weights:trained.weights,trainingSamples:dataset.length,status:gate.passed?'SHADOW':'REJECTED',gate,shadowStartedAt:now,lastChangedAt:now,weight:0,look:1,lastBlocks:0,featureKeys:Object.keys(factorMeta).filter(k=>featureRange[k][0]!==featureRange[k][1]),featureRange,folds};
}
export function modelInDistribution(m:CandidateModel,f:ResearchFrame,c:string){const x=modelFeatures(f,c);return m.version===f.version&&m.featureKeys.length>0&&m.featureKeys.every(k=>Number.isFinite(f.features[c]?.['factor.'+k]))&&Object.entries(m.featureRange).every(([k,[lo,hi]])=>Number.isFinite(x[k as FactorKey])&&x[k as FactorKey]>=lo-.15&&x[k as FactorKey]<=hi+.15);}
export function currencyPairs(frame:ResearchFrame){return currencies.flatMap((a,i)=>currencies.slice(i+1).map(b=>({pair:`${a}/${b}`,coreEvidence:.5+(frame.core[a]-frame.core[b])/2,finalEvidence:.5+(frame.final[a]-frame.final[b])/2,features:Object.fromEntries(Object.entries(frame.features[a]).filter(([k])=>Number.isFinite(frame.features[b]?.[k])).map(([k,v])=>[k,clamp(v-frame.features[b][k])]))})));}
