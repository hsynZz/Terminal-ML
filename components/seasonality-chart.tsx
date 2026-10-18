'use client';

import {useEffect,useId,useMemo,useRef,useState,type PointerEvent} from 'react';
import {CHART_INSET,chartPercent,chartPointerIndex,chartSelection,chartTicks,fixingCaption} from '@/lib/seasonality-chart';
import type {CurvePoint,SeasonalityAnalysis} from '@/lib/seasonality-engine';

const MONTHS=['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
const yearColors=['#af8be2','#8bafbd','#cc9c82','#83b28f','#c699b2','#a4a97e'];
const dayLabel=(md:string)=>`${Number(md.slice(3))}. ${MONTHS[Number(md.slice(0,2))-1]}`;
type Visibility={average:boolean;median:boolean;currentYear:boolean;band:boolean};
type Gesture={index:number;clientX:number;clientY:number;pointerId:number;select:boolean};

export function SeasonalChart({analysis,visible,selectedYears,highlight,view,onWindow,onFocusWindow}:{
  analysis:SeasonalityAnalysis;visible:Visibility;selectedYears:number[];highlight:number|null;
  view:'year'|'window';onWindow:(start:string,end:string)=>void;onFocusWindow:()=>void;
}){
  const svg=useRef<SVGSVGElement>(null),scroller=useRef<HTMLDivElement>(null),gesture=useRef<Gesture|null>(null);
  const [cursorDay,setCursorDay]=useState(analysis.start),[pinned,setPinned]=useState(false);
  const [drag,setDrag]=useState<[number,number]|null>(null),[selectMode,setSelectMode]=useState(false);
  const [zoom,setZoom]=useState(1),[viewportWidth,setViewportWidth]=useState(1040),controlId=useId();
  const {left,right,top,bottom}=CHART_INSET,width=viewportWidth*zoom,height=460,points=analysis.curve;
  const cursor=Math.max(0,points.findIndex(p=>p.monthDay===cursorDay)),current=points[cursor];
  const label=(md:string)=>md==='02-29'&&analysis.monthEnd?'Februar · Monatsende':dayLabel(md);
  const mainLines=[
    {key:'median',label:'Median',enabled:visible.median,color:'var(--season-median)',weight:1,get:(p:CurvePoint)=>p.median},
    {key:'average',label:'Durchschnitt',enabled:visible.average,color:'var(--season-gold)',weight:1.25,get:(p:CurvePoint)=>p.average},
    {key:'currentYear',label:String(analysis.currentYear),enabled:visible.currentYear,color:'var(--season-blue)',weight:1.1,get:(p:CurvePoint)=>p.current}
  ].filter(line=>line.enabled);
  const graph=useMemo(()=>{
    const values=points.flatMap(p=>[
      ...(visible.average&&p.average!==null?[p.average]:[]),...(visible.median&&p.median!==null?[p.median]:[]),
      ...(visible.currentYear&&p.current!==null?[p.current]:[]),
      ...(visible.band&&p.lowerQuartile!==null&&p.upperQuartile!==null?[p.lowerQuartile,p.upperQuartile]:[]),
      ...selectedYears.flatMap(y=>p.years[y]!==undefined?[p.years[y]]:[])
    ]);
    const minimum=Math.min(100,...values),maximum=Math.max(100,...values),pad=Math.max(.05,(maximum-minimum)*.1),low=minimum-pad,high=maximum+pad;
    const x=(i:number)=>left+i/Math.max(1,points.length-1)*(width-left-right),y=(v:number)=>top+(high-v)/(high-low)*(height-top-bottom);
    const path=(get:(p:CurvePoint)=>number|null|undefined)=>{
      let active=false;
      return points.map((p,i)=>{const v=get(p);if(v==null){active=false;return '';}
        const command=active?'L':'M';active=true;return `${command}${x(i).toFixed(3)},${y(v).toFixed(3)}`;
      }).join(' ');
    };
    const segments:number[][]=[];let segment:number[]=[];
    points.forEach((p,i)=>{if(p.lowerQuartile!==null&&p.upperQuartile!==null)segment.push(i);else if(segment.length){segments.push(segment);segment=[];}});
    if(segment.length)segments.push(segment);
    const band=segments.map(s=>s.map((i,j)=>`${j?'L':'M'}${x(i)},${y(points[i].upperQuartile!)}`).join(' ')+[...s].reverse().map(i=>` L${x(i)},${y(points[i].lowerQuartile!)}`).join('')+' Z').join(' ');
    return {x,y,low,high,path,band};
  },[points,visible,selectedYears,width,left,right,top,bottom]);

  // Use the actual viewport instead of squeezing a fixed-width SVG on a phone.
  useEffect(()=>{
    const el=scroller.current;if(!el)return;
    const measure=()=>{if(el.clientWidth>0)setViewportWidth(el.clientWidth);};
    const observer=new ResizeObserver(measure);observer.observe(el);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    const el=scroller.current;if(!el)return;
    const x=graph.x(cursor),margin=32;
    if(x<el.scrollLeft+margin)el.scrollLeft=Math.max(0,x-margin);
    else if(x>el.scrollLeft+el.clientWidth-margin)el.scrollLeft=x-el.clientWidth+margin;
  },[cursor,graph,zoom]);

  const locate=(e:PointerEvent<SVGSVGElement>,clamp=false)=>svg.current?chartPointerIndex(e.clientX,e.clientY,svg.current.getBoundingClientRect(),width,height,points.length,clamp):null;
  const choose=(i:number)=>{const point=points[Math.max(0,Math.min(points.length-1,i))];if(point){setCursorDay(point.monthDay);setPinned(true);}};
  const cancelGesture=()=>{gesture.current=null;setDrag(null);};
  const pointerDown=(e:PointerEvent<SVGSVGElement>)=>{
    if(!e.isPrimary||e.button!==0||gesture.current)return;
    const i=locate(e);if(i===null)return;
    const select=e.pointerType!=='touch'||selectMode;
    gesture.current={index:i,clientX:e.clientX,clientY:e.clientY,pointerId:e.pointerId,select};
    setCursorDay(points[i].monthDay);
    if(select){setDrag([i,i]);e.currentTarget.setPointerCapture(e.pointerId);}
  };
  const pointerMove=(e:PointerEvent<SVGSVGElement>)=>{
    const action=gesture.current;
    if(action&&action.pointerId!==e.pointerId)return;
    const i=locate(e,!!action?.select);if(i===null)return;
    if(action?.select){setCursorDay(points[i].monthDay);setDrag([action.index,i]);}
    else if(!action&&e.pointerType!=='touch'&&!pinned)setCursorDay(points[i].monthDay);
  };
  const pointerUp=(e:PointerEvent<SVGSVGElement>)=>{
    const action=gesture.current;if(!action||action.pointerId!==e.pointerId)return;
    const i=locate(e,action.select);
    if(i!==null){
      const moved=Math.hypot(e.clientX-action.clientX,e.clientY-action.clientY);
      if(action.select){
        const range=chartSelection(points,action.index,i);
        if(range){onWindow(...range);setSelectMode(false);}
        choose(i);
      }else if(moved<8)choose(i);
    }
    cancelGesture();if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const tickIndices=chartTicks(points,width-left-right);
  const selectedRanges=useMemo(()=>{
    const ranges:[number,number][]=[];let begin=-1;
    points.forEach((p,i)=>{const yes=analysis.end>=analysis.start?p.monthDay>=analysis.start&&p.monthDay<=analysis.end:p.monthDay>=analysis.start||p.monthDay<=analysis.end;
      if(yes&&begin<0)begin=i;
      if(begin>=0&&(!yes||i===points.length-1)){ranges.push([begin,yes?i:i-1]);begin=-1;}
    });return ranges;
  },[points,analysis.start,analysis.end]);
  const activeHighlight=highlight!==null&&selectedYears.includes(highlight)?highlight:null;
  const reading=current?[
    ...mainLines.map(line=>({key:line.key,label:line.label,color:line.color,value:line.get(current),source:line.key==='currentYear'?fixingCaption(current,analysis.currentYear,analysis.monthEnd):`${current.sample} historische Jahre`})),
    ...selectedYears.map((year,i)=>({key:String(year),label:String(year),color:yearColors[i%yearColors.length],value:current.years[year]??null,source:fixingCaption(current,year,analysis.monthEnd)}))
  ]:[];
  return <div className="season-chart-workspace">
    <div className="season-chart-tools">
      <div role="group" aria-label="Zeitachse vergrößern"><span>Detailansicht</span>{[1,2,4].map(level=><button key={level} aria-pressed={zoom===level} onClick={()=>setZoom(level)}>{level}×</button>)}</div>
      <div><button aria-pressed={selectMode} onClick={()=>{cancelGesture();setSelectMode(v=>!v);}}>Fenster ziehen</button><button disabled={view==='window'} onClick={onFocusWindow}>Auswahl im Detail</button></div>
      <p>{selectMode?'Start berühren und bis zum Ende ziehen.':zoom>1?'Horizontal scrollen · Datum antippen oder mit Pfeilen wählen.':'Kalendertage ohne Glättung · Klick oder Tippen fixiert den Cursor.'}</p>
    </div>
    <div className="season-chart" ref={scroller}>
      <svg ref={svg} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" shapeRendering="geometricPrecision"
        style={{width:`${zoom*100}%`,minWidth:0,touchAction:selectMode?'none':'pan-x pan-y pinch-zoom'}} role="group"
        aria-label="Saisonaler Indexchart. Pfeiltasten: ein Tag. Umschalt und Pfeiltasten: sieben Tage. Pos1 und Ende: erster und letzter Tag. Escape löst den Cursor."
        tabIndex={0} onKeyDown={e=>{
          const step=e.shiftKey?7:1;
          if(['ArrowRight','ArrowLeft','Home','End'].includes(e.key)){e.preventDefault();choose(e.key==='Home'?0:e.key==='End'?points.length-1:cursor+(e.key==='ArrowRight'?step:-step));}
          if(e.key==='Escape'){cancelGesture();setSelectMode(false);setPinned(false);}
        }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
        onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}>
        <title>Saisonale FX-Verläufe, Index 100</title>
        <desc>Historischer Durchschnitt und Median abgeschlossener Jahre. Aktuelles Jahr separat. Exakte Werte und Quellen-Fixings im Wertefeld unter dem Chart.</desc>
        {selectedRanges.map(([a,b],i)=><rect key={i} x={graph.x(a)} y={top} width={Math.max(1,graph.x(b)-graph.x(a))} height={height-top-bottom} fill="var(--season-gold)" opacity=".06"/>)}
        {Array.from({length:5},(_,i)=>{
          const value=graph.low+(graph.high-graph.low)*i/4,y=graph.y(value),decimals=graph.high-graph.low<.2?3:graph.high-graph.low<2?2:1;
          return <g key={i}><line x1={left} y1={y} x2={width-right} y2={y} stroke="var(--border)" opacity=".6" vectorEffect="non-scaling-stroke"/><text x={left-12} y={y+4} textAnchor="end" className="season-axis">{`${value>=100?'+':''}${(value-100).toFixed(decimals)} %`}</text></g>;
        })}
        <line x1={left} y1={graph.y(100)} x2={width-right} y2={graph.y(100)} stroke="var(--season-muted)" strokeDasharray="4 6" opacity=".65" vectorEffect="non-scaling-stroke"/>
        {tickIndices.map(i=><text key={i} x={graph.x(i)} y={height-13} textAnchor={i===points.length-1?'end':i===0?'start':'middle'} className="season-axis">{points.length>300&&i<points.length-1?MONTHS[Number(points[i].monthDay.slice(0,2))-1]:points[i].monthDay==='02-29'&&analysis.monthEnd?'Monatsende':dayLabel(points[i].monthDay)}</text>)}
        <text x={left} y={15} className="season-axis season-axis-heading">RENDITE SEIT ERSTEM FIXING</text>
        {visible.band&&<path d={graph.band} fill="var(--season-gold)" opacity=".055"/>}
        {selectedYears.map((year,i)=><path key={year} data-year={year} d={graph.path(p=>p.years[year])} fill="none" stroke={yearColors[i%yearColors.length]} strokeWidth={activeHighlight===year?1.25:.9} vectorEffect="non-scaling-stroke" strokeLinejoin="miter" strokeMiterlimit="3" strokeLinecap="butt" opacity={activeHighlight===null?.75:activeHighlight===year?1:.3} className="season-path"/>)}
        {mainLines.map(line=><path key={line.key} data-series={line.key} d={graph.path(line.get)} fill="none" stroke={line.color} strokeWidth={line.weight} vectorEffect="non-scaling-stroke" strokeLinejoin="miter" strokeMiterlimit="3" strokeLinecap="butt" className="season-path"/>)}
        {zoom>1&&mainLines.length===1&&points.map((p,i)=>{const line=mainLines[0],v=line.get(p);return v===null?null:<circle key={p.monthDay} cx={graph.x(i)} cy={graph.y(v)} r=".8" fill={line.color}/>;})}
        {drag&&<rect x={graph.x(Math.min(...drag))} y={top} width={Math.abs(graph.x(drag[1])-graph.x(drag[0]))} height={height-top-bottom} fill="var(--season-gold)" opacity=".16"/>}
        {current&&<g><line x1={graph.x(cursor)} x2={graph.x(cursor)} y1={top} y2={height-bottom} stroke="var(--season-muted)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke"/>{reading.map(row=>row.value===null?null:<circle key={row.key} cx={graph.x(cursor)} cy={graph.y(row.value)} r="2.5" fill={row.color} stroke="var(--card)" strokeWidth=".75" vectorEffect="non-scaling-stroke"/>)}</g>}
      </svg>
    </div>
    <div className="season-cursor-controls season-chart-tools">
      <div role="group" aria-label="Kalendertag exakt wählen">
        <button aria-label="Einen Kalendertag zurück" disabled={cursor===0} onClick={()=>choose(cursor-1)}>←</button>
        <label htmlFor={controlId} className="sr-only">Cursor-Datum</label><select id={controlId} value={current?.monthDay??''} onChange={e=>choose(points.findIndex(p=>p.monthDay===e.target.value))}>{points.map(p=><option key={p.monthDay} value={p.monthDay}>{label(p.monthDay)}</option>)}</select>
        <button aria-label="Einen Kalendertag vor" disabled={cursor===points.length-1} onClick={()=>choose(cursor+1)}>→</button>
        <button aria-pressed={pinned} onClick={()=>setPinned(v=>!v)}>{pinned?'Cursor lösen':'Fixieren'}</button>
      </div>
      <div role="group" aria-label="Fenstergrenzen am Cursor setzen">
        <button disabled={!current} onClick={()=>{setPinned(true);onWindow(current.monthDay,analysis.end);}}>Als Start</button>
        <button disabled={!current} onClick={()=>{setPinned(true);onWindow(analysis.start,current.monthDay);}}>Als Ende</button>
      </div>
    </div>
    {current&&<section className="season-chart-readout" aria-label={`Exakte Chartwerte am ${label(current.monthDay)}`}>
      <div className="season-readout-heading"><strong>{label(current.monthDay)}</strong><span>{view==='year'?'Bezug: erstes Fixing des Jahres':'Bezug: erstes Fixing der Auswahl'}</span><span>{current.sample} historische Jahre an diesem Tag</span></div>
      <div className="season-readout-values">{reading.map(row=><div key={row.key} className="season-readout-value"><span><i style={{background:row.color}}/>{row.label}</span><strong>{chartPercent(row.value)}</strong><small>Index {row.value===null?'—':row.value.toFixed(3)}</small><small>{row.source}</small></div>)}</div>
      {visible.band&&<p>Mittlere 50 %: {chartPercent(current.lowerQuartile)} bis {chartPercent(current.upperQuartile)}</p>}
      {!reading.length&&!visible.band&&<p>Eine Kurve über die Legende oder die Jahrestabelle einblenden.</p>}
      {view==='year'&&<p>Die markierte Auswahl wird separat berechnet. „Auswahl im Detail“ setzt ihren ersten tatsächlichen Kurs auf 0 %.</p>}
      <p className="season-readout-note">Drei Nachkommastellen zur Ablesung. Fixings behalten die Genauigkeit der Quelle; fortgeführte Tage enthalten keinen neuen Kurs.</p>
    </section>}
  </div>;
}
