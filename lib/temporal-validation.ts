/** Date-clustered HAC inference. Label overlap is retained, never counted as iid. */
export const VALIDATION_VERSION='date-cluster-hac-v1';
const average=(x:number[])=>x.length?x.reduce((a,b)=>a+b,0)/x.length:0;
export type TemporalRow={asOf:string;entryDate?:string;labelEnd:string;resolvedAt?:string;pair?:string};
export type Removal={asOf:string;entity:string;entryDate:string|null;labelEnd:string;reason:'INVALID_INTERVAL'|'DUPLICATE'|'LABEL_NOT_AVAILABLE'|'LABEL_OVERLAP'|'FOLD_EMBARGO';testStart?:string;testEnd?:string;embargoEnd?:string};
export type DateCluster<T>={asOf:string;start:string;end:string;rows:T[]};
export function labelInterval(row:TemporalRow){
  const start=row.entryDate??row.asOf.slice(0,10),end=row.labelEnd;
  if(!Number.isFinite(Date.parse(row.asOf))||!Number.isFinite(Date.parse(start))||!Number.isFinite(Date.parse(end))||!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||new Date(start).toISOString().slice(0,10)!==start||new Date(end).toISOString().slice(0,10)!==end||start<row.asOf.slice(0,10)||end<=start||row.resolvedAt&&(!Number.isFinite(Date.parse(row.resolvedAt))||row.resolvedAt.slice(0,10)<end))return null;
  return {start,end,entryKnown:!!row.entryDate};
}
export function dateClusters<T extends TemporalRow>(rows:T[]){
  const groups=new Map<string,Map<string,T>>(),removed:Removal[]=[];
  for(const row of [...rows].sort((a,b)=>a.asOf.localeCompare(b.asOf))){
    const interval=labelInterval(row),date=row.asOf.slice(0,10),entity=row.pair??'';
    if(!interval){removed.push({asOf:row.asOf,entity,entryDate:row.entryDate??null,labelEnd:row.labelEnd,reason:'INVALID_INTERVAL'});continue;}
    const group=groups.get(date)??new Map<string,T>();
    if(group.has(entity)){removed.push({asOf:row.asOf,entity,entryDate:row.entryDate??null,labelEnd:row.labelEnd,reason:'DUPLICATE'});continue;}
    group.set(entity,row);groups.set(date,group);
  }
  const clusters:DateCluster<T>[]=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([asOf,group])=>{
    const values=[...group.values()],intervals=values.map(r=>labelInterval(r)!);
    return {asOf,start:intervals.map(x=>x.start).sort()[0],end:intervals.map(x=>x.end).sort().at(-1)!,rows:values};
  });
  return {clusters,removed};
}
/** One chronological boundary, including actual resolution availability, not an extra horizon. */
export function purgeFold<T extends TemporalRow>(training:T[],test:TemporalRow[],priorTests:TemporalRow[]=[]){
  const valid=test.map(labelInterval).filter((x):x is NonNullable<typeof x>=>!!x);
  const testStart=test.map(r=>r.asOf).sort()[0]??'',testEnd=test.map(r=>r.labelEnd).sort().at(-1)??'';
  const embargoEnd=priorTests.map(r=>r.labelEnd).sort().at(-1),embargoStart=priorTests.map(r=>r.asOf.slice(0,10)).sort().at(-1);
  const kept:T[]=[],removed:Removal[]=[];
  for(const row of training){const interval=labelInterval(row);let reason:Removal['reason']|null=null;
    if(!interval)reason='INVALID_INTERVAL';
    else if(valid.some(x=>interval.start<=x.end&&interval.end>=x.start))reason='LABEL_OVERLAP';
    else if(!testStart||row.asOf>=testStart||(row.resolvedAt?(!Number.isFinite(Date.parse(row.resolvedAt))||row.resolvedAt>testStart):row.labelEnd>=testStart.slice(0,10)))reason='LABEL_NOT_AVAILABLE';
    else if(embargoStart&&embargoEnd&&row.asOf.slice(0,10)>embargoStart&&row.asOf.slice(0,10)<=embargoEnd)reason='FOLD_EMBARGO';
    if(reason)removed.push({asOf:row.asOf,entity:row.pair??'',entryDate:row.entryDate??null,labelEnd:row.labelEnd,reason,testStart,testEnd,...(embargoEnd?{embargoEnd}:{})});else kept.push(row);
  }
  return {kept,removed,testStart,testEnd,embargoEnd:embargoEnd??null};
}
function logGamma(z:number):number{
  const c=[676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-.13857109526572012,9.984369578019572e-6,1.5056327351493116e-7];
  if(z<.5)return Math.log(Math.PI)-Math.log(Math.sin(Math.PI*z))-logGamma(1-z);
  z--;let x=.9999999999998099;for(let i=0;i<c.length;i++)x+=c[i]/(z+i+1);const t=z+c.length-.5;return .5*Math.log(2*Math.PI)+(z+.5)*Math.log(t)-t+Math.log(x);
}
function betaFraction(a:number,b:number,x:number){
  const tiny=1e-300;let c=1,d=1-(a+b)*x/(a+1);if(Math.abs(d)<tiny)d=tiny;d=1/d;let h=d;
  for(let m=1;m<=250;m++){const m2=2*m;let aa=m*(b-m)*x/((a+m2-1)*(a+m2));d=1+aa*d;if(Math.abs(d)<tiny)d=tiny;c=1+aa/c;if(Math.abs(c)<tiny)c=tiny;d=1/d;h*=d*c;
    aa=-(a+m)*(a+b+m)*x/((a+m2)*(a+m2+1));d=1+aa*d;if(Math.abs(d)<tiny)d=tiny;c=1+aa/c;if(Math.abs(c)<tiny)c=tiny;d=1/d;const delta=d*c;h*=delta;if(Math.abs(delta-1)<3e-14)break;
  }return h;
}
export function studentUpperTail(t:number,df:number){
  if(!Number.isFinite(t)||!(df>0))return 1;if(t===0)return .5;
  const x=df/(df+t*t),a=df/2,b=.5;
  const bt=Math.exp(logGamma(a+b)-logGamma(a)-logGamma(b)+a*Math.log(x)+b*Math.log1p(-x));
  const ib=x<(a+1)/(a+b+2)?bt*betaFraction(a,b,x)/a:1-bt*betaFraction(b,a,1-x)/b;
  return Math.max(0,Math.min(1,t>0?ib/2:1-ib/2));
}
export type Dependence={version:string;rawObservations:number;uniqueForecastDates:number;uniqueLabelIntervals:number;overlappingLabelRatio:number;effectiveSampleSize:number;bandwidth:number;sensitivityBandwidth:number;variance:number|null;longRunVariance:number|null;standardError:number|null;statistic:number|null;pValue:number;removed:number;entryDatesUnknown:number;method:string};
/** Minimum bandwidth spans the real overlapping intervals; a doubled-bandwidth sensitivity may only increase uncertainty. */
export function dependence<T extends TemporalRow>(rows:T[],effect:(row:T)=>number):Dependence{
  const {clusters,removed}=dateClusters(rows),n=clusters.length;
  const effects=clusters.map(c=>average(c.rows.map(effect))),mu=average(effects),centered=effects.map(x=>x-mu);
  const variance=average(centered.map(x=>x*x));let overlap=0,span=0;
  for(let i=0;i<n;i++){let last=i;for(let j=i+1;j<n&&clusters[j].start<=clusters[i].end;j++){last=j;overlap++;}span=Math.max(span,last-i);}
  const bandwidth=Math.min(Math.max(0,n-1),Math.max(span,Math.ceil(4*(n/100)**(2/9)))),sensitivityBandwidth=Math.min(n-1,2*bandwidth);
  const lrv=(lag:number)=>{let v=variance;for(let k=1;k<=lag;k++){let cov=0;for(let i=k;i<n;i++)cov+=centered[i]*centered[i-k];v+=2*(1-k/(lag+1))*cov/Math.max(1,n);}return v;};
  const uniqueLabelIntervals=new Set(clusters.map(c=>c.start+':'+c.end)).size;
  const valid=n>=3&&effects.every(Number.isFinite)&&variance>1e-16;
  // Negative autocovariance cannot increase the declared information above observed dates/label intervals.
  const longRunVariance=valid?Math.max(variance,lrv(bandwidth),lrv(sensitivityBandwidth)):null;
  const effectiveSampleSize=longRunVariance?Math.max(0,Math.min(n,uniqueLabelIntervals,n*variance/longRunVariance)):0;
  const standardError=valid&&effectiveSampleSize>1?Math.sqrt(variance/effectiveSampleSize):null,statistic=standardError?mu/standardError:null;
  return {version:VALIDATION_VERSION,rawObservations:rows.length,uniqueForecastDates:n,uniqueLabelIntervals,overlappingLabelRatio:n>1?overlap/(n*(n-1)/2):0,effectiveSampleSize,bandwidth,sensitivityBandwidth,variance:valid?variance:null,longRunVariance,standardError,statistic,pValue:statistic===null?1:studentUpperTail(statistic,Math.max(1,effectiveSampleSize-1)),removed:removed.length,entryDatesUnknown:clusters.flatMap(c=>c.rows).filter(r=>!r.entryDate).length,method:'Date-cluster paired loss; Bartlett Newey-West, interval bandwidth + doubled-bandwidth conservative sensitivity; Student-t approximation. Zero variance fails closed.'};
}
/** Epochs fixed by dates only, never by scores. New holdout is never used to fit/select. */
export function historicalEpoch<T extends TemporalRow>(rows:T[],minimum=120){
  const {clusters}=dateClusters(rows);if(clusters.length<minimum)return null;
  const epoch=Math.floor((clusters.length-minimum)/10),count=minimum+10*epoch,selected=clusters.slice(0,count);
  const validationStart=Math.floor(count/3),holdoutStart=Math.floor(count*5/6);
  return {epoch,count,development:selected.slice(0,Math.floor(validationStart/2)).flatMap(c=>c.rows),training:selected.slice(Math.floor(validationStart/2),validationStart).flatMap(c=>c.rows),validation:selected.slice(validationStart,holdoutStart).flatMap(c=>c.rows),holdout:selected.slice(holdoutStart).flatMap(c=>c.rows),nextDateCount:count+10};
}
