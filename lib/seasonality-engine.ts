import {daysBetween,validDate,SEASONALITY_VERSION,type PairPrice} from './seasonality-data';
export const LOOKBACKS = [5,10,15,20,25,'MAX'] as const;
export type Lookback = typeof LOOKBACKS[number];
export const mean=(a:number[]):number|null=>a.length?a.reduce((s,v)=>s+v,0)/a.length:null;
export function median(a:number[]):number|null{if(!a.length)return null;const s=[...a].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;}
export function standardDeviation(a:number[]):number|null{if(a.length<2)return null;const m=mean(a)!;return Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/(a.length-1));}
export function validMonthDay(md:string):boolean{return /^\d{2}-\d{2}$/.test(md)&&validDate(`2000-${md}`);}
export type YearResult={year:number;endYear:number;startDate:string;endDate:string;startPrice:number;endPrice:number;return:number;logReturn:number;mfe:number;mae:number;dailyLogReturns:number[];fixings:number;largeMoves:number};
export type ExcludedYear={year:number;reason:string};
export type SeasonalStats={sample:number;average:number|null;median:number|null;positive:number;negative:number;flat:number;winRate:number|null;standardDeviation:number|null;spotSharpe:number|null;consistency:number|null;sortino:number|null;dailySample:number;best:YearResult|null;worst:YearResult|null;averageMfe:number|null;averageMae:number|null;trimmedMean:number|null;direction:'Positive'|'Negative'|'Mixed'|'Insufficient data'};
const dateFor=(year:number,md:string)=>`${year}-${md}`;
export const CALENDAR=Array.from({length:365},(_,i)=>new Date(Date.UTC(2001,0,i+1)).toISOString().slice(5,10));
function maxGap(rows:PairPrice[]):number{return rows.slice(1).reduce((n,r,i)=>Math.max(n,daysBetween(rows[i].date,r.date)),0);}
function eligibleYear(rows:PairPrice[],year:number):string|null {
  if(rows.length<240)return 'FEWER_THAN_240_OFFICIAL_FIXINGS';
  if(daysBetween(`${year}-01-01`,rows[0].date)>7||daysBetween(rows.at(-1)!.date,`${year}-12-31`)>7)return 'INCOMPLETE_YEAR_BOUNDARY';
  if(maxGap(rows)>7)return 'GAP_EXCEEDS_7_CALENDAR_DAYS';
  if(rows.some(r=>r.quality==='REVIEW_REQUIRED'))return 'UNVERIFIED_LARGE_MOVE';
  return null;
}
export function windowResult(prices:PairPrice[],year:number,start:string,end:string):{result:YearResult|null;reason:string|null}{
  if(!validMonthDay(start)||!validMonthDay(end))throw new Error('Invalid seasonal window');
  const endYear=year+(end<start?1:0),startDate=dateFor(year,start),endDate=dateFor(endYear,end);
  if(!validDate(startDate)||!validDate(endDate))return {result:null,reason:'FEB_29_NOT_PRESENT'};
  const rows=prices.filter(r=>r.date>=startDate&&r.date<=endDate);
  if(rows.length<2)return {result:null,reason:'FEWER_THAN_TWO_FIXINGS'};
  if(daysBetween(startDate,rows[0].date)>4||daysBetween(rows.at(-1)!.date,endDate)>4||maxGap(rows)>7)return {result:null,reason:'WINDOW_DATA_GAP'};
  if(rows.some(r=>r.quality==='REVIEW_REQUIRED'))return {result:null,reason:'UNVERIFIED_LARGE_MOVE'};
  const first=rows[0],last=rows.at(-1)!,returns=rows.map(r=>r.close/first.close-1);
  return {result:{year,endYear,startDate:first.date,endDate:last.date,startPrice:first.close,endPrice:last.close,return:last.close/first.close-1,logReturn:Math.log(last.close/first.close),mfe:Math.max(0,...returns),mae:Math.min(0,...returns),dailyLogReturns:rows.slice(1).map((r,i)=>Math.log(r.close/rows[i].close)),fixings:rows.length,largeMoves:rows.filter(r=>r.quality==='VERIFIED_LARGE_MOVE').length},reason:null};
}
export function summarize(results:YearResult[]):SeasonalStats{
  const r=results.map(x=>x.return),daily=results.flatMap(x=>x.dailyLogReturns),avg=mean(r),med=median(r),sd=standardDeviation(r),dailySd=standardDeviation(daily),dailyMean=mean(daily);
  const pos=r.filter(x=>x>0).length,neg=r.filter(x=>x<0).length,downside=daily.length?Math.sqrt(daily.reduce((s,x)=>s+Math.min(0,x)**2,0)/daily.length):null;
  const sorted=[...results].sort((a,b)=>a.return-b.return||a.year-b.year),trim=Math.floor(r.length*.1),ordered=[...r].sort((a,b)=>a-b);
  return {sample:r.length,average:avg,median:med,positive:pos,negative:neg,flat:r.length-pos-neg,winRate:r.length?pos/r.length:null,standardDeviation:sd,
    spotSharpe:daily.length>=20&&results.length>=5&&dailySd!==null&&dailySd>1e-12?dailyMean!/dailySd*Math.sqrt(252):null,
    consistency:sd!==null&&sd>1e-12?avg!/sd:null,
    sortino:daily.length>=20&&results.length>=5&&downside!==null&&downside>1e-12?dailyMean!/downside*Math.sqrt(252):null,
    dailySample:daily.length,best:sorted.at(-1)??null,worst:sorted[0]??null,averageMfe:mean(results.map(x=>x.mfe)),averageMae:mean(results.map(x=>x.mae)),trimmedMean:r.length>=10?mean(ordered.slice(trim,r.length-trim)):null,
    direction:r.length<5?'Insufficient data':avg!>0&&med!>0&&pos/r.length>.5?'Positive':avg!<0&&med!<0&&neg/r.length>.5?'Negative':'Mixed'};
}
export type CurvePoint={monthDay:string;average:number|null;median:number|null;current:number|null;sample:number;years:Record<string,number>;sourceDates:Record<string,string>};
export type SeasonalityAnalysis={version:string;asOf:string;lookback:Lookback;start:string;end:string;requestedYears:number[];years:YearResult[];excluded:ExcludedYear[];stats:SeasonalStats;available:boolean;comparison:{lookback:Lookback;requested:number;valid:number;available:boolean;stats:SeasonalStats}[];curve:CurvePoint[];currentYear:number;currentThrough:string|null;currentWindow:YearResult|null;completedYears:number[];methodology:typeof METHODOLOGY};
export const METHODOLOGY={chart:'Calendar month/day; no Feb 29 on the 365-day axis. Last published fixing at/before each calendar date, at most 4 days old. No backfill before the first fixing.',window:'First published fixing on/after start; last on/before end. Maximum boundary shift 4 calendar days; internal gap at most 7 days. Crosses use same-date legs.',normalization:'100 × price / first actual fixing in the displayed annual or selected window path. Mean is arithmetic across normalized indices; median is separate.',sharpe:'Spot Return Sharpe (rf=0): mean of pooled daily log spot returns / sample standard deviation × sqrt(252). No carry, costs or risk-free subtraction. At least 20 daily returns and 5 years.',consistency:'Mean simple window return / sample standard deviation of window returns. Not annualized; not Sharpe.',mfeMae:'Long-base excursions from window entry, based only on published noon fixes, not intraday highs/lows.',vintages:'Retrospective views use the latest stored provider vintage. Point-in-time mode only uses vintages actually received by its cutoff; pre-archive simulations are unavailable.'} as const;
export function analyzeSeasonality(input:PairPrice[],options:{asOf:string;lookback:Lookback;start:string;end:string;view?:'year'|'window';fromYear?:number;toYear?:number}):SeasonalityAnalysis{
  const {asOf,lookback,start,end}=options;
  if(!validDate(asOf)||!LOOKBACKS.includes(lookback)||!validMonthDay(start)||!validMonthDay(end))throw new Error('Invalid seasonality parameters');
  const prices=input.filter(p=>p.date<=asOf).sort((a,b)=>a.date.localeCompare(b.date));
  for(let i=0;i<prices.length;i++)if(!validDate(prices[i].date)||!Number.isFinite(prices[i].close)||prices[i].close<=0||(i>0&&prices[i].date===prices[i-1].date))throw new Error('Invalid or duplicate pair data');
  const currentYear=Number(asOf.slice(0,4)),lastYear=currentYear-1-(end<start?1:0),firstYear=prices.length?Number(prices[0].date.slice(0,4)):currentYear;
  const byYear=new Map<number,PairPrice[]>();for(const p of prices){const y=Number(p.date.slice(0,4));if(!byYear.has(y))byYear.set(y,[]);byYear.get(y)!.push(p);}
  const yearIssues=new Map<number,string|null>();for(let y=firstYear;y<currentYear;y++)yearIssues.set(y,eligibleYear(byYear.get(y)??[],y));
  const candidates=new Map<number,{result:YearResult|null;reason:string|null}>();
  for(let y=firstYear;y<=lastYear;y++){
    const bad=yearIssues.get(y)??(end<start?yearIssues.get(y+1):null);
    candidates.set(y,bad?{result:null,reason:bad}:windowResult([...(byYear.get(y)??[]),...(end<start?byYear.get(y+1)??[]:[])],y,start,end));
  }
  if((options.fromYear!==undefined||options.toYear!==undefined)&&(!Number.isInteger(options.fromYear)||!Number.isInteger(options.toYear)||options.fromYear!<1971||options.toYear!>lastYear||options.fromYear!>options.toYear!))throw new Error('Invalid historical year range');
  const select=(lb:Lookback,custom=false)=>{
    const from=custom?options.fromYear!:lb==='MAX'?firstYear:lastYear-lb+1,to=custom?options.toYear!:lastYear,requested=Array.from({length:Math.max(0,to-from+1)},(_,i)=>from+i),results:YearResult[]=[],excluded:ExcludedYear[]=[];
    for(const y of requested){const c=candidates.get(y);if(c?.result)results.push(c.result);else excluded.push({year:y,reason:c?.reason??'NO_HISTORY'});}
    return {requested,results,excluded,available:results.length>=5&&(custom?results.length===requested.length:lb==='MAX'||results.length===lb)};
  };
  const selected=select(lookback,options.fromYear!==undefined),stats=summarize(selected.results),comparison=LOOKBACKS.map(lb=>{const s=select(lb);return {lookback:lb,requested:s.requested.length,valid:s.results.length,available:s.available,stats:summarize(s.results)};});
  const view=options.view??'year',axis=view==='year'?CALENDAR:(()=>{const a=CALENDAR.indexOf(start==='02-29'?'03-01':start),b=CALENDAR.indexOf(end==='02-29'?'02-28':end);return b>=a?CALENDAR.slice(a,b+1):[...CALENDAR.slice(a),...CALENDAR.slice(0,b+1)];})();
  const paths=new Map<number,Map<string,{value:number;sourceDate:string}>>();
  const makePath=(year:number,isCurrent=false)=>{
    const targetStart=view==='year'?`${year}-01-01`:`${year}-${start}`,targetEnd=view==='year'?`${year}-12-31`:`${year+(end<start?1:0)}-${end}`;
    if(!validDate(targetStart)||!validDate(targetEnd))return;
    const rows=prices.filter(p=>p.date>=targetStart&&p.date<=targetEnd&&(isCurrent?p.date<=asOf:true));if(!rows.length||rows.some(r=>r.quality==='REVIEW_REQUIRED'))return;
    const map=new Map<string,{value:number;sourceDate:string}>();let i=-1,wrapped=0,lastMd=axis[0];
    for(const md of axis){if(md<lastMd)wrapped=1;lastMd=md;const date=`${year+wrapped}-${md}`;
      if(isCurrent&&(date>asOf||date>rows.at(-1)!.date))break;
      while(i+1<rows.length&&rows[i+1].date<=date)i++;
      if(i>=0&&rows[i].quality!=='REVIEW_REQUIRED'&&daysBetween(rows[i].date,date)<=4)map.set(md,{value:100*rows[i].close/rows[0].close,sourceDate:rows[i].date});
    }paths.set(year,map);
  };
  if(selected.available)for(const y of selected.results)makePath(y.year);
  makePath(currentYear,true);
  const curve=axis.map(monthDay=>{
    const years:Record<string,number>={},sourceDates:Record<string,string>={};
    for(const y of selected.results){const p=paths.get(y.year)?.get(monthDay);if(p){years[y.year]=p.value;sourceDates[y.year]=p.sourceDate;}}
    const values=Object.values(years),cur=paths.get(currentYear)?.get(monthDay);if(cur)sourceDates[currentYear]=cur.sourceDate;
    return {monthDay,years,sourceDates,average:mean(values),median:median(values),current:cur?.value??null,sample:values.length};
  });
  const currentRows=byYear.get(currentYear)??[];
  return {version:SEASONALITY_VERSION,asOf,lookback,start,end,requestedYears:selected.requested,years:selected.available?selected.results:[],excluded:selected.excluded,stats:selected.available?stats:summarize([]),available:selected.available,comparison,curve,currentYear,currentThrough:currentRows.at(-1)?.date??null,currentWindow:windowResult(currentRows,currentYear,start,end).result,completedYears:[...yearIssues].filter(([,reason])=>reason===null).map(([year])=>year),methodology:METHODOLOGY};
}
