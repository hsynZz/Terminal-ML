import { currencies, type CurrencyCode } from './terminal-data';
import { csvRecords } from './observed-sources';
import { dayMs, observationQuality, type Observation, type SourceCheck } from './production-data';
import { sourceAttempt, sourceFetch } from './source-health';
import type { Receipt } from './hypothesis/provenance';

export const EXPANSION_VERSION='official-expansion-v1';
export const expansionUrls={
  cad:'https://www.bankofcanada.ca/valet/observations/BD.CDN.2YR.DQ.YLD,BD.CDN.10YR.DQ.YLD/json?recent=30',
  jpy:'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv',
  aud:'https://www.rba.gov.au/statistics/tables/csv/f2-data.csv',
  eur:'https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.PY_2Y+PY_10Y?lastNObservations=30&format=csvdata',
  supply:'https://www.newyorkfed.org/medialibrary/research/interactives/data/gscpi/gscpi_interactive_data.csv',
  seasonality:'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml',
  commodity:'https://www.rba.gov.au/statistics/tables/csv/i2-data.csv',
};
const clamp=(v:number)=>Math.max(-1,Math.min(1,v));
export function relativeYieldFeatures(receipts:Receipt[],now:string):Observation[]{
  const result:Observation[]=[];
  for(const metric of ['yield2y','yield10y']){
    const usd=receipts.find(r=>r.currency==='USD'&&r.metric===metric&&r.receivedAt<=now&&observationQuality(metric,r.value,r.period,now)==='VALID');if(!usd)continue;
    for(const r of receipts.filter(r=>r.currency!=='USD'&&r.metric===metric&&r.period===usd.period&&r.receivedAt<=now&&observationQuality(metric,r.value,r.period,now)==='VALID')){
      const value=r.value-usd.value;
      result.push({...observed(r.currency,`alt.rates.${metric}.usd-spread.v1`,value,r.period,now,`${r.source} + ${usd.source}`,[r.sourceUrl,usd.sourceUrl].filter(Boolean).join(' '),'Same observation-date nominal sovereign yield difference versus USD. Different local closing times and benchmark conventions are disclosed; not OIS or an expected policy path.','percentage points'),normalizedValue:Math.tanh(value/3),rawInputs:[r,usd],lineage:[r.sourceUrl??r.source,usd.sourceUrl??usd.source],economicCause:'sovereign-yield-repricing'});
    }
  }return result;
}
function observed(currency:string,metric:string,value:number,period:string,now:string,source:string,sourceUrl:string,definition:string,unit:string,frequency='business-daily'):Observation{
  return {currency,metric,value,period,receivedAt:now,releaseDate:null,source,sourceUrl,definition,unit,frequency,featureVersion:EXPANSION_VERSION,quality:observationQuality(metric,value,period,now),lineage:[sourceUrl],economicCause:metric.includes('yield')?'sovereign-yield-repricing':metric,normalizedValue:metric.startsWith('alt.')?clamp(value):null};
}
type YieldPoint={period:string;yield2y:number;yield10y:number};
function yieldObservations(points:YieldPoint[],currency:CurrencyCode,now:string,source:string,url:string,method:string):Observation[]{
  const valid=points.filter(r=>['yield2y','yield10y'].every(m=>observationQuality(m,r[m as keyof YieldPoint] as number,r.period,now)!=='INVALID')).sort((a,b)=>b.period.localeCompare(a.period));
  const latest=valid[0];if(!latest||observationQuality('yield2y',latest.yield2y,latest.period,now)!=='VALID')return [];
  const make=(metric:string,value:number,definition:string)=>({...observed(currency,metric,value,latest.period,now,source,url,definition,'percent per annum'),rawInputs:valid.slice(0,6)});
  const result=[make('yield2y',latest.yield2y,method+' 2-year nominal sovereign market yield.'),make('yield10y',latest.yield10y,method+' 10-year nominal sovereign market yield.')];
  const curve=latest.yield10y-latest.yield2y;
  result.push({...make('alt.rates.curve.v1',curve,method+' 10Y minus 2Y; normalized tanh(spread/3), no asserted FX direction.'),normalizedValue:Math.tanh(curve/3),unit:'percentage points'});
  if(valid.length>=6&&Date.parse(latest.period)-Date.parse(valid[5].period)<=12*dayMs)for(const tenor of ['yield2y','yield10y'] as const){
    const change=latest[tenor]-valid[5][tenor];
    result.push({...make(`alt.rates.${tenor}.change.v1`,change,method+' Five-observation change; normalized tanh(change).'),normalizedValue:Math.tanh(change),unit:'percentage points'});
  }
  return result;
}
export function parseCanadianYields(body:{observations?:{d:string;[key:string]:unknown}[]},now:string){
  const get=(r:Record<string,unknown>,key:string)=>{const v=(r[key] as {v?:string})?.v;return typeof v==='string'&&v.trim()!==''?Number(v):NaN;};
  return yieldObservations((body.observations??[]).map(r=>({period:r.d,yield2y:get(r,'BD.CDN.2YR.DQ.YLD'),yield10y:get(r,'BD.CDN.10YR.DQ.YLD')})),'CAD',now,'Bank of Canada benchmark yields',expansionUrls.cad,'Selected benchmark closing yield; instrument rolls are not pure constant-maturity changes.');
}
export function parseJapaneseYields(text:string,now:string){
  const header=text.indexOf('Date,1Y,2Y,');if(header<0)throw new Error('INVALID_RESPONSE');
  const points=csvRecords(text.slice(header)).map(r=>{const d=r.Date.split('/');return {period:d.length===3?`${d[0]}-${d[1].padStart(2,'0')}-${d[2].padStart(2,'0')}`:'',yield2y:r['2Y']?.trim()?Number(r['2Y']):NaN,yield10y:r['10Y']?.trim()?Number(r['10Y']):NaN};});
  return yieldObservations(points,'JPY',now,'Japan Ministry of Finance yields',expansionUrls.jpy,'Constant-maturity semiannual-compound JGB closing yield; not an OIS-implied policy path.');
}
export function parseEuroYields(text:string,now:string){
  const rows=csvRecords(text).filter(r=>r.FREQ==='B'&&r.REF_AREA==='U2'&&r.CURRENCY==='EUR'&&r.PROVIDER_FM==='4F'&&r.INSTRUMENT_FM==='G_N_A'&&r.PROVIDER_FM_ID==='SV_C_YM'&&r.UNIT==='PCPA'&&r.UNIT_MULT==='0'&&r.OBS_VALUE?.trim()!==''&&['PY_2Y','PY_10Y'].includes(r.DATA_TYPE_FM));
  const points=[...new Set(rows.map(r=>r.TIME_PERIOD))].map(period=>({period,yield2y:Number(rows.find(r=>r.TIME_PERIOD===period&&r.DATA_TYPE_FM==='PY_2Y')?.OBS_VALUE??NaN),yield10y:Number(rows.find(r=>r.TIME_PERIOD===period&&r.DATA_TYPE_FM==='PY_10Y')?.OBS_VALUE??NaN)}));
  return yieldObservations(points,'EUR',now,'ECB AAA sovereign par yields',expansionUrls.eur,'ECB fitted AAA euro-area nominal sovereign par curve. Country composition and issuer risk differ from single-country curves; par rates, not zero-coupon spot rates or OIS paths.');
}

export function calendarDate(value:string){
  const iso=value.match(/^(\d{4})-(\d{2})-(\d{2})$/),slash=value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/),named=value.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2}|\d{4})$/);
  const months=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const year=Number(iso?.[1]??slash?.[3]??(named?(named[3].length===2?'20':'')+named[3]:NaN));
  const month=Number(iso?.[2]??slash?.[2]??(named?months.indexOf(named[2].toLowerCase())+1:NaN));
  const day=Number(iso?.[3]??slash?.[1]??named?.[1]??NaN);
  if(!Number.isFinite(year)||month<1||month>12||day<1||day>31)return '';
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?date.toISOString().slice(0,10):'';
}
/** BoE's documented CSV export, not the zero-coupon/forward-curve workbooks. */
export function britishYieldUrl(now:string){
  const date=new Date(Date.parse(now)-45*dayMs);
  if(!Number.isFinite(date.getTime()))throw new Error('INVALID_RESPONSE');
  const from=`${String(date.getUTCDate()).padStart(2,'0')}/${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getUTCMonth()]}/${date.getUTCFullYear()}`;
  const params=new URLSearchParams({'csv.x':'yes',Datefrom:from,Dateto:'now',SeriesCodes:'IUDMNPY',CSVF:'TN',UsingCodes:'Y',VPD:'Y',VFD:'N'});
  return `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?${params}`;
}
export function parseBritishTenYearYield(text:string,now:string):Observation[]{
  const rows=csvRecords(text.replace(/^\uFEFF/,''));
  // Exact series identity fixes currency, nominal par convention, maturity and daily frequency.
  // IUDMNZC is zero-coupon; IUMMNPY is monthly. Neither is an acceptable substitute.
  if(!rows.length||Object.keys(rows[0]).sort().join(',')!=='DATE,IUDMNPY')throw new Error('INVALID_RESPONSE');
  const points=new Map<string,number>();
  for(const row of rows){
    const period=calendarDate(row.DATE.trim().replace(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/,'$1-$2-$3')),raw=row.IUDMNPY.trim();
    if(!period||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw))continue;
    const value=Number(raw);
    if(observationQuality('yield10y',value,period,now)!=='VALID')continue;
    if(points.has(period)&&points.get(period)!==value)throw new Error('INVALID_RESPONSE');
    points.set(period,value);
  }
  const latest=[...points].sort(([a],[b])=>b.localeCompare(a))[0];if(!latest)return [];
  const [period,value]=latest;
  return [{...observed('GBP','yield10y',value,period,now,'Bank of England nominal par yield',britishYieldUrl(now),'IUDMNPY: daily 10-year nominal UK government par yield fitted with the BoE VRP model. Not a zero-coupon, forward, real or monthly-average yield. GBP 2Y remains separately unavailable. Revisions are archived as received; CSV does not identify original publication time.','percent per annum'),featureVersion:'boe-par10y-v1',lineage:['BoE:IUDMNPY'],rawInputs:[{series:'IUDMNPY',period,value}]}];
}
export async function collectBritishTenYearYield(checks:SourceCheck[]):Promise<Observation[]>{
  const url=britishYieldUrl(new Date().toISOString());
  return await sourceAttempt(checks,'Bank of England nominal par yield',url,'GBP',['yield10y'],async()=>{
    const rows=parseBritishTenYearYield(await (await sourceFetch(url,'text/csv')).text(),new Date().toISOString());
    return rows.length?rows:null;
  })??[];
}
function rbaRows(text:string){const start=text.indexOf('Series ID,');if(start<0)throw new Error('INVALID_RESPONSE');return csvRecords(text.slice(start));}
export function parseAustralianYields(text:string,now:string){
  const rows=rbaRows(text);
  if(!rows.length||!('FCMYGBAG2D' in rows[0])||!('FCMYGBAG10D' in rows[0]))throw new Error('INVALID_RESPONSE');
  const points=rows.map(r=>({period:calendarDate(r['Series ID']),yield2y:r.FCMYGBAG2D?.trim()?Number(r.FCMYGBAG2D):NaN,yield10y:r.FCMYGBAG10D?.trim()?Number(r.FCMYGBAG10D):NaN}));
  return yieldObservations(points,'AUD',now,'RBA government bond yields',expansionUrls.aud,'RBA interpolated Australian Government bond closing yields, nominal constant maturity.');
}
export function parseCommodityBasket(text:string,now:string):Observation[]{
  const rows=rbaRows(text),meta=csvRecords(text.slice(text.indexOf('Title,'),text.indexOf('Series ID,')));
  const released=calendarDate(meta.find(r=>r.Title==='Publication date')?.['Commodity prices – US$']??'');
  if(released&&released>now.slice(0,10))return [];
  const result:Observation[]=[];
  for(const [id,group] of [['GRCPAIUSD','all'],['GRCPRCUSD','rural'],['GRCPBMUSD','metals'],['GRCPBCUSD','bulk']]){
    const values=rows.map(r=>({period:calendarDate(r['Series ID']),value:r[id]?.trim()?Number(r[id]):NaN})).filter(r=>r.period&&r.period<=now.slice(0,10)&&Number.isFinite(r.value)&&r.value>0).sort((a,b)=>b.period.localeCompare(a.period));
    if(values.length<4)continue;const latest=values[0],prior=values[3];
    const base={...observed('AUD',`alt.commodity.basket.${group}.v1`,latest.value,latest.period,now,'RBA export commodity baskets',expansionUrls.commodity,`RBA Australian export commodity ${group} basket in USD; three monthly observations log change, normalized tanh(4*change). Exposure is Australian exports, not identical across currencies. No asserted bullish FX sign or Core replacement.`,meta.find(r=>r.Title==='Units')?.['Commodity prices – US$']??'index','monthly'),normalizedValue:Math.tanh(4*Math.log(latest.value/prior.value)),releaseDate:released||null,rawInputs:values.slice(0,4),lineage:[`RBA:${id}`],economicCause:'export receipts and terms of trade'};
    result.push({...base,metric:`raw.RBA.${id}`,normalizedValue:null},base);
  }return result;
}
export function parseSupplyPressure(text:string,now:string):Observation[]{
  const rows=csvRecords(text);if(!rows.length)return [];
  // Columns are published vintages, not independent variables. Never select a future vintage.
  const vintage=Object.keys(rows[0]).filter(k=>/^[A-Z][a-z]{2}-\d{2}$/.test(k)&&calendarDate('01-'+k)&&calendarDate('01-'+k)<=now.slice(0,10)).sort((a,b)=>calendarDate('01-'+b).localeCompare(calendarDate('01-'+a)))[0];
  if(!vintage)return [];
  const points=rows.flatMap(r=>{const date=calendarDate(r.Date),value=r[vintage]?.trim();return date&&value&&Number.isFinite(Number(value))&&date<=now.slice(0,10)?[{period:date,value:Number(value)}]:[];}).sort((a,b)=>b.period.localeCompare(a.period));
  const latest=points[0];if(!latest)return [];
  const feature=observed('GLOBAL','alt.global.supply.pressure.v1',latest.value,latest.period,now,'New York Fed GSCPI',expansionUrls.supply,'Monthly global supply-chain pressure index. Shipping and manufacturing composite; not container spot rates. Vintage '+vintage+' received now; revision history never backdates availability.','standard deviations','monthly');
  return [{...feature,normalizedValue:Math.tanh(latest.value/3),rawInputs:[{...latest,vintage}]}];
}

export const annualResearch=[
  {id:'VC.IHR.PSRC.P5',metric:'alt.safety.homicide.change.v1',source:'UNODC via World Bank',unit:'intentional homicides per 100,000 people',cause:'aggregate public safety, investment climate, tourism and fiscal costs',definition:'Total-country intentional homicide rate. Aggregate all persons only; no demographic, protected-characteristic or individual records. Reporting differences prevent interpreting this as total crime.'},
  {id:'IS.SHP.GOOD.TU',metric:'alt.supply.container.change.v1',source:'UNCTAD via World Bank',unit:'TEU',cause:'trade volumes and port capacity',definition:'Annual container port throughput. Volume measure, not freight prices or real-time vessel activity.'},
  {id:'EG.USE.ELEC.KH.PC',metric:'alt.activity.electricity.change.v1',source:'World Bank energy statistics',unit:'kWh per capita',cause:'industrial activity, consumption and energy demand',definition:'Annual national electricity consumption per capita; coverage and reporting delays vary.'},
] as const;
const countries:Record<CurrencyCode,string>={USD:'USA',EUR:'EMU',GBP:'GBR',JPY:'JPN',CHF:'CHE',CAD:'CAN',AUD:'AUS',NZD:'NZL'};
export function annualResearchUrl(id:string){return `https://api.worldbank.org/v2/country/${Object.values(countries).join(';')}/indicator/${id}?source=2&format=json&per_page=120&mrv=5`;}
export function parseAnnualResearch(body:unknown,spec:typeof annualResearch[number],now:string):Observation[]{
  if(!Array.isArray(body)||!Array.isArray(body[1]))throw new Error('INVALID_RESPONSE');
  const result:Observation[]=[];
  for(const currency of currencies){
    const rows=(body[1] as {countryiso3code:string;date:string;value:number|null;indicator?:{id:string}}[]).filter(r=>r.countryiso3code===countries[currency]&&(!r.indicator||r.indicator.id===spec.id)&&typeof r.value==='number'&&r.value>=0&&/^\d{4}$/.test(r.date)&&observationQuality(spec.metric,r.value,r.date,now)!=='INVALID').sort((a,b)=>b.date.localeCompare(a.date));
    const latest=rows[0];if(!latest)continue;
    const previous=rows.find(r=>Number(r.date)===Number(latest.date)-1);
    const base={...observed(currency,`raw.${spec.id}`,latest.value!,latest.date,now,spec.source,annualResearchUrl(spec.id),spec.definition,spec.unit,'annual'),economicCause:spec.cause,lineage:[`WorldBank:${spec.id}`],rawInputs:rows.slice(0,3).map(r=>({country:r.countryiso3code,period:r.date,value:r.value}))};
    result.push(base);
    if(previous){const scale=latest.value!+previous.value!;result.push({...base,metric:spec.metric,normalizedValue:scale?clamp(2*(latest.value!-previous.value!)/scale):0,definition:spec.definition+' Normalized consecutive-year symmetric change. Sign and FX lead/lag unproven. '+spec.cause+'.'});}
  }
  return result;
}

/** Descriptive next-calendar-month seasonality, never a fitted forward outcome or confidence. */
export function parseSeasonality(xml:string,now:string):Observation[]{
  const month=(new Date(now).getUTCMonth()+1)%12,year=new Date(now).getUTCFullYear();
  const monthEnds=new Map<string,{period:string;rates:Record<string,number>}>();let newest='';
  for(const m of xml.matchAll(/<Cube\s+time=['"]([\d-]+)['"]\s*>([\s\S]*?)<\/Cube>/g)){
    const date=m[1];if(date>now.slice(0,10)||!Number.isFinite(Date.parse(date)))continue;
    const rates:Record<string,number>={EUR:1};for(const r of m[2].matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g))if(currencies.includes(r[1] as CurrencyCode))rates[r[1]]=Number(r[2]);
    if(!currencies.every(c=>Number.isFinite(rates[c])&&rates[c]>0))continue;
    newest=newest>date?newest:date;const key=date.slice(0,7),old=monthEnds.get(key);if(!old||old.period<date)monthEnds.set(key,{period:date,rates});
  }
  if(!newest||Date.parse(now)-Date.parse(newest)>10*dayMs)return [];
  const samples:{year:number;start:string;end:string;returns:Record<string,number>}[]=[];
  for(let y=year-20;y<year;y++){
    const endKey=`${y}-${String(month+1).padStart(2,'0')}`,startKey=month===0?`${y-1}-12`:`${y}-${String(month).padStart(2,'0')}`;
    const start=monthEnds.get(startKey),end=monthEnds.get(endKey);if(!start||!end||Number(end.period.slice(8))<25||Number(start.period.slice(8))<25)continue;
    const raw=Object.fromEntries(currencies.map(c=>[c,Math.log(start.rates[c]/end.rates[c])]));
    if(Object.values(raw).some(v=>Math.abs(v)>.35))continue;
    samples.push({year:y,start:start.period,end:end.period,returns:Object.fromEntries(currencies.map(c=>[c,raw[c]-currencies.filter(k=>k!==c).reduce((n,k)=>n+raw[k],0)/7]))});
  }
  if(samples.length<15)return [];
  return currencies.map(currency=>{
    const values=samples.map(s=>s.returns[currency]),mean=(a:number[])=>a.reduce((n,v)=>n+v,0)/a.length,average=mean(values),sd=Math.sqrt(mean(values.map(v=>(v-average)**2))),half=Math.floor(values.length/2);
    const agreement=Math.sign(mean(values.slice(0,half)))===Math.sign(mean(values.slice(half)));
    const stability=agreement?Math.abs(2*values.filter(v=>v>0).length/values.length-1):0;
    const strength=Math.tanh(average/Math.max(.01,sd))*values.length/(values.length+20)*stability;
    const score=.5+.15*strength;
    return {...observed(currency,'seasonality',score,newest,now,'ECB historical calendar context',expansionUrls.seasonality,'Next full calendar month vs equal-weight other seven currencies. Last 20 completed historical years; minimum 15. Shrunk by sample size and split-period sign consistency. Descriptive context only; no measured forecast skill. Core factor weight remains 4%.','normalized context','monthly estimator; daily freshness check'),normalizedValue:score,rawInputs:[{targetMonth:month+1,samples:values.length,from:samples[0].start,to:samples.at(-1)!.end,direction:Math.sign(average),mean:average,standardDeviation:sd,strength,stability,splitSignAgreement:agreement,history:samples.map(s=>({year:s.year,start:s.start,end:s.end,relativeLogReturn:s.returns[currency]}))}],economicCause:'calendar flows',lineage:['ECB:reference-fixings:calendar-month-v1']};
  });
}

export async function collectExpansion(checks:SourceCheck[]):Promise<Observation[]>{
  const british=collectBritishTenYearYield(checks);
  const jobs=[
    ['Bank of Canada benchmark yields',expansionUrls.cad,'CAD',['yield2y','yield10y','alt.rates.curve.v1'],async()=>parseCanadianYields(await (await sourceFetch(expansionUrls.cad)).json(),new Date().toISOString())],
    ['Japan Ministry of Finance yields',expansionUrls.jpy,'JPY',['yield2y','yield10y','alt.rates.curve.v1'],async()=>parseJapaneseYields(await (await sourceFetch(expansionUrls.jpy,'text/csv')).text(),new Date().toISOString())],
    ['RBA government bond yields',expansionUrls.aud,'AUD',['yield2y','yield10y','alt.rates.curve.v1'],async()=>parseAustralianYields(await (await sourceFetch(expansionUrls.aud,'text/csv')).text(),new Date().toISOString())],
    ['New York Fed GSCPI',expansionUrls.supply,'GLOBAL',['alt.global.supply.pressure.v1'],async()=>parseSupplyPressure(await (await sourceFetch(expansionUrls.supply,'text/csv')).text(),new Date().toISOString())],
    ['ECB historical calendar context',expansionUrls.seasonality,'ALL',['seasonality'],async()=>parseSeasonality(await (await sourceFetch(expansionUrls.seasonality,'application/xml')).text(),new Date().toISOString())],
    ...annualResearch.map(spec=>[spec.source,annualResearchUrl(spec.id),'ALL',[spec.metric],async()=>parseAnnualResearch(await (await sourceFetch(annualResearchUrl(spec.id))).json(),spec,new Date().toISOString())]),
    ['RBA export commodity baskets',expansionUrls.commodity,'AUD',['alt.commodity.basket.all.v1','alt.commodity.basket.rural.v1','alt.commodity.basket.metals.v1','alt.commodity.basket.bulk.v1'],async()=>parseCommodityBasket(await (await sourceFetch(expansionUrls.commodity,'text/csv')).text(),new Date().toISOString())],
    ['ECB AAA sovereign par yields',expansionUrls.eur,'EUR',['yield2y','yield10y','alt.rates.curve.v1'],async()=>parseEuroYields(await (await sourceFetch(expansionUrls.eur,'text/csv')).text(),new Date().toISOString())],
  ] as [string,string,string,string[],()=>Promise<Observation[]>][];
  const results=await Promise.all(jobs.map(([source,url,currency,metrics,read])=>sourceAttempt(checks,source,url,currency,metrics,async()=>{const rows=await read();return rows.length?rows:null;})));
  // Per-currency failures/staleness are explicit, even if the shared provider request succeeded.
  annualResearch.forEach((spec,index)=>{const rows=results[index+5]??[];for(const currency of currencies)if(!rows.some(r=>r.currency===currency&&r.metric===spec.metric&&r.quality==='VALID'))checks.push({at:new Date().toISOString(),source:spec.source,url:annualResearchUrl(spec.id),currency,metrics:[spec.metric],status:'MISSING',cause:rows.some(r=>r.currency===currency)?'STALE_OR_INSUFFICIENT_HISTORY':'NO_VALID_OBSERVATIONS',fallback:'No research contribution',latencyMs:0});});
  return [...results.flatMap(r=>r??[]),...await british];
}
