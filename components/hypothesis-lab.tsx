"use client";
import { useEffect, useState } from "react";
import { strengthScore, type TerminalPayload } from "@/lib/terminal-data";
import { statuses, type Hypothesis, type Evaluation } from "@/lib/hypothesis/engine";
import type { researchStatus } from "@/worker/hypothesis-research";
type Lab = Awaited<ReturnType<typeof researchStatus>>;
const percent = (v:number|null|undefined) => typeof v === "number" && Number.isFinite(v) ? `${(v*100).toFixed(2)} %` : "—";
function Metrics({value}:{value?:Evaluation}) { return value ? <span>{value.blocks} Zeitblöcke · {value.samples} Paar-Outcomes · Accuracy {percent(value.accuracy)} · Brier {value.metrics?.brierScore.toFixed(4)??"—"} · Log Loss {value.metrics?.logLoss.toFixed(4)??"—"} · Δ Brier {value.improvement?.toFixed(4)??"—"} · adj. p {value.adjustedP.toPrecision(3)} · Stabilität {percent(value.stability)}</span> : <span>WAITING FOR DATA — keine abgeschlossene Auswertung</span>; }
export function HypothesisLab() {
  const [lab,setLab]=useState<Lab|null>(null),[payload,setPayload]=useState<TerminalPayload|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[filter,setFilter]=useState("ALL");
  async function load() {
    const [a,b]=await Promise.all([fetch("/api/hypotheses",{cache:"no-store"}),fetch("/api/terminal",{cache:"no-store"})]);
    if(!a.ok||!b.ok) throw new Error("Research-Status nicht verfügbar. Bitte Anmeldung und Verbindung prüfen.");
    setLab(await a.json());setPayload(await b.json());setError("");
  }
  useEffect(()=>{load().catch(e=>setError(e.message));},[]);
  async function run() {setBusy(true);try{const r=await fetch("/api/hypotheses/run",{method:"POST"});if(!r.ok)throw new Error("Research-Lauf fehlgeschlagen; Produktion bleibt unbeeinflusst.");await load();}catch(e){setError(e instanceof Error?e.message:"Research nicht verfügbar");}finally{setBusy(false);}}
  const quality=lab?.dataQuality as {snapshotCount:number;prospectiveCaptures:number;historicalCaptures:number;priceRows:number;limitations:string[];first:string|null;last:string|null}|null;
  const runInfo=lab?.lastRun as {at:string;status:string;result?:string;id:string;message?:string}|null;
  return <main className="quant-shell hypothesis-lab">
    <header className="quant-header"><div className="quant-brand"><span>FX</span><div><strong>HYPOTHESIS LAB</strong><small>ISOLATED RESEARCH · {lab?.protocol??"LOADING"}</small></div></div><a href="/">← Terminal</a></header>
    <section className="lab-intro"><span className="mono-label">RESEARCH ≠ EVIDENCE ≠ PRODUCTION</span><h1>Ideen prüfen. Core schützen.</h1><p>Aktueller Hypothesis-Produktionseinfluss: <strong>0 %</strong>. Research- und Shadow-Signale ändern keine Scores, Evidence oder Forecasts. Die Live-Integration ist gesperrt.</p>
      <button className="audit-button" onClick={run} disabled={busy}>{busy?"Research läuft …":"Research prüfen / einmal ausführen"}</button><p>Maximal ein erfolgreicher Research-Lauf pro UTC-Tag. Automatischer Anschluss nach erfolgreichem Daily Refresh; kein neuer Cron. Ein Scheduler-Lauf ist dadurch noch nicht nachgewiesen.</p>
      {error&&<p role="alert">{error}</p>}{!lab&&!error&&<p role="status">Lade gespeicherten Forschungsstand …</p>}
    </section>
    {lab&&<>
      <section className="lab-stats" aria-label="Forschungsstatus">{statuses.map(s=><div key={s}><span>{s.replaceAll("_"," ")}</span><strong>{lab.counts[s]??0}</strong></div>)}</section>
      <section className="lab-panel"><h2>Sicherheits- und Datenstatus</h2><p>Research: {lab.flags.enabled?"ENABLED":"DISABLED"} · Produktionsadapter: SEALED · angefordertes Gewicht: {percent(lab.flags.requestedWeight)} · effektives Gewicht: 0 % · späterer Gesamtdeckel: 5 %</p>
        <p>Letzter Research-Lauf: {runInfo?`${runInfo.at} · ${runInfo.status} · ${runInfo.result??runInfo.message??""} · ${runInfo.id}`:"NOT VERIFIED — noch kein gespeicherter Lauf"}</p>
        <p>Suchbudget: {lab.hypotheses.length}/{lab.searchBudget} Kandidaten inklusive aller Horizonte und verworfenen Varianten. Keine zufällige Parametersuche.</p>
        {quality&&<><p>{quality.historicalCaptures} historische Captures · {quality.prospectiveCaptures} tatsächlich neue Captures · {quality.priceRows} vorhandene Kurse. Abdeckung: {quality.first??"—"} bis {quality.last??"—"}.</p><ul>{quality.limitations.map(x=><li key={x}>{x}</li>)}</ul></>}
        <p>Historischer Gate: 120 nicht überlappende Zeitblöcke mit zusätzlichem Horizon-Embargo, drei Vorwärtsfenster und ein eingefrorener finaler Holdout. Danach mindestens 30 neue Shadow-Zeitblöcke. Das kann bei 60/90 Tagen viele Jahre erfordern; Kalenderzeit allein reicht nicht.</p>
      </section>
      <section className="lab-panel"><h2>Core / Beitrag / Final</h2><p>Unveränderter fundamentaler Currency Score auf der bestehenden 0–1-Skala, keine Umdeutung als ML-Wahrscheinlichkeit.</p><div className="lab-scroll"><table><thead><tr><th>Währung</th><th>Core</th><th>Hypothesis</th><th>Final</th></tr></thead><tbody>{payload?.currencies.map(c=><tr key={c.code}><th>{c.code}</th><td>{strengthScore(c).toFixed(6)}</td><td>0</td><td>{strengthScore(c).toFixed(6)}</td></tr>)}</tbody></table></div></section>
      <section className="lab-panel"><h2>Hypothesen</h2><label>Status <select value={filter} onChange={e=>setFilter(e.target.value)}><option value="ALL">Alle</option>{statuses.map(s=><option key={s}>{s}</option>)}</select></label>
      {lab.hypotheses.length===0&&<p>Noch keine Kandidaten gespeichert. Der erste erfolgreiche Research-Lauf legt den versionierten Katalog an.</p>}
      {lab.hypotheses.filter(h=>filter==="ALL"||h.status===filter).map((h:Hypothesis)=><details key={h.id} className="lab-hypothesis"><summary><strong>{h.name}</strong> · {h.horizon}D · {h.status} · Gewicht 0 %</summary><p>{h.id} · erstellt {h.createdAt}</p><p>{h.rationale}</p><code>{h.definition}</code><p>Inputs: {h.inputs.join(", ")} · Regime: {h.regime} · relative Vergleiche gegen USD</p><p>{h.expectedDirection}</p><p><strong>Entscheidung:</strong> {h.reason}</p><p>Letzte Prüfung: {h.lastEvaluation??"—"} · Point-in-Time: {h.pointInTimeVerified?"VERIFIED":"NOT VERIFIED"}</p>
        <h3>Historisch / final OOS</h3><Metrics value={h.historical?.final}/>{h.historical&&<p>Development {h.historical.development.join(" – ")} · Training-Reserve {h.historical.training.join(" – ")} · Validation {h.historical.validation.join(" – ")} · Final OOS {h.historical.outOfSample.join(" – ")}</p>}
        <h3>Walk-forward</h3>{h.historical?.folds.map((f,i)=><p key={i}>Fold {i+1}: <Metrics value={f}/></p>)??<p>WAITING FOR DATA</p>}
        <h3>Echte Live-Shadow-Evidenz</h3><p>Beginn: {h.shadowStartedAt??"Noch nicht qualifiziert"}</p><Metrics value={h.shadow}/><p>Historische Backtests werden niemals als vergangene Live-Shadow-Zeit ausgegeben.</p>
      </details>)}</section>
      <section className="lab-panel"><h2>Audit Trail</h2><p>Die letzten 50 Audit-Pakete; ältere Einträge bleiben gespeichert. Gewichte, Gründe und Datenversion werden zusammen mit dem Status gespeichert.</p>{lab.audit.length?<div className="lab-scroll"><pre>{JSON.stringify(lab.audit,null,2)}</pre></div>:<p>Noch keine Entscheidungen gespeichert.</p>}</section>
    </>}
  </main>;
}
