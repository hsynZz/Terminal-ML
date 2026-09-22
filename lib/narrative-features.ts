import { centralBankFeeds, scoreFinancialText, type TextSignal } from './sentiment';
import { currencies } from './terminal-data';
import { dayMs, type Observation } from './production-data';
const words=(text:string)=>[...new Set(text.toLowerCase().match(/[a-z]{3,}/g)??[])].sort();
const similarity=(a:string[],b:string[])=>{const set=new Set(b);return a.filter(x=>set.has(x)).length/Math.max(1,new Set([...a,...b]).size);};
/** Observed official publication activity, not all news, social reach or economic forecasts. */
export function narrativeObservations(items:TextSignal[],now:string):Observation[] {
  const result:Observation[]=[];
  for(const currency of currencies){
    const unique=new Map<string,TextSignal>();
    for(const item of items)if(item.currency===currency&&item.publishedAt&&item.publishedAt<=now&&Date.parse(now)-Date.parse(item.publishedAt)<28*dayMs)unique.set(item.source+':'+item.title+':'+item.publishedAt,item);
    const rows=[...unique.values()],recent=rows.filter(r=>Date.parse(now)-Date.parse(r.publishedAt!)<7*dayMs),prior=rows.filter(r=>Date.parse(now)-Date.parse(r.publishedAt!)>=7*dayMs);
    if(!rows.length)continue;
    const urls=centralBankFeeds.filter(f=>f.currency===currency).map(f=>f.url),sourceUrl=urls.join(' ');
    const add=(metric:string,value:number,definition:string)=>result.push({currency,metric,value,normalizedValue:value,period:now.slice(0,10),receivedAt:now,releaseDate:null,source:'Official central bank RSS',sourceUrl,unit:'bounded feature',frequency:'publication-event',quality:'VALID',featureVersion:'official-narrative-v1',definition,economicCause:'central-bank-communication',lineage:urls,rawInputs:rows.map(r=>({publishedAt:r.publishedAt,source:r.source,tokens:words(r.title+' '+r.summary),tone:scoreFinancialText(r.title+' '+r.summary)}))});
    add('alt.narrative.activity.v1',Math.tanh((recent.length-prior.length/3)/Math.max(2,prior.length/3)),'Observed official items in last 7 days versus prior 21-day weekly average. Feed is a bounded sample, not all media; v1.');
    if(recent.length&&prior.length){const old=prior.map(r=>words(r.title+' '+r.summary));
      const novelty=recent.reduce((n,r)=>n+1-Math.max(...old.map(p=>similarity(words(r.title+' '+r.summary),p))),0)/recent.length;
      add('alt.narrative.novelty.v1',novelty,'Mean 1-max Jaccard token overlap with earlier 7-28 day official publications; v1. No directional interpretation.');
    }
  }return result;
}
