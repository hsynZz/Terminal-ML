import {analyzeSeasonality,LOOKBACKS,type Lookback} from '../lib/seasonality-engine';
import {FX_SOURCE,FX_SERIES,NORMALIZATION_VERSION,SEASONALITY_VERSION,FX_PAIRS,derivePair,fredHistoryUrl,fxFreshness,pairCurrencies,pairProvenance,parseFxCsv,validDate,type FxObservation,type FxCurrency,type FxQuality,type PairPrice} from '../lib/seasonality-data';
import confirmedArchive from '../public/data/seasonality/h10-verified-large-moves.json';

type Statement={bind(...v:unknown[]):Statement;first<T>():Promise<T|null>;all<T>():Promise<{results:T[]}>;run():Promise<{meta:{changes:number}}>};
export type SeasonalityDb={prepare(sql:string):Statement;batch(rows:Statement[]):Promise<unknown[]>};
export type SeasonalityEnv={DB:SeasonalityDb;ASSETS?:{fetch(request:Request):Promise<Response>}};
type State={lastSuccess?:string;lastFullSync?:string;lastAttempt?:string;firstArchiveAt?:string;lastError?:string|null;rows?:number;lastDate?:string;status?:string;sourceMode?:string;sourceUrl?:string;missing?:Record<string,number>;issues?:unknown[]};
const jsonHeaders={'Cache-Control':'private, no-store'};
const DAY=86400000;
async function getState(db:SeasonalityDb):Promise<State>{const r=await db.prepare("SELECT value FROM seasonality_sync_state WHERE key='history'").first<{value:string}>();return r?JSON.parse(r.value):{};}
async function saveState(db:SeasonalityDb,state:State,at:string){await db.prepare("INSERT INTO seasonality_sync_state (key,value,updated_at) VALUES ('history',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify(state),at).run();}

/** Insert-only, bounded JSON batches; latest-value comparison also permits later reversion. */
export async function persistFxRows(db:SeasonalityDb,rows:FxObservation[],at:string):Promise<void>{
  for(let offset=0;offset<rows.length;offset+=6000){
    const statements:Statement[]=[];
    for(let i=offset;i<Math.min(rows.length,offset+6000);i+=750){
      const data=rows.slice(i,Math.min(i+750,offset+6000)).map(r=>{
        const s=FX_SERIES.find(s=>s.currency===r.currency)!;
        return [r.date,r.currency,r.usdPerUnit,r.raw,s.id,s.quote==='USD'?0:1,s.quote==='USD'?'IDENTITY':'INVERT',r.quality,r.verification??null];
      });
      statements.push(db.prepare(`INSERT OR IGNORE INTO seasonality_fx_rates
        (date,base_currency,quote_currency,close,raw_value,source,source_series_id,source_timestamp,ingested_at,is_derived,derivation_method,normalization_version,data_quality_status,verification)
        SELECT json_extract(j.value,'$[0]'),json_extract(j.value,'$[1]'),'USD',json_extract(j.value,'$[2]'),json_extract(j.value,'$[3]'),?,json_extract(j.value,'$[4]'),NULL,?,json_extract(j.value,'$[5]'),json_extract(j.value,'$[6]'),?,json_extract(j.value,'$[7]'),json_extract(j.value,'$[8]')
        FROM json_each(?) j
        WHERE COALESCE((SELECT close=json_extract(j.value,'$[2]') AND data_quality_status=json_extract(j.value,'$[7]') FROM seasonality_fx_rates old
          WHERE old.base_currency=json_extract(j.value,'$[1]') AND old.date=json_extract(j.value,'$[0]') ORDER BY old.ingested_at DESC LIMIT 1),0)=0`)
        .bind(FX_SOURCE,at,NORMALIZATION_VERSION,JSON.stringify(data)));
    }
    if(statements.length)await db.batch(statements);
  }
}
type Stored={date:string;base_currency:FxCurrency;close:number;raw_value:number;data_quality_status:FxQuality;ingested_at:string;verification:string|null};
export async function readFxRows(db:SeasonalityDb,currencies:FxCurrency[],asOf:string,knownAt?:string):Promise<FxObservation[]>{
  const legs=currencies.filter(c=>c!=='USD');if(!legs.length)return [];
  const placeholders=legs.map(()=>'?').join(','),cutoff=knownAt??'9999-12-31T23:59:59.999Z';
  const result=await db.prepare(`WITH latest AS (SELECT base_currency,date,MAX(ingested_at) AS at FROM seasonality_fx_rates
    WHERE base_currency IN (${placeholders}) AND date<=? AND ingested_at<=? GROUP BY base_currency,date)
    SELECT r.date,r.base_currency,r.close,r.raw_value,r.data_quality_status,r.ingested_at,r.verification FROM latest l JOIN seasonality_fx_rates r
    ON r.base_currency=l.base_currency AND r.date=l.date AND r.ingested_at=l.at ORDER BY r.date,r.base_currency`)
    .bind(...legs,asOf,cutoff).all<Stored>();
  return result.results.map(r=>({date:r.date,currency:r.base_currency,raw:r.raw_value,usdPerUnit:r.close,quality:r.data_quality_status,verification:r.verification??undefined}));
}
/** Public archive confirms the value, not a causal explanation or independent trading signal. */
export async function confirmLargeMoves(rows:FxObservation[],fetcher:typeof fetch=fetch):Promise<void>{
  const countries={AUD:'al',NZD:'nz',CHF:'sz'} as Record<string,string>,months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const groups=new Map<string,FxObservation[]>();
  for(const row of rows.filter(r=>r.quality==='REVIEW_REQUIRED')){
    if(confirmedArchive.observations.some(o=>o.currency===row.currency&&o.date===row.date&&o.raw===row.raw)){
      row.quality='VERIFIED_LARGE_MOVE';row.verification=`${confirmedArchive.source}#sha256=${confirmedArchive.sha256}`;continue;
    }
    const code=countries[row.currency];if(!code)continue;
    const year=Number(row.date.slice(0,4));if(year<2000)continue;
    const url=`https://www.federalreserve.gov/releases/h10/hist/dat00_${code}.htm`;
    if(!groups.has(url))groups.set(url,[]);groups.get(url)!.push(row);
  }
  await Promise.all([...groups].map(async([url,candidates])=>{
    try{const response=await fetcher(url,{signal:AbortSignal.timeout(6000)});if(!response.ok)return;
      const html=await response.text();
      for(const row of candidates){
        const [y,m,d]=row.date.split('-'),label=`${Number(d)}-${months[Number(m)-1]}-${y.slice(-2)}`;
        const pattern=new RegExp(`<tr[^>]*>\\s*<t[dh][^>]*>\\s*${label}\\s*<\\/t[dh]>\\s*<td[^>]*>\\s*([\\d.]+)\\s*<\\/td>`, 'i');
        const match=html.match(pattern);if(match&&Math.abs(Number(match[1])-row.raw)<1e-10){row.quality='VERIFIED_LARGE_MOVE';row.verification=url;}
      }
    }catch{/* Quarantine stays in force; never infer confirmation from a network failure. */}
  }));
}
export async function syncSeasonality(env:SeasonalityEnv,source:string,clockAt?:string,fetcher:typeof fetch=fetch){
  const now=clockAt??new Date().toISOString(),id=crypto.randomUUID(),db=env.DB,started=Date.parse(now),date=now.slice(0,10);let leased=false,state:State={};
  try{
    state=await getState(db);
    if(state.lastSuccess&&Date.parse(now)-Date.parse(state.lastSuccess)<20*3600000)return {status:'ALREADY_CURRENT',lastSuccess:state.lastSuccess};
    const lock=await db.prepare("INSERT INTO seasonality_sync_state (key,value,updated_at) VALUES ('lease',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at WHERE CAST(json_extract(seasonality_sync_state.value,'$.expiresAt') AS REAL) < ?")
      .bind(JSON.stringify({owner:id,expiresAt:started+5*60000}),now,started).run();
    if(!lock.meta.changes)return {status:'RUNNING'};leased=true;
    const full=!state.lastFullSync||Date.parse(now)-Date.parse(state.lastFullSync)>30*DAY;
    const start=full?'1971-01-01':new Date(Math.max(Date.parse('1971-01-01'),Date.parse(state.lastDate??date)-35*DAY)).toISOString().slice(0,10);
    const url=fredHistoryUrl(start,date);let csv:string,sourceMode='OFFICIAL_LIVE',sourceUrl=url,sourceError:string|null=null;
    try{const response=await fetcher(url,{signal:AbortSignal.timeout(12000),headers:{Accept:'text/csv'}});if(!response.ok)throw new Error(`HTTP_${response.status}`);csv=await response.text();}
    catch(error){
      // An explicitly dated real official archive can bootstrap, never disguise a failed update.
      if(state.lastSuccess||!env.ASSETS)throw error;
      const archived=await env.ASSETS.fetch(new Request('https://assets.internal/data/seasonality/h10-bootstrap.csv'));
      if(!archived.ok)throw error;csv=await archived.text();sourceMode='OFFICIAL_ARCHIVE_BOOTSTRAP';sourceUrl='/data/seasonality/h10-bootstrap-source.json';
      sourceError=error instanceof Error?error.message:'Live source unavailable';
    }
    const prior:FxObservation[]=[];
    if(!full)for(const s of FX_SERIES){const p=await db.prepare('SELECT date,base_currency,raw_value,close,data_quality_status FROM seasonality_fx_rates WHERE base_currency=? AND date<? ORDER BY date DESC,ingested_at DESC LIMIT 1').bind(s.currency,start).first<Stored>();if(p)prior.push({date:p.date,currency:p.base_currency,raw:p.raw_value,usdPerUnit:p.close,quality:p.data_quality_status});}
    const parsed=parseFxCsv(csv,date,prior);
    if(!parsed.rows.length||parsed.issues.some(x=>x.reason==='INVALID_PRICE_OR_FIXING_DATE'||x.reason==='FUTURE_DATE'))throw new Error('SOURCE_VALIDATION_FAILED');
    if(FX_SERIES.some(s=>!parsed.rows.some(r=>r.currency===s.currency)))throw new Error('SOURCE_SERIES_MISSING');
    await confirmLargeMoves(parsed.rows,fetcher);
    // Production timestamps are taken after receipt/validation, never backdated to job start.
    // An explicit clock is for deterministic local tests and replay audits only.
    const receivedAt=clockAt??new Date().toISOString();
    await persistFxRows(db,parsed.rows,receivedAt);
    const completedAt=clockAt??new Date().toISOString();
    const next:State={...state,firstArchiveAt:state.firstArchiveAt??receivedAt,lastSuccess:completedAt,lastAttempt:now,lastFullSync:full?completedAt:state.lastFullSync,lastDate:parsed.rows.at(-1)!.date,status:sourceError?'ARCHIVE_READY':'READY',lastError:sourceError,rows:parsed.rows.length,sourceMode,sourceUrl,missing:parsed.missing,issues:parsed.issues.slice(0,100)};
    await saveState(db,next,completedAt);
    const run={status:'SUCCESS',source,at:now,completedAt,mode:sourceMode,full,parsedRows:parsed.rows.length,lastDate:next.lastDate,duplicates:parsed.duplicates,quarantined:parsed.rows.filter(r=>r.quality==='REVIEW_REQUIRED').map(r=>({date:r.date,currency:r.currency})),confirmedLargeMoves:parsed.rows.filter(r=>r.quality==='VERIFIED_LARGE_MOVE').map(r=>({date:r.date,currency:r.currency,url:r.verification})),missing:parsed.missing,issues:parsed.issues.slice(0,100)};
    await db.prepare('INSERT INTO seasonality_sync_runs (id,at,source,status,payload) VALUES (?,?,?,?,?)').bind(id,now,source,'SUCCESS',JSON.stringify(run)).run();
    console.log(JSON.stringify({event:'FX_SEASONALITY_SYNC',id,...run}));return run;
  }catch(error){
    const reason=error instanceof Error?error.message:'Seasonality sync failed';
    console.error(JSON.stringify({event:'FX_SEASONALITY_SYNC',id,at:now,source,status:'FAILED',reason}));
    if(leased)try{await saveState(db,{...state,lastAttempt:now,lastError:reason,status:state.lastSuccess?'UPDATE_FAILED':'UNAVAILABLE'},now);await db.prepare('INSERT INTO seasonality_sync_runs (id,at,source,status,payload) VALUES (?,?,?,?,?)').bind(id,now,source,'FAILED',JSON.stringify({reason})).run();}catch{/* Console retains persistence errors. */}
    return {status:'FAILED',reason};
  }finally{if(leased)try{await db.prepare("UPDATE seasonality_sync_state SET value=?,updated_at=? WHERE key='lease' AND json_extract(value,'$.owner')=?").bind(JSON.stringify({owner:id,expiresAt:0}),now,id).run();}catch{/* Lease expires. */}}
}
export function queueSeasonality(env:SeasonalityEnv,ctx:{waitUntil(p:Promise<unknown>):void},source:string){ctx.waitUntil(syncSeasonality(env,source));}
export async function seasonalityHealth(env:SeasonalityEnv,now=new Date().toISOString()){
  const state=await getState(env.DB);
  const [coverage,runs]=await Promise.all([
    env.DB.prepare('SELECT base_currency,source_series_id,MIN(date) AS first_date,MAX(date) AS last_date,COUNT(DISTINCT date) AS observations,COUNT(*) AS vintages FROM seasonality_fx_rates GROUP BY base_currency,source_series_id').all<{base_currency:string;source_series_id:string;first_date:string;last_date:string;observations:number;vintages:number}>(),
    env.DB.prepare('SELECT at,source,status,payload FROM seasonality_sync_runs ORDER BY at DESC LIMIT 5').all<{at:string;source:string;status:string;payload:string}>(),
  ]);
  return {version:SEASONALITY_VERSION,...state,freshness:fxFreshness(state.lastDate??null,now.slice(0,10)),coverage:coverage.results,schedule:'Existing Daily Refresh, 17:15 Europe/Berlin; FRED publishes weekly, normally Monday after 16:15 New York. A later release is collected on the next daily run.',runs:runs.results.map(r=>({...r,payload:JSON.parse(r.payload)})),isolatedFromEvidence:true};
}
export type SeasonalityHistory={version:string;pair:string;asOf:string;mode:'retrospective'|'point-in-time';points:PairPrice[];pairLastDate:string|null;pairFreshness:ReturnType<typeof fxFreshness>;provenance:ReturnType<typeof pairProvenance>;health:Awaited<ReturnType<typeof seasonalityHealth>>};
export async function seasonalityApi(request:Request,env:SeasonalityEnv,ctx:{waitUntil(p:Promise<unknown>):void}):Promise<Response>{
  const url=new URL(request.url),route=url.pathname.slice('/api/seasonality/'.length),now=new Date().toISOString();
  try{
    if(route==='sync'&&request.method==='POST'){
      if(request.headers.get('origin')!==url.origin)return Response.json({error:'Origin required'},{status:403});
      queueSeasonality(env,ctx,'AUTHENTICATED_SEASONALITY_REQUEST');return Response.json({status:'QUEUED'},{status:202,headers:jsonHeaders});
    }
    if(request.method!=='GET')return Response.json({error:'Method not allowed'},{status:405});
    if(route==='health')return Response.json(await seasonalityHealth(env),{headers:jsonHeaders});
    if(!['pairs','history','stats'].includes(route))return Response.json({error:'Not found'},{status:404});
    const health=await seasonalityHealth(env);
    if(!health.lastSuccess){queueSeasonality(env,ctx,'INITIAL_SEASONALITY_BACKFILL');return Response.json({version:SEASONALITY_VERSION,status:'INITIALIZING',message:'Offizielle FX-Historie wird geprüft und dauerhaft gespeichert.',health},{status:202,headers:jsonHeaders});}
    if(route==='pairs')return Response.json({version:SEASONALITY_VERSION,pairs:FX_PAIRS.map(pair=>({...pairProvenance(pair),available:pairProvenance(pair).series.every(s=>health.coverage.some(c=>c.base_currency===s.currency))})),health},{headers:{'Cache-Control':'private, max-age=300'}});
    const pair=url.searchParams.get('pair')??'AUDCAD',legs=pairCurrencies(pair),asOf=url.searchParams.get('asOf')??now.slice(0,10);
    if(!validDate(asOf)||asOf>now.slice(0,10))return Response.json({error:'Invalid or future as-of date'},{status:400});
    const mode=url.searchParams.get('mode')??'retrospective';if(!['retrospective','point-in-time'].includes(mode))return Response.json({error:'Invalid vintage mode'},{status:400});
    const knownAt=mode==='point-in-time'?(asOf===now.slice(0,10)?now:asOf+'T23:59:59.999Z'):undefined;
    if(knownAt&&(!health.firstArchiveAt||knownAt<health.firstArchiveAt))return Response.json({status:'DATA_UNAVAILABLE',error:'Keine damals archivierten Vintages für diesen Zeitpunkt. Rückdatierung ist nicht zulässig.'},{status:409,headers:jsonHeaders});
    const rows=await readFxRows(env.DB,legs,asOf,knownAt),points=derivePair(rows,pair,asOf);
    const pairLastDate=points.at(-1)?.date??null,pairFreshness=fxFreshness(pairLastDate,asOf);
    const history:SeasonalityHistory={version:SEASONALITY_VERSION,pair,asOf,mode:mode as SeasonalityHistory['mode'],points,pairLastDate,pairFreshness,provenance:pairProvenance(pair),health};
    if(route==='history')return Response.json(history,{headers:{'Cache-Control':'private, max-age=300'}});
    const lb=url.searchParams.get('lookback')??'20',lookback=(lb==='MAX'?'MAX':Number(lb)) as Lookback;
    if(!LOOKBACKS.includes(lookback))return Response.json({error:'Invalid lookback'},{status:400});
    const start=url.searchParams.get('start')??'10-03',end=url.searchParams.get('end')??'10-27';
    return Response.json({pair,pairLastDate,pairFreshness,provenance:history.provenance,health,analysis:analyzeSeasonality(points,{asOf,lookback,start,end,view:url.searchParams.get('view')==='window'?'window':'year',...(url.searchParams.has('fromYear')?{fromYear:Number(url.searchParams.get('fromYear')),toYear:Number(url.searchParams.get('toYear'))}:{})})},{headers:{'Cache-Control':'private, max-age=300'}});
  }catch(error){
    const message=error instanceof Error?error.message:'Seasonality unavailable',invalid=/Invalid|Duplicate|parameters/.test(message);
    if(!invalid)console.error(JSON.stringify({event:'FX_SEASONALITY_API',route,error:message}));
    return Response.json({status:'DATA_UNAVAILABLE',error:invalid?message:'Seasonality temporarily unavailable. Keine verifizierten Statistiken verfügbar.'},{status:invalid?400:503,headers:jsonHeaders});
  }
}
