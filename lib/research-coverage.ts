import { observationQuality, type Observation, type SourceCheck } from './production-data';

export const sourceGaps=[
  {name:'Commodity Core',scope:'CORE',status:'UNAVAILABLE',reason:'Observed oil, gas and Australian export baskets are Research inputs. A validated currency-specific exposure mapping is still missing.'},
  {name:'GBP / CHF / NZD comparable 2Y + 10Y',scope:'CORE',status:'NOT YET CONNECTED',reason:'Public curve definitions differ; UK/NZ endpoints rejected this environment. Do not mix zero-coupon spot rates, monthly averages and benchmark yields without an explicit conversion.'},
  {name:'Risk anchor',scope:'CORE',status:'CARRIED INPUT',reason:'The existing risk formula retains a fixed 50% anchor. Macro receipts cannot certify that anchor. Preserved to avoid an unrequested Core change.'},
  {name:'JPY / NZD central-bank language',scope:'CORE',status:'NOT YET CONNECTED',reason:'JPY RSS offers dated headlines, not sufficient speech text; NZ endpoint access is unavailable. No artificial neutral sentiment.'},
  {name:'FX options / IV / risk reversals / skew',scope:'RESEARCH',status:'PREMIUM SOURCE RECOMMENDED',reason:'Need licensed consistent currency-pair volatility surfaces, delta conventions and timestamps; realized FX volatility is not implied volatility.',history:'5–10 years across stress regimes',frequency:'daily, fixed fixing',pointInTime:'As-quoted surfaces, tenor/delta definitions and vendor corrections',integration:'Versioned pair/tenor/delta adapter; separate event-target calibration; no directional default'},
  {name:'Cross-currency basis / implied rate paths',scope:'RESEARCH',status:'PREMIUM SOURCE RECOMMENDED',reason:'Funding indices and policy rates cannot reproduce executable basis or market-implied OIS paths.',history:'5–10 years',frequency:'daily synchronized curve snapshots',pointInTime:'As-of quotes, tenor and collateral conventions, corrected quote vintages',integration:'Pair-specific basis and OIS curve adapters; preserve observation and receipt times'},
  {name:'Freight spot prices / port and vessel activity',scope:'RESEARCH',status:'PREMIUM SOURCE RECOMMENDED',reason:'GSCPI and annual container throughput are partial proxies, not container spot rates or a real-time global port panel.',history:'At least 5 years',frequency:'daily/weekly',pointInTime:'As-published route/container definitions; vessel aggregation and revisions',integration:'Licensed aggregate route/port panel; currency trade exposure; no vessel/person tracking UI'},
  {name:'Forecast / expectation dispersion',scope:'RESEARCH',status:'PREMIUM SOURCE RECOMMENDED',reason:'Requires timestamped independent forecast vintages; model point-cloud dispersion is not economist disagreement.',history:'5 years of individual forecast vintages',frequency:'each forecast release',pointInTime:'Pre-release consensus, contributor changes and exact cutoff',integration:'Dispersion from frozen survey panels; no revised-history backfill'},
  ...['Google Trends','Social media','YouTube activity','Retail positioning','Broad news acceleration / novelty'].map(name=>({name,scope:'RESEARCH',status:'NOT YET CONNECTED',reason:'No configured stable authorized point-in-time feed. Existing official central-bank narratives remain separately available.'})),
];
const families=[
  {name:'Positioning change / acceleration',prefixes:['alt.cot.']},
  {name:'Energy spot-price proxies',prefixes:['alt.global.energy.']},
  {name:'Funding / financial conditions',prefixes:['alt.global.funding.']},
  {name:'Labor / consumption',prefixes:['alt.us.labor.','alt.us.consumption.']},
  {name:'Official central-bank narratives',prefixes:['alt.narrative.']},
  {name:'Sovereign yield curve / repricing',prefixes:['alt.rates.']},
  {name:'Australian commodity export baskets',prefixes:['alt.commodity.basket.']},
  {name:'Supply chains / aggregate port volumes',prefixes:['alt.global.supply.','alt.supply.']},
  {name:'Aggregate public-safety statistics',prefixes:['alt.safety.']},
  {name:'Electricity / real activity',prefixes:['alt.activity.']},
  {name:'Metadata-discovered economic proxies',prefixes:['alt.proxy.','proxy.']},
];
export type ResearchReceipt=Pick<Observation,'currency'|'metric'|'value'|'period'|'receivedAt'|'releaseDate'|'source'|'sourceUrl'|'quality'|'frequency'|'featureVersion'>;
export function researchCoverage(observations:ResearchReceipt[],checks:SourceCheck[],at:string){
  const latest=new Map<string,ResearchReceipt>();
  for(const o of observations.filter(o=>o.metric.startsWith('alt.')||o.metric.startsWith('proxy.'))){const id=o.currency+':'+o.metric,old=latest.get(id);if(!old||old.receivedAt<o.receivedAt)latest.set(id,o);}
  const receipts:ResearchReceipt[]=[...latest.values()].map(({currency,metric,value,period,receivedAt,releaseDate,source,sourceUrl,quality,frequency,featureVersion})=>({currency,metric,value,period,receivedAt,releaseDate,source,sourceUrl,quality,frequency,featureVersion}));
  const current=(r:ResearchReceipt)=>Number.isFinite(Date.parse(r.receivedAt))&&r.receivedAt<=at&&(!r.releaseDate||Number.isFinite(Date.parse(r.releaseDate))&&r.releaseDate<=at)&&r.quality==='VALID'&&observationQuality(r.metric,r.value,r.period,at)==='VALID';
  const classes=families.map(f=>{const rows=receipts.filter(r=>f.prefixes.some(p=>r.metric.startsWith(p))),fresh=rows.filter(current),failed=checks.some(c=>c.status!=='SUCCESS'&&c.metrics.some(m=>f.prefixes.some(p=>m.startsWith(p))));
    return {name:f.name,status:fresh.length?(failed||fresh.length<rows.length?'PARTIAL':'FRESH'):rows.length?'STALE':failed?'FAILED':'WAITING FOR DATA',features:new Set(fresh.map(r=>r.metric)).size,observations:fresh.length,currencies:[...new Set(fresh.map(r=>r.currency))],latestPeriod:rows.map(r=>r.period).sort().at(-1)??null,sourceUrls:[...new Set(rows.map(r=>r.sourceUrl))]};});
  return {asOf:at,scope:'Available registered Research families; independent of Core LIVE and adaptive qualification. Not a percentage of all possible alternative data.',families:classes.length,connected:classes.filter(c=>c.observations>0).length,freshObservations:receipts.filter(current).length,classes,receipts,notConnected:sourceGaps.filter(g=>g.scope==='RESEARCH')};
}
