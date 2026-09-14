import { applyPairOverlay, type Overlay } from '../lib/hypothesis/adapter';
import { flags } from '../lib/hypothesis/engine';
import type { PairForecastPoint } from '../lib/model-engine';
import type { ResearchEnv } from './hypothesis-research';

export async function productionOverlay(env:ResearchEnv,now=new Date().toISOString()):Promise<Overlay|null> {
  const policy=flags(env);
  if(!policy.enabled||!policy.integrationApproved||policy.requestedWeight===0)return null;
  try {
    const [state,last]=await Promise.all([
      env.DB.prepare('SELECT value FROM terminal_settings WHERE key=?').bind('hypothesis:v1:state').first<{value:string}>(),
      env.DB.prepare('SELECT value FROM terminal_settings WHERE key=?').bind('hypothesis:v1:last-run').first<{value:string}>(),
    ]);
    if(!state||!last)return null;
    const run=JSON.parse(last.value),saved=JSON.parse(state.value),overlay=saved.productionOverlay as Overlay|undefined;
    if(run.status!=='SUCCESS'||run.at!==saved.updatedAt||!overlay||!Array.isArray(overlay.items)||
      !Number.isFinite(Date.parse(overlay.expiresAt))||Date.parse(overlay.expiresAt)<Date.parse(now))return null;
    return {...overlay,items:overlay.items.map(i=>({...i,weight:Math.min(i.weight,policy.requestedWeight)}))};
  } catch { return null; }
}

/** Read-boundary adapter. Zero budget returns the identical Response without any DB lookup. */
export async function integrateResponse(request:Request,response:Response,env:ResearchEnv,now=new Date().toISOString()):Promise<Response> {
  const policy=flags(env),path=new URL(request.url).pathname;
  if(!response.ok||!policy.enabled||!policy.integrationApproved||policy.requestedWeight===0||
    !['/api/terminal','/api/forecast','/api/refresh'].includes(path))return response;
  try {
    const overlay=await productionOverlay(env,now);if(!overlay)return response;
    const payload=await response.clone().json() as {asOf?:string;pair?:string;forecasts?:PairForecastPoint[];hypothesisOverlay?:Overlay};
    if(payload.asOf!==overlay.snapshotAsOf)return response;
    if(path==='/api/forecast') {
      if(!payload.pair||!Array.isArray(payload.forecasts))return response;
      const adjusted=applyPairOverlay(payload.forecasts,payload.pair,payload.asOf,overlay,now);
      if(adjusted===payload.forecasts)return response;
      payload.forecasts=adjusted;
    } else payload.hypothesisOverlay=overlay;
    const headers=new Headers(response.headers);headers.delete('Content-Length');headers.delete('ETag');headers.set('Cache-Control','private, no-store');
    return Response.json(payload,{status:response.status,headers});
  } catch { return response; }
}
