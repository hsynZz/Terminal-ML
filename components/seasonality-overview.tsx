'use client';

import {useState} from 'react';
import {EXCLUSION_LABELS,type SeasonalityAnalysis,type monthlySeasonality} from '@/lib/seasonality-engine';

export const MONTH_NAMES=['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
const percent=(n:number|null)=>n===null?'—':`${n>0?'+':''}${(n*100).toFixed(2)} %`;
const reasonLabel=(reason:string|null)=>EXCLUSION_LABELS[reason??'NO_HISTORY']??reason;
const tone=(n:number|null)=>n===null?'':n>0?'season-positive':n<0?'season-negative':'';
export const coverageLabel=(status:string)=>status==='COMPLETE'?'Vollständig':status==='PARTIAL'?'Teilweise':'Zu wenig Daten';

export function CoverageOverview({analysis,firstDate,lastDate,fixings,view}:{analysis:SeasonalityAnalysis;firstDate:string|null;lastDate:string|null;fixings:number;view:'year'|'window'}){
  const {coverage}=analysis;
  return <section className="season-coverage" aria-label="Datenqualität und Abdeckung">
    <div className="season-coverage-line">
      <div><span className="season-section-label">Datenbasis des Paars</span><strong>{firstDate?.slice(0,4)??'—'} – {lastDate?.slice(0,4)??'—'}</strong><small>{fixings.toLocaleString('de-DE')} gemeinsame Tageskurse</small></div>
      <div><span className="season-section-label">Gewähltes Fenster</span><strong>{coverage.valid} <em>/ {coverage.requested} Jahre</em></strong><small className={coverage.status==='COMPLETE'?'':'season-amber'}>{coverageLabel(coverage.status)} · keine Ersatzwerte</small></div>
      <div><span className="season-section-label">{view==='year'?'Ganzjahreskurve':'Fensterkurve'}</span><strong>{analysis.chartYears.length} <em>geprüfte Jahre</em></strong><small>{view==='year'?'Separate Prüfung des gesamten Jahres':'Dieselbe Stichprobe wie die Fensterstatistik'}</small></div>
      <div className="season-quality-note"><strong>Abdeckung ist keine Prognosegüte.</strong><p>Fehlende Kurse werden weder interpoliert noch als 0 % gezählt. Das aktuelle Jahr bleibt außerhalb der historischen Statistik.</p></div>
    </div>
    <details className="season-coverage-details">
      <summary>Jahre und Ausschlussgründe ansehen{coverage.excluded>0?` · ${coverage.excluded} Fenster fehlen`:''}</summary>
      <div className="season-year-coverage">{analysis.requestedYears.map(year=>{
        const excluded=analysis.excluded.find(x=>x.year===year),chart=analysis.chartExcluded.find(x=>x.year===year);
        return <div key={year} className={excluded?'missing':''}><strong>{year}</strong><span>{excluded?reasonLabel(excluded.reason):'Fenster geprüft'}</span>{chart&&<small>Kurve: {reasonLabel(chart.reason)}</small>}</div>;
      })}</div>
      <p>Ein gültiges Teilfenster bleibt auswertbar, auch wenn Daten außerhalb dieses Fensters fehlen. Die Ganzjahreskurve verlangt weiterhin mindestens 240 Fixings, geprüfte Jahresgrenzen und keine Lücke über sieben Tage.</p>
    </details>
  </section>;
}

export function MonthlyOverview({months,start,end,onSelect}:{months:ReturnType<typeof monthlySeasonality>;start:string;end:string;onSelect:(start:string,end:string)=>void}){
  const [metric,setMetric]=useState<'average'|'median'|'winRate'>('average');
  const [inspected,setInspected]=useState<{year:number;month:number}|null>(null);
  const inspectedCell=inspected?months.find(m=>m.month===inspected.month)?.cells.find(c=>c.year===inspected.year):null;
  const years=months[0]?.cells.map(c=>c.year).reverse()??[];
  const label=metric==='average'?'Durchschnitt':metric==='median'?'Median':'Positive Jahre';
  return <section className="season-month-panel" aria-label="Saisonaler Monatsvergleich">
    <div className="season-panel-heading"><div><h2>Die zwölf Monate im Vergleich</h2><p>Alle Monate derselben historischen Jahre. Monat auswählen, um das Fenster zu untersuchen.</p></div>
      <div className="season-view" role="group" aria-label="Kennzahl im Monatsvergleich">{(['average','median','winRate'] as const).map(m=><button key={m} aria-pressed={m===metric} onClick={()=>setMetric(m)}>{m==='average'?'Ø Rendite':m==='median'?'Median':'Positiv %'}</button>)}</div>
    </div>
    <div className="season-month-grid">{months.map(m=>{
      const value=m.stats[metric],selected=start===m.start&&end===m.end;
      return <button key={m.month} onClick={()=>onSelect(m.start,m.end)} aria-pressed={selected} className={m.coverage.status==='INSUFFICIENT'?'insufficient':''} aria-label={`${MONTH_NAMES[m.month-1]}: ${label} ${metric==='winRate'&&value!==null?(value*100).toFixed(1)+' %':percent(value)}; ${m.coverage.valid} von ${m.coverage.requested} Jahren`}>
        <span>{MONTH_NAMES[m.month-1]}</span><strong className={metric==='winRate'?'':tone(value)}>{metric==='winRate'&&value!==null?(value*100).toFixed(1)+' %':percent(value)}</strong>
        <small>{m.coverage.valid}/{m.coverage.requested} Jahre{m.coverage.status==='PARTIAL'?' · teilweise':m.coverage.status==='INSUFFICIENT'?' · zu wenig':''}</small>
        <i className="season-month-coverage"><b style={{width:`${m.coverage.ratio*100}%`}}/></i>
      </button>;
    })}</div>
    <p className="season-month-method">Innerhalb des Monats: erster bis letzter veröffentlichter Fixingkurs, ohne Übernacht-Rendite vom Vormonat. Februar enthält in Schaltjahren den 29. Februar. Keine Zinsen oder Handelskosten.</p>
    <details className="season-month-history"><summary>Monatsrenditen aller Jahre · Heatmap</summary><div className="season-table-scroll" tabIndex={0} role="region" aria-label="Scrollbare Monatsrenditen">
      <table className="season-heatmap"><caption>Exakte Stichprobe pro Monat; Strich = keine geprüften Daten. Zellen enthalten die Rendite in Prozent.</caption><thead><tr><th>Jahr</th>{MONTH_NAMES.map(m=><th key={m}>{m.slice(0,3)}</th>)}</tr></thead><tbody>{years.map(year=><tr key={year}><th>{year}</th>{months.map(m=>{
        const cell=m.cells.find(c=>c.year===year),r=cell?.result;
        return <td key={m.month} className={r?tone(r.return):'season-cell-missing'} style={r?{backgroundColor:`${r.return>=0?'rgba(113,181,157,':'rgba(212,136,132,'}${Math.min(.24,.035+Math.abs(r.return)*4)})`}:undefined}><button onClick={()=>setInspected({year,month:m.month})} aria-label={`${MONTH_NAMES[m.month-1]} ${year}: ${r?percent(r.return):reasonLabel(cell?.reason??null)}. Details anzeigen.`}>{r?`${r.return>0?'+':''}${(r.return*100).toFixed(2)}`:'—'}</button></td>;
      })}</tr>)}</tbody></table></div>{inspected&&inspectedCell&&<div className="season-cell-detail" role="status"><strong>{MONTH_NAMES[inspected.month-1]} {inspected.year}</strong>{inspectedCell.result?<p>{inspectedCell.result.startDate} bis {inspectedCell.result.endDate} · {inspectedCell.result.fixings} Fixings<br/>Kurs: {inspectedCell.result.startPrice.toPrecision(9)} bis {inspectedCell.result.endPrice.toPrecision(9)} · Rendite: {(inspectedCell.result.return*100).toFixed(6)} %</p>:<p>{reasonLabel(inspectedCell.reason)}. Kein Ersatzwert.</p>}</div>}<p>Farbstärke beschreibt die historische Bewegung, keine Sicherheit. Zelle anklicken für Kurse und tatsächliche Handelstage. Einzelwerte bleiben auch bei weniger als fünf Jahren sichtbar; aggregierte Monatskennzahlen erst ab fünf geprüften Fenstern.</p></details>
  </section>;
}

export function WindowDistribution({analysis}:{analysis:SeasonalityAnalysis}){
  const rows=[...analysis.years].sort((a,b)=>a.return-b.return),extent=Math.max(.0001,...rows.map(r=>Math.abs(r.return)));
  return <section className="season-distribution" aria-label="Streuung der historischen Fensterrenditen"><div className="season-panel-heading"><div><h2>Wie unterschiedlich waren die einzelnen Jahre?</h2><p>Jeder Balken ist ein tatsächlich geprüftes Jahresfenster. Grün positiv, rot negativ; Länge = Betrag der Rendite.</p></div><span className="season-sample-badge">n = {rows.length}</span></div>
    <div className="season-distribution-summary"><span>Mittlere 50 % der Ergebnisse</span><strong>{analysis.available?`${percent(analysis.stats.lowerQuartile)} bis ${percent(analysis.stats.upperQuartile)}`:'Mindestens fünf geprüfte Fenster erforderlich'}</strong><p>25.–75. Perzentil der historischen Renditen. Kein Konfidenzintervall und kein erwarteter Kursbereich.</p></div>
    <div className="season-return-bars">{rows.map(r=><div key={r.year} title={`${r.startDate} bis ${r.endDate}: ${(r.return*100).toFixed(6)} %`}><span>{r.year}</span><div className="season-return-track"><i className={r.return<0?'negative':''} style={{width:`${Math.abs(r.return)/extent*100}%`}}/></div><strong className={tone(r.return)}>{percent(r.return)}</strong></div>)}</div>
  </section>;
}
