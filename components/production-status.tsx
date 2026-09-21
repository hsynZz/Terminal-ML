"use client";
import { useEffect, useState } from 'react';
import type { productionHealth } from '@/worker/production';
type Health=Awaited<ReturnType<typeof productionHealth>>;
const pct=(n:number)=>`${(n*100).toFixed(2)} %`;
export function ProductionStatus(){
  const [data,setData]=useState<Health|null>(null),[error,setError]=useState(false);
  useEffect(()=>{let alive=true;const load=async()=>{try{const r=await fetch('/api/production',{cache:'no-store'});if(!r.ok)throw new Error();const body=await r.json();if(alive){setData(body);setError(false);}}catch{if(alive)setError(true);}};void load();const timer=setInterval(load,60000);return()=>{alive=false;clearInterval(timer);};},[]);
  return <section className="lab-panel production-status" aria-label="Evidence und Hintergrundbetrieb">
    <h2>Evidence & Hintergrundbetrieb</h2>
    {error?<p role="status">Status derzeit nicht erreichbar. Letzte Anzeige kann veraltet sein.</p>:!data?<p>Lade gespeicherten Betriebsstand …</p>:null}
    {data&&<>
      <p><strong>{data.status}</strong> · ML {pct(data.mlInfluence)} · Hypothesen {pct(data.hypothesisInfluence)} · gemeinsamer Deckel {pct(data.config.cap)}</p>
      <p>{data.snapshotCount} Snapshots · {data.trainingExamples} abgeschlossene ML-Beispiele · {data.resolvedOutcomes} Ergebnisse · {data.activeHypotheses}/{data.hypothesisCount} Hypothesen aktiv</p>
      <p>Letzter Snapshot: {data.lastSuccessfulSnapshot??'Noch keiner'} · Retraining: {data.lastRetrain??'WAITING FOR DATA'}</p>
      <details><summary>Core, Beiträge und Verlauf</summary>
        {data.evidenceHistory.length?data.evidenceHistory.slice(0,10).map((row:{asOf:string;attributions:Record<string,{coreEvidenceScore:number;mlContribution:number;hypothesisContribution:number;finalEvidenceScore:number;modelVersion:string|null;components:unknown[]}>})=><details key={row.asOf}><summary>{row.asOf}</summary><div className="lab-scroll"><table><thead><tr><th>Währung</th><th>Core</th><th>ML</th><th>Hypothesen</th><th>Final</th></tr></thead><tbody>{Object.entries(row.attributions).map(([c,a])=><tr key={c}><th>{c}</th><td>{a.coreEvidenceScore.toFixed(4)}</td><td>{a.mlContribution.toFixed(4)}</td><td>{a.hypothesisContribution.toFixed(4)}</td><td>{a.finalEvidenceScore.toFixed(4)}</td></tr>)}</tbody></table></div></details>):<p>Der nächste erfolgreiche Refresh beginnt die neue, nachvollziehbare Historie.</p>}
      </details>
      <details><summary>Hypothesen, Modelle und Datenqualität</summary>
        <p>Freigabe erfolgt automatisch nach zeitlich getrennter Prüfung und neuen Shadow-Ergebnissen. Unbelegte Signale tragen 0 bei. Score-Werte sind keine gemessenen Trefferquoten.</p>
        <p>Aktuelles Modell: {data.currentMlVersion} · Rollbacks: {data.rollbackCount}</p>
        <p>{data.observationVintages} unveränderliche Datenstände. Jahresdaten ändern sich erst bei einer Veröffentlichung oder Revision. Fortgeführte Faktoren bleiben als solche gekennzeichnet und qualifizieren keine neue adaptive Freigabe.</p>
        {data.coreInputQuality&&<details><summary>Herkunft der Core-Faktoren</summary><div className="lab-scroll"><table><thead><tr><th>Währung</th><th>Faktor</th><th>Status</th><th>Periode</th><th>Quelle</th></tr></thead><tbody>{Object.entries(data.coreInputQuality as Record<string,Record<string,{status:string;period:string|null;source:string}>>).flatMap(([currency,factors])=>Object.entries(factors).map(([factor,q])=><tr key={currency+factor}><td>{currency}</td><td>{factor}</td><td>{q.status}</td><td>{q.period??'nicht belegt'}</td><td>{q.source}</td></tr>))}</tbody></table></div></details>}
        {data.failedDataSources.map((s:{source:string;currency:string;cause:string;fallback:string},i:number)=><p key={`${s.source}-${i}`}>{s.source} / {s.currency}: {s.cause}. {s.fallback}</p>)}
        {data.registry.map(r=><details key={r.id}><summary>{r.feature} · {r.operator} · {r.horizon}D · {r.status}</summary><p>{r.reason}</p><p>Version {r.version} · Gewicht {pct(r.weight)} · geprüfte Zeitblöcke {r.gate?.blocks??0}</p><p>{r.id}</p></details>)}
      </details>
    </>}
  </section>;
}
