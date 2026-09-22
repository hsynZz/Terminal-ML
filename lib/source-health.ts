import type { SourceCheck } from './production-data';
/** Operational reliability, never predictive confidence. Missing or failed current inputs have no influence. */
export function sourceReliability(checks:SourceCheck[],history:SourceCheck[][]){
  const result:Record<string,{score:number;uptime:number;latencyMs:number;failures:number;checks:number}>={};
  for(const source of new Set([...checks,...history.flat()].map(c=>c.source))){
    const now=checks.filter(c=>c.source===source),past=history.flatMap(c=>c.filter(x=>x.source===source)),all=[...past,...now];
    const uptime=all.filter(c=>c.status==='SUCCESS').length/Math.max(1,all.length);
    const latencyMs=all.reduce((n,c)=>n+c.latencyMs,0)/Math.max(1,all.length);
    result[source]={score:now.some(c=>c.status!=='SUCCESS')?0:uptime*Math.max(.5,1-latencyMs/60000),uptime,latencyMs,failures:all.filter(c=>c.status!=='SUCCESS').length,checks:all.length};
  }
  return result;
}
export async function sourceAttempt<T>(checks:SourceCheck[],source:string,url:string,currency:string,metrics:string[],read:()=>Promise<T|null>):Promise<T|null>{
  const start=Date.now();
  try{
    const result=await read();
    if(result===null)throw new Error('NO_VALID_OBSERVATIONS');
    checks.push({at:new Date().toISOString(),source,url,currency,metrics,status:'SUCCESS',cause:null,fallback:'none',latencyMs:Date.now()-start});
    return result;
  }catch(error){
    // Never record provider URLs with query credentials or untrusted response bodies.
    const cause=error instanceof Error&&/^(HTTP_\d{3}|NO_VALID_OBSERVATIONS|INVALID_RESPONSE|TIMEOUT|RATE_LIMIT|PREMIUM_REQUIRED)$/.test(error.message)?error.message:'SOURCE_NETWORK_OR_FORMAT_ERROR';
    checks.push({at:new Date().toISOString(),source,url,currency,metrics,status:'FAILED',cause,fallback:'last archived input; adaptive use disabled for unavailable input',latencyMs:Date.now()-start});
    return null;
  }
}
export async function sourceFetch(url:string,accept='application/json'){
  for(let attempt=0;attempt<2;attempt++){
    const response=await fetch(url,{headers:{Accept:accept},signal:AbortSignal.timeout(12000)});
    if(response.ok)return response;
    if(attempt===0&&response.status>=500)continue;
    throw new Error(`HTTP_${response.status}`);
  }
  throw new Error('SOURCE_NETWORK_OR_FORMAT_ERROR');
}
