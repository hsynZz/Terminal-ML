import { currencies, type CurrencyCode } from './terminal-data';
import { dayMs, observationQuality, type Observation, type SourceCheck } from './production-data';
import { sourceAttempt, sourceFetch } from './source-health';

export const SOURCE_VERSION = 'official-feeds-v1';
const clamp = (v:number) => Math.max(-1, Math.min(1,v));
export const bisAreas:Record<string,CurrencyCode> = {XM:'EUR',GB:'GBP',JP:'JPY',CH:'CHF',CA:'CAD',AU:'AUD',NZ:'NZD'};
export const cotContracts:Record<string,CurrencyCode> = {'099741':'EUR','096742':'GBP','097741':'JPY','092741':'CHF','090741':'CAD','232741':'AUD','112741':'NZD','098662':'USD'};
export const cotUrl = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';
export function bisUrl(now:string) {
  const start = new Date(Date.parse(now)-45*dayMs).toISOString().slice(0,10);
  return `https://stats.bis.org/api/v2/data/dataflow/BIS/WS_CBPOL/1.0/D.${Object.keys(bisAreas).join('+')}?startPeriod=${start}&format=csv`;
}
export function cotRequest() {
  const url = new URL(cotUrl);
  url.searchParams.set('$select','market_and_exchange_names,cftc_contract_market_code,report_date_as_yyyy_mm_dd,open_interest_all,noncomm_positions_long_all,noncomm_positions_short_all');
  url.searchParams.set('$where',`cftc_contract_market_code in(${Object.keys(cotContracts).map(c=>`'${c}'`).join(',')})`);
  url.searchParams.set('$order','report_date_as_yyyy_mm_dd DESC');url.searchParams.set('$limit','40');return url.href;
}
/** RFC4180: provider descriptions can contain commas, quotes and newlines. */
export function csvRecords(text:string):Record<string,string>[] {
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++) {const c=text[i];
    if(c==='"') {if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(!quoted&&(c===','||c==='\n')) {row.push(cell.replace(/\r$/,''));cell='';if(c==='\n'){rows.push(row);row=[];}}
    else cell+=c;
  }
  if(quoted)throw new Error('INVALID_RESPONSE');
  if(cell||row.length){row.push(cell.replace(/\r$/,''));rows.push(row);}
  const header=rows.shift()??[];
  return rows.filter(r=>r.length===header.length).map(r=>Object.fromEntries(header.map((k,i)=>[k.replace(/^\uFEFF/,''),r[i]])));
}
function observation(currency:string,metric:string,value:number,period:string,source:string,url:string,now:string,definition:string,unit='ratio'):Observation {
  return {currency,metric,value,period,source,sourceUrl:url,receivedAt:now,releaseDate:null,quality:observationQuality(metric,value,period,now),frequency:'business-daily',unit,featureVersion:SOURCE_VERSION,definition};
}
export function parseBisPolicy(csv:string,now:string):Observation[] {
  const rows=csvRecords(csv),result:Observation[]=[];
  for(const [area,currency] of Object.entries(bisAreas)) {
    const row=rows.filter(r=>r.REF_AREA===area&&r.FREQ==='D'&&r.UNIT_MEASURE==='368'&&r.UNIT_MULT==='0'&&r.OBS_VALUE?.trim()!==''&&observationQuality('rate',Number(r.OBS_VALUE),r.TIME_PERIOD,now)==='VALID').sort((a,b)=>b.TIME_PERIOD.localeCompare(a.TIME_PERIOD))[0];
    if(row)result.push({...observation(currency,'rate',Number(row.OBS_VALUE),row.TIME_PERIOD,'BIS policy rates',bisUrl(now),now,`${row.COMPILATION??'Selected main policy rate'}. Source: ${row.SOURCE_REF??'BIS'}. Daily observations disseminated weekly; not live pricing.`,'percent per annum'),frequency:'daily; weekly publication'});
  }return result;
}
export type CotRow={cftc_contract_market_code:string;report_date_as_yyyy_mm_dd:string;open_interest_all:string;noncomm_positions_long_all:string;noncomm_positions_short_all:string;market_and_exchange_names:string};
export function parseCot(rows:CotRow[],now:string):Observation[] {
  if(!Array.isArray(rows))throw new Error('INVALID_RESPONSE');
  const result:Observation[]=[];
  for(const [contract,currency] of Object.entries(cotContracts)) {
    const series=rows.filter(r=>r.cftc_contract_market_code===contract).map(r=>({r,period:r.report_date_as_yyyy_mm_dd?.slice(0,10),oi:Number(r.open_interest_all),long:Number(r.noncomm_positions_long_all),short:Number(r.noncomm_positions_short_all)}))
      .filter(r=>r.oi>0&&Number.isFinite(r.oi)&&Number.isFinite(r.long)&&Number.isFinite(r.short)&&r.r.noncomm_positions_long_all?.trim()!==''&&r.r.noncomm_positions_short_all?.trim()!==''&&r.long>=0&&r.short>=0&&r.long<=r.oi&&r.short<=r.oi&&observationQuality('cot',.5+(r.long-r.short)/r.oi/2,r.period,now)!=='INVALID')
      .sort((a,b)=>b.period.localeCompare(a.period));
    const latest=series[0];if(!latest||observationQuality('cot',.5,latest.period,now)!=='VALID')continue;
    const prior=series.find(r=>Date.parse(latest.period)-Date.parse(r.period)===7*dayMs),previous=prior&&series.find(r=>Date.parse(prior.period)-Date.parse(r.period)===7*dayMs);
    const net=(latest.long-latest.short)/latest.oi;
    const definition=`CFTC Legacy futures-only non-commercial (long-short)/open-interest; contract ${contract} ${latest.r.market_and_exchange_names}. USD uses ICE USD index, not an equal-weight FX basket. First receipt is availability; report date is not release date.`;
    const make=(metric:string,value:number,extra:string)=>({...observation(currency,metric,value,latest.period,'CFTC Legacy futures only',cotRequest(),now,definition+' '+extra),frequency:'weekly',normalizedValue:metric==='cot'?value:clamp(value),economicCause:'speculative-positioning',lineage:[`CFTC:Legacy:futures:${contract}`],rawInputs:[latest,prior,previous].filter(r=>!!r).map(r=>({period:r!.period,long:r!.long,short:r!.short,openInterest:r!.oi}))});
    result.push(make('cot',.5+.5*net,'Core normalization: 0.5 + 0.5 * net/OI; unchanged existing factor weight.'),make('alt.cot.net.v1',net,'Research raw net/OI.'));
    if(prior)result.push(make('alt.cot.change.v1',net-(prior.long-prior.short)/prior.oi,'Seven-day difference in net/OI.'));
    if(prior&&previous)result.push(make('alt.cot.acceleration.v1',net-2*(prior.long-prior.short)/prior.oi+(previous.long-previous.short)/previous.oi,'Second difference across three consecutive weekly reports.'));
  }return result;
}
export async function collectOfficialInputs(checks:SourceCheck[],now:string) {
  const [rates,cot]=await Promise.all([
    sourceAttempt(checks,'BIS policy rates',bisUrl(now),'ALL',['rate'],async()=>{const rows=parseBisPolicy(await (await sourceFetch(bisUrl(now),'text/csv')).text(),new Date().toISOString());return rows.length?rows:null;}),
    sourceAttempt(checks,'CFTC Legacy futures only',cotRequest(),'ALL',['cot','alt.cot.net.v1','alt.cot.change.v1','alt.cot.acceleration.v1'],async()=>{const rows=parseCot(await (await sourceFetch(cotRequest())).json(),new Date().toISOString());return rows.length?rows:null;}),
  ]);
  for(const [source,rows,metric,url,codes] of [
    ['BIS policy rates',rates??[],'rate',bisUrl(now),Object.values(bisAreas)],
    ['CFTC Legacy futures only',cot??[],'cot',cotRequest(),currencies],
  ] as const)for(const currency of codes)if(!rows.some(r=>r.currency===currency&&r.metric===metric))checks.push({at:now,source,url,currency,metrics:[metric],status:'MISSING',cause:'NO_VALID_OBSERVATIONS',fallback:'CARRIED INPUT',latencyMs:0});
  return [...rates??[],...cot??[]];
}
export const macroProxySeries = [
  {id:'DCOILWTICO',metric:'alt.global.energy.wti.v1',group:'energy',maxAge:10,unit:'USD per barrel',definition:'EIA WTI spot price; 20-observation log change, not commodity-demand measurement.'},
  {id:'DCOILBRENTEU',metric:'alt.global.energy.brent.v1',group:'energy',maxAge:10,unit:'USD per barrel',definition:'EIA Brent spot price; 20-observation log change, not commodity-demand measurement.'},
  {id:'STLFSI4',metric:'alt.global.funding.stress.v1',group:'funding-stress',maxAge:21,unit:'index',definition:'St Louis Fed financial stress index, weekly. Bounded tanh(level/3), not cross-currency basis.'},
  {id:'ICSA',metric:'alt.us.labor.claims.v1',group:'labor',maxAge:21,unit:'initial claims',definition:'US Department of Labor initial claims; negative four-observation log change, a USD labor proxy.'},
  {id:'RSAFS',metric:'alt.us.consumption.retail.v1',group:'consumption',maxAge:75,unit:'millions USD',definition:'US Census advance retail sales; three-observation log change. Historical revisions are received now, never backdated.'},
] as const;
export function parseMacroProxy(body:{observations?:{date:string;value:string}[]},spec:typeof macroProxySeries[number],now:string):Observation[] {
  const rows=(body.observations??[]).filter(r=>r.value!=='.'&&r.value.trim()!==''&&Number.isFinite(Number(r.value))&&/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&r.date<=now.slice(0,10)).sort((a,b)=>b.date.localeCompare(a.date));
  const window=spec.group==='energy'?20:spec.group==='labor'?4:3;
  if(!rows.length||Date.parse(now)-Date.parse(rows[0].date)>spec.maxAge*dayMs||spec.group!=='funding-stress'&&rows.length<=window)return [];
  const raw=Number(rows[0].value),prior=Number(rows[Math.min(window,rows.length-1)].value);
  if(spec.group!=='funding-stress'&&(raw<=0||prior<=0))return [];
  const value=spec.group==='funding-stress'?Math.tanh(raw/3):clamp(Math.log(raw/prior)*(spec.group==='labor'?-4:4));
  const currency=spec.metric.startsWith('alt.global.')?'GLOBAL':'USD',url=`https://fred.stlouisfed.org/series/${spec.id}`;
  const feature={...observation(currency,spec.metric,value,rows[0].date,'FRED alternative proxies',url,now,spec.definition),normalizedValue:value,quality:'VALID' as const,frequency:spec.maxAge===10?'business-daily':spec.maxAge===21?'weekly':'monthly',economicCause:spec.group,lineage:[`FRED:${spec.id}`],rawInputs:rows.slice(0,window+1)};
  return [{...feature,metric:`raw.${spec.id}`,value:raw,normalizedValue:null,unit:spec.unit},feature];
}
export async function collectMacroProxies(checks:SourceCheck[],apiKey:string|undefined):Promise<Observation[]> {
  if(!apiKey){for(const spec of macroProxySeries)checks.push({at:new Date().toISOString(),source:'FRED alternative proxies',url:`https://fred.stlouisfed.org/series/${spec.id}`,currency:spec.metric.startsWith('alt.global.')?'GLOBAL':'USD',metrics:[spec.metric],status:'MISSING',cause:'NOT_CONFIGURED',fallback:'UNAVAILABLE; no imputation',latencyMs:0});return [];}
  const values=await Promise.all(macroProxySeries.map(spec=>sourceAttempt(checks,'FRED alternative proxies',`https://fred.stlouisfed.org/series/${spec.id}`,spec.metric.startsWith('alt.global.')?'GLOBAL':'USD',[spec.metric],async()=>{
    const q=new URLSearchParams({series_id:spec.id,api_key:apiKey,file_type:'json',sort_order:'desc',limit:'60'});
    const body=await (await sourceFetch(`https://api.stlouisfed.org/fred/series/observations?${q}`)).json();
    const rows=parseMacroProxy(body,spec,new Date().toISOString());return rows.length?rows:null;
  })));
  return values.flatMap(v=>v??[]);
}
export const unavailableClasses = [
  {name:'Seasonality core',reason:'No documented historical estimator or licensed Seasonax feed; CARRIED INPUT.'},
  {name:'Commodity core',reason:'Observed oil proxies enter shadow research only; no validated currency-exposure mapping replaces core.'},
  {name:'Non-US 2Y/10Y yields',reason:'No verified daily like-for-like series connected; CARRIED INPUT.'},
  ...['Social media','YouTube activity','Google Trends','FX options / implied volatility / risk reversals','Cross-currency basis','Retail positioning','Shipping / freight','Expectation dispersion','Broad news acceleration / novelty'].map(name=>({name,reason:'NOT YET CONNECTED: no configured reliable licensed point-in-time feed.'})),
];
