import { currencies, type CurrencyCode } from '../lib/terminal-data';
import { dayMs, observationQuality, type Observation, type SourceCheck } from '../lib/production-data';
import { sourceAttempt, sourceFetch } from '../lib/source-health';
import { digest } from '../lib/hypothesis/provenance';
import type { ResearchDB } from './hypothesis-research';

type Indicator={id:string;name:string;sourceNote:string;unit:string;source?:{id:string}};
type Catalog={page:number;pages:number;lastScan:string;indicators:(Indicator&{version:string;failedPolls?:number})[]};
const country:Record<CurrencyCode,string>={USD:'USA',EUR:'EMU',GBP:'GBR',CHF:'CHE',CAD:'CAN',AUD:'AUS',NZD:'NZL',JPY:'JPN'};
/** No outcome-based selection: scan provider metadata, then measure availability for every major. */
export function proxyCandidates(rows:Indicator[]){return rows.filter(r=>/^[A-Z0-9_.]+$/.test(r.id)&&r.name&&r.sourceNote&&r.source?.id==='2'&&/percent|%|growth|per capita|index|ratio|rate/i.test(r.name+' '+r.unit));}
export async function collectProxies(db:ResearchDB,checks:SourceCheck[],now:string):Promise<Observation[]>{
  const key='production:v2:proxy-catalog',stored=await db.prepare('SELECT value FROM terminal_settings WHERE key=?').bind(key).first<{value:string}>();
  const catalog:Catalog=stored?JSON.parse(stored.value):{page:1,pages:1,lastScan:'',indicators:[]};
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
        const version=(await digest({id:indicator.id,definition:indicator.sourceNote,unit:indicator.unit,normalization:'current-cross-section-rank-v1'})).slice(0,16);
        catalog.indicators.push({...indicator,version});break;
      }
      catalog.pages=Math.max(1,body[0].pages);catalog.page=catalog.page%catalog.pages+1;catalog.lastScan=now.slice(0,10);
      await db.prepare('INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,JSON.stringify(catalog),now).run();
    }
  }
  const observations:Observation[]=[];
  await Promise.all(catalog.indicators.filter(r=>(r.failedPolls??0)<3).map(async indicator=>{
    const metric=`proxy.${indicator.id}.${indicator.version}`;
    // Refresh each annual feature weekly. Stored receipts preserve its actual first availability.
    const prior=await db.prepare('SELECT payload,max(received_at) AS received_at FROM observation_vintages WHERE metric=? GROUP BY currency ORDER BY received_at DESC').bind(metric).all<{payload:string;received_at:string}>();
    if(prior.results.length===8&&Date.parse(now)-Date.parse(prior.results[0].received_at)<7*dayMs){
      observations.push(...prior.results.map(r=>JSON.parse(r.payload) as Observation));return;
    }
    const url=`https://api.worldbank.org/v2/country/${Object.values(country).join(';')}/indicator/${indicator.id}?source=2&format=json&per_page=200&mrv=3`;
    const rows=await sourceAttempt(checks,'World Bank proxies',url,'ALL',[metric],async()=>{
      const body=await (await sourceFetch(url)).json() as [unknown,{countryiso3code:string;date:string;value:number|null}[]];
      if(!Array.isArray(body?.[1]))return null;
      const selected=currencies.flatMap(currency=>{
        const r=body[1].filter(r=>r.countryiso3code===country[currency]&&typeof r.value==='number'&&observationQuality(metric,r.value,r.date,now)==='VALID').sort((a,b)=>b.date.localeCompare(a.date))[0];
        return r?[{currency,value:r.value!,period:r.date}]:[];
      });
      // Cross-sectional comparability requires the same period and all eight currencies.
      if(selected.length!==8||new Set(selected.map(r=>r.period)).size!==1)return null;
      const values=selected.map(r=>r.value),lo=Math.min(...values),hi=Math.max(...values);
      return selected.map(r=>({...r,metric,normalizedValue:hi===lo?0:2*(r.value-lo)/(hi-lo)-1,source:'World Bank proxies',sourceUrl:url,receivedAt:now,unit:indicator.unit||indicator.name,definition:indicator.sourceNote,featureVersion:indicator.version,releaseDate:null,quality:'VALID' as const,frequency:'annual'}));
    });
    if(rows){observations.push(...rows);indicator.failedPolls=0;}else indicator.failedPolls=(indicator.failedPolls??0)+1;
  }));
  await db.prepare('INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key,JSON.stringify(catalog),now).run();
  return observations;
}
