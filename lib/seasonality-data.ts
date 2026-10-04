/** Isolated descriptive research. These rates must never enter the Evidence/ML stores. */
export const FX_CURRENCIES = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'] as const;
export type FxCurrency = typeof FX_CURRENCIES[number];
export const NORMALIZATION_VERSION = 'usd-per-unit-v1';
export const SEASONALITY_VERSION = 'fx-seasonality-v2';
export const FX_SOURCE = 'Federal Reserve H.10 via FRED';
export const FX_SERIES = [
  {currency:'EUR',id:'DEXUSEU',base:'EUR',quote:'USD',start:'1999-01-04',units:'USD per EUR'},
  {currency:'GBP',id:'DEXUSUK',base:'GBP',quote:'USD',start:'1971-01-04',units:'USD per GBP'},
  {currency:'AUD',id:'DEXUSAL',base:'AUD',quote:'USD',start:'1971-01-04',units:'USD per AUD'},
  {currency:'NZD',id:'DEXUSNZ',base:'NZD',quote:'USD',start:'1971-01-04',units:'USD per NZD'},
  {currency:'JPY',id:'DEXJPUS',base:'USD',quote:'JPY',start:'1971-01-04',units:'JPY per USD'},
  {currency:'CHF',id:'DEXSZUS',base:'USD',quote:'CHF',start:'1971-01-04',units:'CHF per USD'},
  {currency:'CAD',id:'DEXCAUS',base:'USD',quote:'CAD',start:'1971-01-04',units:'CAD per USD'},
] as const;
export type FxSeries = typeof FX_SERIES[number];
export type FxQuality = 'VALID'|'REVIEW_REQUIRED'|'VERIFIED_LARGE_MOVE';
export type FxObservation = {date:string;currency:FxCurrency;raw:number;usdPerUnit:number;quality:FxQuality;verification?:string};
export type PairPrice = {date:string;close:number;quality:FxQuality;baseUsd:number;quoteUsd:number};
export type FxIssue = {date:string;series:string;reason:string};
const DAY = 86400000;
export const daysBetween = (a:string,b:string) => (Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/DAY;
export function validDate(date:string):boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date+'T00:00:00Z')) && new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
}
export function normalizeQuote(value:number,base:FxCurrency,quote:FxCurrency):number {
  if(!Number.isFinite(value)||value<=0||base===quote||![base,quote].includes('USD')) throw new Error('Invalid USD quote');
  return quote==='USD'?value:1/value;
}
export function pairCurrencies(pair:string):[FxCurrency,FxCurrency] {
  const base=pair.slice(0,3) as FxCurrency,quote=pair.slice(3) as FxCurrency;
  if(pair.length!==6||!FX_CURRENCIES.includes(base)||!FX_CURRENCIES.includes(quote)||base===quote)throw new Error('Invalid currency pair');
  return [base,quote];
}
export const FX_PAIRS = FX_CURRENCIES.flatMap(base=>FX_CURRENCIES.filter(quote=>quote!==base).map(quote=>base+quote));
export function fredHistoryUrl(start:string,end:string):string {
  if(!validDate(start)||!validDate(end)||start>end)throw new Error('Invalid source dates');
  return `https://fred.stlouisfed.org/graph/fredgraph.csv?${new URLSearchParams({id:FX_SERIES.map(x=>x.id).join(','),cosd:start,coed:end})}`;
}
/** FRED uses blank/dot for an explicitly missing observation, never a zero. */
export function parseFxCsv(csv:string,asOf:string,prior:FxObservation[]=[],fromDate?:string):{rows:FxObservation[];issues:FxIssue[];missing:Record<string,number>;duplicates:number} {
  if(!validDate(asOf)||(fromDate!==undefined&&(!validDate(fromDate)||fromDate>asOf)))throw new Error('Invalid as-of date or import range');
  const lines=csv.trim().split(/\r?\n/), header=lines.shift()?.replace(/^\uFEFF/,'').split(',');
  if(!header||header[0]!=='observation_date'||FX_SERIES.some(s=>header.filter(h=>h===s.id).length!==1)||header.length!==8)throw new Error('FRED schema mismatch');
  const seen=new Map<string,string>(), rows:FxObservation[]=[],issues:FxIssue[]=[],missing:Record<string,number>={};let duplicates=0;
  for(const line of lines){
    if(!line.trim())continue;
    const cells=line.split(','),date=cells[0];
    if(cells.length!==header.length||!validDate(date))throw new Error('Malformed FRED date or row');
    if(seen.has(date)){if(seen.get(date)!==line)throw new Error(`Conflicting duplicate ${date}`);duplicates++;continue;}
    seen.set(date,line);
    if(date>asOf){issues.push({date,series:'ALL',reason:'FUTURE_DATE'});continue;}
    // Multi-series FRED responses can contain older rows for some legs. Bound
    // every series and missing-cell diagnostic to the same requested import range.
    if(fromDate&&date<fromDate)continue;
    for(const series of FX_SERIES){
      const raw=cells[header.indexOf(series.id)].trim();
      if(!raw||raw==='.'){if(date>=series.start)missing[series.id]=(missing[series.id]??0)+1;continue;}
      const value=Number(raw),weekday=new Date(date+'T00:00:00Z').getUTCDay();
      if(!/^\d+(?:\.\d+)?$/.test(raw)||!Number.isFinite(value)||value<=0||date<series.start||weekday===0||weekday===6){issues.push({date,series:series.id,reason:'INVALID_PRICE_OR_FIXING_DATE'});continue;}
      rows.push({date,currency:series.currency,raw:value,usdPerUnit:normalizeQuote(value,series.base,series.quote),quality:'VALID'});
    }
  }
  rows.sort((a,b)=>a.date.localeCompare(b.date)||a.currency.localeCompare(b.currency));
  const last=new Map<FxCurrency,FxObservation>();
  for(const p of [...prior].sort((a,b)=>a.date.localeCompare(b.date)))last.set(p.currency,p);
  for(const row of rows){
    const before=last.get(row.currency);
    if(before&&before.date<row.date&&Math.abs(Math.log(row.usdPerUnit/before.usdPerUnit))>Math.log(1.12)){
      row.quality='REVIEW_REQUIRED';issues.push({date:row.date,series:FX_SERIES.find(s=>s.currency===row.currency)!.id,reason:'LARGE_MOVE_REQUIRES_SOURCE_CONFIRMATION'});
    }
    last.set(row.currency,row);
  }
  return {rows,issues,missing,duplicates};
}
/** Exact same-date intersection; no asynchronous leg carry or raw-series multiplication. */
export function derivePair(rows:FxObservation[],pair:string,asOf:string):PairPrice[] {
  const [base,quote]=pairCurrencies(pair),dates=new Map<string,Map<FxCurrency,FxObservation>>();
  for(const row of rows){
    if(row.date>asOf||!validDate(row.date)||![base,quote].includes(row.currency))continue;
    if(!Number.isFinite(row.usdPerUnit)||row.usdPerUnit<=0)throw new Error('Invalid canonical quote');
    const legs=dates.get(row.date)??new Map<FxCurrency,FxObservation>();
    if(legs.has(row.currency))throw new Error('Duplicate canonical date/currency');
    legs.set(row.currency,row);dates.set(row.date,legs);
  }
  const result:PairPrice[]=[];
  for(const [date,legs] of dates){
    const b=legs.get(base),q=legs.get(quote),baseUsd=base==='USD'?1:b?.usdPerUnit,quoteUsd=quote==='USD'?1:q?.usdPerUnit;
    if(baseUsd===undefined||quoteUsd===undefined)continue;
    const quality=[b?.quality,q?.quality].includes('REVIEW_REQUIRED')?'REVIEW_REQUIRED':[b?.quality,q?.quality].includes('VERIFIED_LARGE_MOVE')?'VERIFIED_LARGE_MOVE':'VALID';
    result.push({date,close:baseUsd/quoteUsd,baseUsd,quoteUsd,quality});
  }
  return result.sort((a,b)=>a.date.localeCompare(b.date));
}
export function pairProvenance(pair:string){
  const [base,quote]=pairCurrencies(pair),series=FX_SERIES.filter(s=>s.currency===base||s.currency===quote);
  return {source:FX_SOURCE,pair,isDerived:base!=='USD'&&quote!=='USD',sourcePairA:base==='USD'?'USDUSD':base+'USD',sourcePairB:quote==='USD'?'USDUSD':quote+'USD',operation:'DIVIDE_CANONICAL_USD_PER_UNIT',formula:`${pair} = USD per ${base} / USD per ${quote}`,normalizationVersion:NORMALIZATION_VERSION,fixing:'New York noon reference rate; not a market closing price',frequency:'Daily observations; weekly H.10 publication',sourceTimestamp:null,series:series.map(s=>({...s,url:`https://fred.stlouisfed.org/series/${s.id}`,normalization:s.quote==='USD'?'IDENTITY':'INVERT'}))};
}
/** Weekly H.10 publication, including a holiday buffer; retrieval is never the quote date. */
export function fxFreshness(lastDate:string|null,asOf:string):'FRESH'|'STALE'|'UNAVAILABLE' {
  if(!lastDate||!validDate(lastDate)||!validDate(asOf)||lastDate>asOf)return 'UNAVAILABLE';
  return daysBetween(lastDate,asOf)<=10?'FRESH':'STALE';
}
