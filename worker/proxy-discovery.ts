import { currencies, type CurrencyCode } from '../lib/terminal-data';
import { dayMs, observationQuality, type Observation, type SourceCheck } from '../lib/production-data';
import { sourceAttempt, sourceFetch } from '../lib/source-health';
import { digest } from '../lib/hypothesis/provenance';
import type { ResearchDB } from './hypothesis-research';

type Indicator={id:string;name:string;sourceNote:string;unit:string;source?:{id:string}};
type ProxyIndicator=Indicator&{version:string;normalization?:'annual-symmetric-change-v2';failedPolls?:number;lastAttempt?:string};
type Catalog={page:number;pages:number;lastScan:string;indicators:ProxyIndicator[]};
const country:Record<CurrencyCode,string>={USD:'USA',EUR:'EMU',GBP:'GBR',CHF:'CHE',CAD:'CAN',AUD:'AUS',NZD:'NZL',JPY:'JPN'};
/** No outcome-based selection: scan provider metadata, then measure availability for every major. */
export function proxyMechanism(indicator:Indicator){
  const text=indicator.name+' '+indicator.sourceNote;
  if(indicator.id==='VC.IHR.PSRC.P5')return 'aggregate public safety, investment climate, tourism and fiscal costs';
  const channels:[RegExp,string][]=[
    [/export|import|trade|freight|shipping|port activity|logistic/i,'trade receipts, import costs and external financing'],
    [/agricultur|crop|fertili|food|commodity|metal|mining|energy|electric|fuel|oil|gas/i,'production costs, export capacity and terms of trade'],
    [/credit|debt|loan|bank|financ|interest|investment/i,'credit supply, financing conditions and capital flows'],
    [/employment|labor|labour|wage|job|productiv/i,'labor income, capacity and monetary policy expectations'],
    [/consum|retail|housing|property|business|industr|manufact|enterprise/i,'domestic demand, investment and expected growth'],
  ];
  return channels.find(([pattern])=>pattern.test(text))?.[1]??null;
}
export function proxyCandidates(rows:Indicator[]){return rows.filter(r=>/^[A-Z0-9_.]+$/.test(r.id)&&r.name&&r.sourceNote&&r.source?.id==='2'&&(!/crime|homicide|violence|victim/i.test(r.name+' '+r.sourceNote)||r.id==='VC.IHR.PSRC.P5')&&proxyMechanism(r));}
type ProxyRow={countryiso3code:string;date:string;value:number|null};
const proxyMetric=(indicator:ProxyIndicator)=>`${indicator.normalization?'alt.proxy':'proxy'}.${indicator.id}.${indicator.version}`;
/** New series use own-country changes; missing peers never become invented observations. */
export function parseProxyRows(rows:ProxyRow[],indicator:ProxyIndicator,now:string,url:string):Observation[]{
  const metric=proxyMetric(indicator);
  const selected=currencies.flatMap(currency=>{
    const values=rows.filter(r=>r.countryiso3code===country[currency]&&typeof r.value==='number'&&observationQuality(metric,r.value,r.date,now)!=='INVALID').sort((a,b)=>b.date.localeCompare(a.date));
    const latest=values[0];if(!latest||observationQuality(metric,latest.value!,latest.date,now)!=='VALID')return [];
    if(indicator.normalization){const prior=values.find(r=>Number(r.date)===Number(latest.date)-1);if(!prior)return [];
      const scale=Math.abs(latest.value!)+Math.abs(prior.value!);
      return [{currency,value:latest.value!,period:latest.date,normalizedValue:scale?Math.max(-1,Math.min(1,2*(latest.value!-prior.value!)/scale)):0,rawInputs:[latest,prior]}];
    }
    return [{currency,value:latest.value!,period:latest.date,normalizedValue:0,rawInputs:[latest]}];
  });
  if(!indicator.normalization&&(selected.length!==8||new Set(selected.map(r=>r.period)).size!==1))return [];
  const values=selected.map(r=>r.value),lo=Math.min(...values),hi=Math.max(...values);
  return selected.map(r=>({...r,metric,normalizedValue:indicator.normalization?r.normalizedValue:hi===lo?0:2*(r.value-lo)/(hi-lo)-1,source:'World Bank proxies',sourceUrl:url,receivedAt:now,unit:indicator.unit||indicator.name,definition:`${indicator.sourceNote} Normalization: ${indicator.normalization??'current-cross-section-rank-v1'}. Candidate transmission: ${proxyMechanism(indicator)??'external economic conditions'}; sign and lead/lag are unproven.`,featureVersion:indicator.version,releaseDate:null,quality:'VALID' as const,frequency:'annual',lineage:[`WorldBank:${indicator.id}`],economicCause:proxyMechanism(indicator)??`WorldBank:${indicator.id}`}));
}
export async function collectProxies(db:ResearchDB,checks:SourceCheck[],now:string):Promise<Observation[]>{
  const key='production:v2:proxy-catalog',stored=await db.prepare('SELECT value FROM terminal_settings WHERE key=?').bind(key).first<{value:string}>();
  const catalog:Catalog=stored?JSON.parse(stored.value):{page:1,pages:1,lastScan:'',indicators:[]};
  for(const indicator of catalog.indicators)if((indicator.failedPolls??0)>=3&&!indicator.lastAttempt)indicator.lastAttempt=catalog.lastScan||now;
  // A bounded universe, with continued discovery. Annual proxies are not presented as daily news.
  if(catalog.lastScan!==now.slice(0,10)){
    const url=`https://api.worldbank.org/v2/indicator?source=2&format=json&per_page=100&page=${catalog.page}`;
    const body=await sourceAttempt(checks,'World Bank metadata',url,'ALL',['proxy.catalog'],async()=>{
      const result=await (await sourceFetch(url)).json() as [{pages:number},Indicator[]];
      return Array.isArray(result?.[1])?result:null;
    });
    if(body){
      for(const indicator of proxyCandidates(body[1])){
        if(catalog.indicators.some(r=>r.id===indicator.id)||catalog.indicators.filter(r=>(r.failedPolls??0)<3).length>=8)continue;
        const normalization='annual-symmetric-change-v2' as const;
        const version=(await digest({id:indicator.id,definition:indicator.sourceNote,unit:indicator.unit,normalization})).slice(0,16);
        catalog.indicators.push({...indicator,version,normalization});break;
      }
      catalog.pages=Math.max(1,body[0].pages);catalog.page=catalog.page%catalog.pages+1;catalog.lastScan=now.slice(0,10);
      await db.prepare('INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,JSON.stringify(catalog),now).run();
    }
  }
  const observations:Observation[]=[];
  // A failed candidate is quarantined, not permanently forgotten. Retry at most two after 30 days.
  const active=catalog.indicators.filter(r=>(r.failedPolls??0)<3);
  const retry=catalog.indicators.filter(r=>(r.failedPolls??0)>=3&&Date.parse(now)-Date.parse(r.lastAttempt??catalog.lastScan)>=30*dayMs).slice(0,2);
  await Promise.all([...active,...retry].map(async indicator=>{
    const metric=proxyMetric(indicator);
    // Refresh each annual feature weekly. Stored receipts preserve its actual first availability.
    const prior=await db.prepare('SELECT payload,max(received_at) AS received_at FROM observation_vintages WHERE metric=? GROUP BY currency ORDER BY received_at DESC').bind(metric).all<{payload:string;received_at:string}>();
    if((indicator.normalization?prior.results.length>0:prior.results.length===8)&&Date.parse(now)-Date.parse(prior.results[0].received_at)<7*dayMs){
      observations.push(...prior.results.map(r=>JSON.parse(r.payload) as Observation));checks.push({at:now,source:'World Bank proxies',url:`https://api.worldbank.org/v2/indicator/${indicator.id}`,currency:'ALL',metrics:[metric],status:'SUCCESS',cause:null,fallback:'Reused immutable annual receipts within weekly polling interval',latencyMs:0});return;
    }
    const url=`https://api.worldbank.org/v2/country/${Object.values(country).join(';')}/indicator/${indicator.id}?source=2&format=json&per_page=200&mrv=3`;
    const rows=await sourceAttempt(checks,'World Bank proxies',url,'ALL',[metric],async()=>{
      const body=await (await sourceFetch(url)).json() as [unknown,ProxyRow[]];
      if(!Array.isArray(body?.[1]))return null;
      const parsed=parseProxyRows(body[1],indicator,now,url);return parsed.length?parsed:null;
    });
    indicator.lastAttempt=now;
    if(rows){observations.push(...rows);indicator.failedPolls=0;}else indicator.failedPolls=(indicator.failedPolls??0)+1;
  }));
  await db.prepare('INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,JSON.stringify(catalog),now).run();
  return observations;
}
