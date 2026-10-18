import type {CurvePoint} from './seasonality-engine';

export const CHART_INSET={left:88,right:24,top:36,bottom:44} as const;
type Bounds={left:number;top:number;width:number;height:number};

/** SVG uses preserveAspectRatio=none. Its own bounds include zoom and scroll offset. */
export function chartPointerIndex(clientX:number,clientY:number,bounds:Bounds,width:number,height:number,count:number,clamp=false):number|null{
  if(count<1||bounds.width<=0||bounds.height<=0||width<=CHART_INSET.left+CHART_INSET.right||height<=CHART_INSET.top+CHART_INSET.bottom)return null;
  const x=(clientX-bounds.left)/bounds.width*width,y=(clientY-bounds.top)/bounds.height*height;
  if(!Number.isFinite(x)||!Number.isFinite(y))return null;
  if(!clamp&&(x<CHART_INSET.left||x>width-CHART_INSET.right||y<CHART_INSET.top||y>height-CHART_INSET.bottom))return null;
  return Math.max(0,Math.min(count-1,Math.round((x-CHART_INSET.left)/(width-CHART_INSET.left-CHART_INSET.right)*(count-1))));
}

/** Adjacent days are a valid range; the displayed ordering also preserves year wraps. */
export function chartSelection(points:Pick<CurvePoint,'monthDay'>[],first:number,last:number):[string,string]|null{
  if(!Number.isInteger(first)||!Number.isInteger(last)||first===last||first<0||last<0||first>=points.length||last>=points.length)return null;
  return [points[Math.min(first,last)].monthDay,points[Math.max(first,last)].monthDay];
}

export function chartTicks(points:Pick<CurvePoint,'monthDay'>[],plotWidth:number):number[]{
  if(!points.length)return [];
  const count=Math.max(2,Math.floor(plotWidth/100));
  if(points.length>300){
    const months=points.flatMap((p,i)=>p.monthDay.endsWith('-01')?[i]:[]),stride=Math.max(1,Math.ceil(months.length/count));
    return [...new Set([0,...months.filter((_,i)=>i%stride===0).filter(i=>i<points.length-1-(points.length-1)/count*.6),points.length-1])];
  }
  return [...new Set(Array.from({length:Math.min(count+1,points.length)},(_,i)=>Math.round(i/Math.min(count,points.length-1||1)*(points.length-1))))];
}

export function chartPercent(index:number|null|undefined):string{
  if(index==null||!Number.isFinite(index))return '—';
  const change=Math.round((index-100)*1000)/1000;
  return `${change>0?'+':''}${change.toFixed(3)} %`;
}

export function fixingCaption(point:CurvePoint,year:number,monthEnd:boolean):string{
  const source=point.sourceDates[year];
  if(!source)return 'Kein Fixing';
  const targetDay=monthEnd&&point.monthDay==='02-29'?`02-${new Date(Date.UTC(Number(source.slice(0,4)),2,0)).getUTCDate()}`:point.monthDay;
  const label=source.slice(8,10)+'.'+source.slice(5,7)+'.'+source.slice(0,4);
  return label+(source.slice(5,10)!==targetDay?' · fortgeführt':'');
}
