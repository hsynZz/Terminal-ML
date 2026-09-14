/** Prospective allocation policy, exercised only in tests/research, NOT connected to core. */
export type Evidence = {
  id:string;family:string;regime:string;signal:number;weight:number;evaluatedAt:string;
  historicalPassed:boolean;shadowPassed:boolean;pointInTimeVerified:boolean;
  blocks:number;previousBlocks:number;meanImprovement:number;logLossImprovement:number;
  stability:number;calibrationDegraded:boolean;recentSignals:number[];
};
export function nextWeight(e:Evidence,now:string) {
  const age=Date.parse(now)-Date.parse(e.evaluatedAt);
  if(!Number.isFinite(age)||age<0||age>48*3600000||!e.historicalPassed||!e.shadowPassed||!e.pointInTimeVerified||
    ![e.weight,e.meanImprovement,e.logLossImprovement,e.stability,e.signal,e.blocks,e.previousBlocks].every(Number.isFinite)||
    e.weight<0||e.blocks<30||!Number.isInteger(e.blocks)||!Number.isInteger(e.previousBlocks)||e.previousBlocks<0||
    e.previousBlocks>e.blocks||e.stability<0||e.stability>1||Math.abs(e.signal)>1)
    return {weight:0,status:"INACTIVE",reason:"Evidence missing, invalid or stale"};
  if(e.meanImprovement<=0||e.logLossImprovement<=0||e.calibrationDegraded)
    return {weight:0,status:"DEGRADED",reason:"Edge or calibration deterioration"};
  if(e.stability<.6) return {weight:Math.min(.01,e.weight/2),status:"DEGRADED",reason:"Stability deterioration; halve weight"};
  const weight=e.weight===0?.005:e.blocks>=e.previousBlocks+10?Math.min(.01,e.weight+.001):Math.min(.01,e.weight);
  return {weight,status:"PRODUCTION_ELIGIBLE",reason:e.weight===0?"Initial 0.5% proposed allocation":weight>e.weight?"Ten additional independent blocks; +0.1% proposed":"No new evidence; unchanged"};
}
export function correlation(a:number[],b:number[]) {
  if(a.length!==b.length||a.length<30||![...a,...b].every(Number.isFinite))return null;
  const mean=(x:number[])=>x.reduce((s,v)=>s+v,0)/x.length;
  const ma=mean(a),mb=mean(b),va=a.reduce((s,x)=>s+(x-ma)**2,0),vb=b.reduce((s,x)=>s+(x-mb)**2,0);
  if(!va||!vb)return null;
  return a.reduce((s,x,i)=>s+(x-ma)*(b[i]-mb),0)/Math.sqrt(va*vb);
}
/** All vectors must represent the same ordered, historical observation IDs.
 * Caller cannot certify that yet in production, so the live adapter remains sealed. */
export function boundedProposal(core:number,items:Evidence[],cap:number,regime:string,now:string) {
  const none={coreScore:core,hypothesisAdjustment:0,finalScore:core,totalWeight:0,contributions:[] as {id:string;weight:number;adjustment:number}[]};
  if(!Number.isFinite(core)||core<0||core>1||!Number.isFinite(cap)||cap<=0||cap>.05)return none;
  const accepted:Evidence[]=[];
  for(const item of [...items].sort((a,b)=>a.id.localeCompare(b.id))) {
    const w=nextWeight(item,now);
    if(w.status!=="PRODUCTION_ELIGIBLE"||w.weight<=0||(item.regime!=="all"&&item.regime!==regime)||Math.abs(item.signal)>1)continue;
    // Unknown dependency is not proof of diversification. One family only.
    if(accepted.some(a=>a.family===item.family||correlation(a.recentSignals,item.recentSignals)===null||Math.abs(correlation(a.recentSignals,item.recentSignals)!)>=.8))continue;
    accepted.push({...item,weight:w.weight});
  }
  const total=accepted.reduce((s,x)=>s+x.weight,0),scale=total>cap?cap/total:1;
  const contributions=accepted.map(e=>({id:e.id,weight:e.weight*scale,adjustment:e.weight*scale*((e.signal+1)/2-core)}));
  const raw=contributions.reduce((s,e)=>s+e.adjustment,0),adjustment=Math.max(-.025,Math.min(.025,raw));
  const factor=raw===0?1:adjustment/raw;
  return {coreScore:core,hypothesisAdjustment:adjustment,finalScore:core+adjustment,totalWeight:Math.min(total,cap),contributions:contributions.map(c=>({...c,adjustment:c.adjustment*factor}))};
}
