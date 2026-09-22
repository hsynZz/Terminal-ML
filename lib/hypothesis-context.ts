import { currencies } from './terminal-data';
import { dayMs } from './production-data';
import { validationGate, type Comparison, type Gate, type ResearchFrame, type ResolvedTarget } from './production-research';

export const CONTEXT_VERSION='hypothesis-context-v1';
type Scope='currency'|'pair';
export type ContextModel={id:string;version:string;horizon:number;scope:Scope;recipeIds:string[];weights:Record<string,number>;trainedAt:string;trainingSamples:number;status:'SHADOW'|'REJECTED'|'ACTIVE'|'DEGRADED';gate:Gate;incrementalGate:Gate;weight:number;look:number;lastBlocks:number;lastChangedAt:string;lastValidatedAt?:string;folds:{trainEnd:string;testStart:string;samples:number}[]};
export type ContextPrediction={candidate:number;core:number;ensemble:number;regime:string;inputVersion:string};
type Row={frame:ResearchFrame;entity:string;label:0|1;labelEnd:string;core:number;ensemble:number;x:Record<string,number>};
const clamp=(n:number)=>Math.max(.001,Math.min(.999,n));
const sigmoid=(n:number)=>clamp(1/(1+Math.exp(-Math.max(-25,Math.min(25,n)))));
const logit=(p:number)=>Math.log(clamp(p)/(1-clamp(p)));
const mean=(x:number[])=>x.reduce((a,b)=>a+b,0)/Math.max(1,x.length);
export function contextInputs(frame:ResearchFrame,entity:string,horizon:number,recipeIds:string[]){
  const [base,quote]=entity.split('/');
  const core=quote?frame.pairForecasts?.find(p=>p.pair===entity&&p.horizon===horizon)?.core:frame.core[base];
  if(!Number.isFinite(core)||!recipeIds.length)return null;
  const raw=recipeIds.map(id=>{const a=frame.hypotheses[id]?.[base],b=quote?frame.hypotheses[id]?.[quote]:undefined;return Number.isFinite(a)&&(!quote||Number.isFinite(b))?(quote?.5+(a-b!)/2:a):null;});
  if(raw.some(x=>x===null))return null; // Missing hypotheses never receive a synthetic neutral score.
  const scores=raw as number[],x:Record<string,number>={};
  for(let i=0;i<recipeIds.length;i++){
    const value=scores[i]-core!,id=recipeIds[i];
    x[`signal:${id}`]=value;x[`entity:${entity}:${id}`]=value;x[`regime:${frame.regime}:${id}`]=value;
    for(let j=0;j<i;j++)x[`interaction:${recipeIds[j]}:${id}`]=(scores[j]-core!)*value;
  }
  return {core:core!,ensemble:mean(scores),x};
}
export function contextScore(model:ContextModel,frame:ResearchFrame,entity:string):ContextPrediction|null{
  if(model.version!==CONTEXT_VERSION)return null;
  const input=contextInputs(frame,entity,model.horizon,model.recipeIds);if(!input)return null;
  if(Object.keys(input.x).some(k=>!Number.isFinite(model.weights[k])))return null;
  const candidate=sigmoid(logit(input.core)+Object.entries(input.x).reduce((n,[k,v])=>n+v*model.weights[k],0));
  return {candidate,core:input.core,ensemble:input.ensemble,regime:frame.regime,inputVersion:CONTEXT_VERSION};
}
function eligible(f:ResearchFrame){return f.quality==='VALID'&&f.regimeVerified===true&&f.sourceReliability>=.8;}
export function contextLabels(frames:ResearchFrame[],outcomes:ResolvedTarget[],horizon:number,scope:Scope){
  const index=new Map(frames.map(f=>[f.id,f])),labels=new Map(outcomes.filter(o=>o.horizon===horizon).map(o=>[o.frameId+':'+o.currency,o]));
  return outcomes.filter(o=>o.horizon===horizon&&currencies.includes(o.currency as typeof currencies[number])).flatMap(o=>{
    const frame=index.get(o.frameId);if(!frame||!eligible(frame))return [];
    if(scope==='currency')return [{frame,entity:o.currency,label:o.label,labelEnd:o.labelEnd}];
    return currencies.slice(currencies.indexOf(o.currency as typeof currencies[number])+1).flatMap(quote=>{
      const q=labels.get(o.frameId+':'+quote);if(!q||q.entryDate!==o.entryDate||q.labelEnd!==o.labelEnd||!Number.isFinite(o.forwardReturn)||!Number.isFinite(q.forwardReturn))return [];
      return [{frame,entity:o.currency+'/'+quote,label:Number(o.forwardReturn>q.forwardReturn) as 0|1,labelEnd:o.labelEnd}];
    });
  });
}
function fit(rows:Row[],keys:string[]){
  const weights=new Float64Array(keys.length),index=new Map(keys.map((k,i)=>[k,i]));
  const sparse=rows.map(r=>({label:r.label,offset:logit(r.core),x:Object.entries(r.x).flatMap(([k,v])=>index.has(k)?[[index.get(k)!,v] as const]:[])}));
  // Bounded ridge-logistic residual model. Deterministic Core weights are never trained here.
  for(let epoch=0;epoch<80;epoch++){
    const gradient=new Float64Array(keys.length);
    for(const row of sparse){const error=sigmoid(row.offset+row.x.reduce((n,[k,v])=>n+weights[k]*v,0))-row.label;for(const [k,v] of row.x)gradient[k]+=error*v;}
    for(let i=0;i<keys.length;i++)weights[i]-=.4*(gradient[i]/rows.length+.02*weights[i]);
  }return Object.fromEntries(keys.map((k,i)=>[k,weights[i]]));
}
function comparison(row:Row,candidate:number,ensemble=false):Comparison{return {asOf:row.frame.at,labelEnd:row.labelEnd,pair:row.entity,label:row.label,candidate,baseline:row.core+.05*((ensemble?row.ensemble:row.core)-row.core),probability:row.core+.05*(candidate-row.core),regime:row.frame.regime,pointInTimeVerified:true};}
export function trainContextModel(frames:ResearchFrame[],outcomes:ResolvedTarget[],horizon:number,scope:Scope,now:string,sequence:number):ContextModel|null{
  const labels=contextLabels(frames,outcomes.filter(o=>o.resolvedAt<=now),horizon,scope).filter(o=>o.labelEnd<now.slice(0,10)&&o.frame.at<now).sort((a,b)=>a.frame.at.localeCompare(b.frame.at));
  const days=[...new Set(labels.map(o=>o.frame.at.slice(0,10)))];if(days.length<60)return null;
  const firstTest=days[Math.floor(days.length*.5)];
  const firstFrames=frames.filter(f=>f.at.slice(0,10)<firstTest&&eligible(f));
  const vocabulary=[...new Set(firstFrames.flatMap(f=>Object.keys(f.hypotheses)))].sort();if(!vocabulary.length)return null;
  // Rotate bounded cohorts without outcome-based feature selection; later recipes are not excluded forever.
  const offset=(Math.max(1,sequence)-1)*4%vocabulary.length;
  const recipeIds=Array.from({length:Math.min(4,vocabulary.length)},(_,i)=>vocabulary[(offset+i)%vocabulary.length]);
  const data=labels.flatMap(o=>{const input=contextInputs(o.frame,o.entity,horizon,recipeIds);return input?[{...o,...input}]:[];}).slice(-8000);
  const coreRows:Comparison[]=[],incrementalRows:Comparison[]=[],folds:ContextModel['folds']=[];
  const step=Math.max(1,Math.floor(days.length/6));
  for(let i=Math.floor(days.length*.5);i<days.length;i+=step){
    const start=days[i],end=days[Math.min(days.length-1,i+step-1)];
    const training=data.filter(o=>o.labelEnd<start).slice(-2400),test=data.filter(o=>o.frame.at.slice(0,10)>=start&&o.frame.at.slice(0,10)<=end);if(training.length<100)continue;
    const keys=[...new Set(training.flatMap(o=>Object.keys(o.x)))],weights=fit(training,keys);
    for(const row of test){if(Object.keys(row.x).some(k=>!(k in weights)))continue;
      const candidate=sigmoid(logit(row.core)+Object.entries(row.x).reduce((n,[k,v])=>n+v*weights[k],0));coreRows.push(comparison(row,candidate));incrementalRows.push(comparison(row,candidate,true));
    }
    folds.push({trainEnd:training.map(o=>o.labelEnd).sort().at(-1)!,testStart:start,samples:test.length});
  }
  const family=4096*8*Math.max(1,sequence)*(Math.max(1,sequence)+1),gate=validationGate(coreRows,horizon,family,1,60),incrementalGate=validationGate(incrementalRows,horizon,family,1,60);
  const training=data.slice(-2400);if(training.length<100)return null;
  const weights=fit(training,[...new Set(training.flatMap(o=>Object.keys(o.x)))]);
  return {id:`context:${CONTEXT_VERSION}:${scope}:${horizon}:${now}`,version:CONTEXT_VERSION,horizon,scope,recipeIds,weights,trainedAt:now,trainingSamples:training.length,status:gate.passed&&incrementalGate.passed?'SHADOW':'REJECTED',gate,incrementalGate,weight:0,look:1,lastBlocks:0,lastChangedAt:now,folds};
}
export function contextComparisons(model:ContextModel,frames:ResearchFrame[],outcomes:ResolvedTarget[],ensemble=false):Comparison[]{
  return contextLabels(frames,outcomes,model.horizon,model.scope).flatMap(o=>{
    const p=o.frame.contextPredictions?.[model.id]?.[o.entity];if(!p||o.frame.at<=model.trainedAt||p.inputVersion!==CONTEXT_VERSION)return [];
    return [{asOf:o.frame.at,labelEnd:o.labelEnd,pair:o.entity,label:o.label,candidate:p.candidate,probability:p.core+.05*(p.candidate-p.core),baseline:ensemble?p.core+.05*(p.ensemble-p.core):p.core,regime:p.regime,pointInTimeVerified:true}];
  });
}
export function advanceContextModel(model:ContextModel,frames:ResearchFrame[],outcomes:ResolvedTarget[],now:string,sequence:number):ContextModel{
  if(model.status==='REJECTED')return {...model,weight:0};
  const known=outcomes.filter(o=>o.resolvedAt<=now&&o.labelEnd<now.slice(0,10));
  const look=model.look+1,family=4096*8*Math.max(1,sequence)*(Math.max(1,sequence)+1),gate=validationGate(contextComparisons(model,frames,known),model.horizon,family,look),incrementalGate=validationGate(contextComparisons(model,frames,known,true),model.horizon,family,look);
  if(gate.blocks<model.lastBlocks+10)return model;
  const next={...model,gate,incrementalGate,look,lastBlocks:gate.blocks};
  if(gate.blocks>=30&&(!gate.passed||!incrementalGate.passed))return {...next,status:'DEGRADED',weight:0,lastChangedAt:now};
  if(!gate.passed||!incrementalGate.passed||model.status==='DEGRADED'&&Date.parse(now)-Date.parse(model.lastChangedAt)<30*dayMs)return {...next,weight:0};
  return {...next,status:'ACTIVE',weight:Math.min(.025,model.weight+.005),lastChangedAt:model.status==='ACTIVE'?model.lastChangedAt:now,lastValidatedAt:now};
}
export function chooseContextChampions(models:ContextModel[],incumbents:string[],frames:ResearchFrame[],outcomes:ResolvedTarget[],now:string){
  return (['currency','pair'] as const).flatMap(scope=>[10,30,60,90].flatMap(horizon=>{
    const valid=models.filter(m=>m.scope===scope&&m.horizon===horizon&&m.status==='ACTIVE'&&m.gate.passed&&m.incrementalGate.passed&&Date.parse(now)-Date.parse(m.lastValidatedAt??m.lastChangedAt)<180*dayMs).sort((a,b)=>(b.gate.improvement??0)-(a.gate.improvement??0));
    const incumbent=valid.find(m=>incumbents.includes(m.id));if(!incumbent)return valid.slice(0,1);
    const challenger=valid.find(m=>m.id!==incumbent.id);if(!challenger)return [incumbent];
    const previous=new Map(contextComparisons(incumbent,frames,outcomes).map(r=>[r.asOf+':'+r.pair,r.probability]));
    const common=contextComparisons(challenger,frames,outcomes).flatMap(r=>previous.has(r.asOf+':'+r.pair)?[{...r,baseline:previous.get(r.asOf+':'+r.pair)!}]:[]);
    return [validationGate(common,horizon,4096*models.length,challenger.look).passed?challenger:incumbent];
  }));
}
