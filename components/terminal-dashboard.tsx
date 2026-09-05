"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import {
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  currencies,
  factorMeta,
  type CurrencyCode,
  type FactorKey,
  type TerminalPayload,
} from "@/lib/terminal-data";
import {
  buildPairForecast,
  buildModelDistribution,
  type DistributionPoint,
} from "@/lib/model-engine";

const currencyColors: Record<CurrencyCode, string> = {
  USD: "#5f8cff",
  EUR: "#f3bd4d",
  GBP: "#c07cff",
  JPY: "#54d6c3",
  CHF: "#e56fb4",
  CAD: "#ff5f70",
  AUD: "#ff8a5f",
  NZD: "#8b83ff",
};

const factorKeys = Object.keys(factorMeta) as FactorKey[];

function modeLabel(mode: TerminalPayload["sourceMode"]) {
  if (mode === "live") return "LIVE INPUT";
  if (mode === "partial-live") return "PARTIAL LIVE";
  return "BASELINE INPUT";
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatAsOf(asOf: string) {
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Berlin",
  }).format(new Date(asOf));
}

function DistributionDot(props: unknown) {
  const { cx, cy, payload } = props as { cx?: number; cy?: number; payload?: DistributionPoint };
  if (cx === undefined || cy === undefined || !payload) return null;
  const color = currencyColors[payload.currency];
  return <circle cx={cx} cy={cy} r={4.2} fill={color} opacity={0.94} />;
}

function PointTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: DistributionPoint }> }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="point-tooltip">
      <div><i style={{ background: currencyColors[point.currency] }} />{point.currency}</div>
      <strong>{percent(point.probability)}</strong>
      <span>Dominanz · {Math.round(point.horizon)}T</span>
      <small>Modellzustand {point.sample + 1}</small>
    </div>
  );
}

export function TerminalDashboard({ initialPayload }: { initialPayload: TerminalPayload }) {
  const [payload, setPayload] = useState(initialPayload);
  const [selected, setSelected] = useState<CurrencyCode[]>([...currencies]);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [base, setBase] = useState<CurrencyCode>("EUR");
  const [quote, setQuote] = useState<CurrencyCode>("USD");
  const [draftModel, setDraftModel] = useState(payload.model);
  const [savingModel, setSavingModel] = useState(false);

  const distribution = useMemo(
    () => buildModelDistribution(payload, selected),
    [payload, selected],
  );
  const pairForecast = useMemo(
    () => buildPairForecast(payload, base, quote),
    [payload, base, quote],
  );

  const strongest = distribution.estimates[0];
  const weakest = distribution.estimates.at(-1);
  const edge = strongest && weakest ? strongest.probability - weakest.probability : 0;
  const pointGroups = useMemo(
    () => selected.map((currency) => ({
      currency,
      points: distribution.points.filter((point) => point.currency === currency),
    })),
    [distribution.points, selected],
  );

  useEffect(() => {
    let active = true;
    async function loadLatest() {
      try {
        const response = await fetch("/api/terminal");
        if (!response.ok) return;
        const latest = await response.json() as TerminalPayload;
        if (active) {
          setPayload(latest);
          setDraftModel(latest.model);
        }
        const now = new Date();
        const nowParts = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Berlin",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).formatToParts(now);
        const part = (type: string) => Number(nowParts.find((item) => item.type === type)?.value ?? 0);
        const nowDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(now);
        const latestDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(latest.asOf));
        const afterCutoff = part("hour") * 60 + part("minute") >= 17 * 60 + 15;
        if (active && afterCutoff && (latest.sourceMode === "baseline" || latestDay !== nowDay)) {
          const refreshed = await fetch("/api/refresh", { method: "POST" });
          if (refreshed.ok && active) {
            const next = await refreshed.json() as TerminalPayload;
            setPayload(next);
            setDraftModel(next.model);
          }
        }
      } catch {
        // Keep the last complete snapshot visible.
      }
    }
    void loadLatest();
    return () => { active = false; };
  }, []);

  function toggleCurrency(currency: CurrencyCode, checked: boolean) {
    setSelected((current) => {
      if (checked) return currencies.filter((item) => current.includes(item) || item === currency);
      if (current.length === 1) return current;
      return current.filter((item) => item !== currency);
    });
  }

  async function refresh() {
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const response = await fetch("/api/refresh", { method: "POST" });
      if (!response.ok) throw new Error("refresh failed");
      const next = await response.json() as TerminalPayload;
      setPayload(next);
      setDraftModel(next.model);
    } catch {
      setRefreshFailed(true);
    } finally {
      setRefreshing(false);
    }
  }

  function changeBase(next: CurrencyCode) {
    if (next === quote) setQuote(base);
    setBase(next);
  }

  function changeQuote(next: CurrencyCode) {
    if (next === base) setBase(quote);
    setQuote(next);
  }

  async function saveModelSettings() {
    setSavingModel(true);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftModel),
      });
      if (!response.ok) return;
      const model = await response.json() as TerminalPayload["model"];
      setPayload((current) => ({ ...current, model }));
      setDraftModel(model);
    } finally {
      setSavingModel(false);
    }
  }

  return (
    <main className="quant-shell">
      <header className="quant-header">
        <div className="quant-brand">
          <span>FX</span>
          <div><strong>DOMINANCE</strong><small>EVIDENCE ENGINE</small></div>
        </div>
        <div className="quant-status">
          <div><i className={payload.sourceMode === "live" ? "live" : "partial"} />{modeLabel(payload.sourceMode)}</div>
          <span>{formatAsOf(payload.asOf)}</span>
        </div>
      </header>

      <section className="quant-workspace">
        <div className="workspace-title">
          <div>
            <span className="mono-label">RELATIVE EVIDENCE · 10–90 TAGE</span>
            <h1>Currency dominance</h1>
          </div>
          <div className="model-actions">
            <Button variant="outline" size="icon" onClick={refresh} disabled={refreshing} className="quiet-button" aria-label="Daten aktualisieren">
              <RefreshCw className={refreshing ? "animate-spin" : ""} />
            </Button>
            <Sheet>
              <SheetTrigger asChild><Button variant="outline" className="audit-button"><SlidersHorizontal />Audit</Button></SheetTrigger>
              <SheetContent className="audit-sheet">
                <SheetHeader>
                  <SheetTitle>Model Audit</SheetTitle>
                  <SheetDescription>Datenabdeckung, Modelllogik und Grenzen der aktuellen Inferenz.</SheetDescription>
                </SheetHeader>
                <div className="audit-body">
                  <section className="audit-state">
                    <div><span>ENGINE</span><strong>Probabilistic ensemble</strong></div>
                    <div><span>VERSION</span><strong>{distribution.version}</strong></div>
                    <div><span>DATA COVERAGE</span><strong>{percent(distribution.coverage)}</strong></div>
                    <div><span>TRAINING</span><strong className="warning-text">{payload.model.trainingSamples ? `${payload.model.trainingSamples} Samples` : "Bootstrap"}</strong></div>
                    <div><span>REGIME</span><strong>{payload.regime.label.toUpperCase()} · {percent(payload.regime.riskOffProbability)} RISK-OFF</strong></div>
                    <div><span>VALIDATION</span><strong>{payload.model.validation ? `${payload.model.validation.folds} WALK-FORWARD FOLDS` : "WAITING FOR HISTORY"}</strong></div>
                  </section>
                  <section>
                    <h2>Was ein Punkt bedeutet</h2>
                    <p>Ein Punkt ist ein vollständiger Modellzustand. Für jeden Horizont werden alle Merkmalsgruppen gemeinsam neu gewichtet und als Ensemble ausgewertet. Ein Punkt ist kein Event, keine News-Meldung und kein einzelner Indikator.</p>
                  </section>
                  <section>
                    <h2>Hybrid-Gewichtung</h2>
                    <p className="weight-help">Modell und Trader-Bias werden vor jeder Prognose zu einem gemeinsamen Gewichtssatz normalisiert.</p>
                    <div className="blend-control">
                      <div><span>Modellanteil</span><strong>{Math.round(draftModel.modelBlend * 100)}%</strong></div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={Math.round(draftModel.modelBlend * 100)}
                        onChange={(event) => setDraftModel((current) => ({ ...current, modelBlend: Number(event.target.value) / 100 }))}
                        aria-label="Modellanteil"
                      />
                    </div>
                    <div className="audit-factors editable">
                      {factorKeys.map((factor) => (
                        <label key={factor}>
                          <span>{factorMeta[factor].label}</span>
                          <input
                            type="range"
                            min="0"
                            max="30"
                            value={Math.round(draftModel.expertWeights[factor] * 100)}
                            onChange={(event) => setDraftModel((current) => ({
                              ...current,
                              expertWeights: { ...current.expertWeights, [factor]: Number(event.target.value) / 100 },
                            }))}
                            aria-label={`${factorMeta[factor].label} Trader-Gewicht`}
                          />
                          <strong>{Math.round(draftModel.expertWeights[factor] * 100)}%</strong>
                        </label>
                      ))}
                    </div>
                    <Button className="save-model" onClick={saveModelSettings} disabled={savingModel}><Save />{savingModel ? "Speichert" : "Gewichte speichern"}</Button>
                  </section>
                  <section>
                    <h2>Datenquellen</h2>
                    <div className="audit-sources">
                      {payload.sources.map((source) => <div key={source.name}><i className={source.status} /><span><strong>{source.name}</strong><small>{source.detail}</small></span><em>{source.status === "connected" ? "CONNECTED" : source.status === "ready" ? "READY" : "OPEN"}</em></div>)}
                    </div>
                  </section>
                  <section className="integrity-note">
                    <strong>Integrity status</strong>
                    <p>Die Verteilung ist reproduzierbar: Gleicher Snapshot und gleiche Auswahl erzeugen identische Punkte. Fehlende Live-Inputs erhöhen die Streuung. Eine vollständig kalibrierte Handelswahrscheinlichkeit setzt historische Preis-Labels sowie vollständige Zins-, Rendite-, COT- und Kalenderfeeds voraus.</p>
                  </section>
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>

        <div className="pair-toolbar" aria-label="Paarprognose">
          <div className="pair-selector">
            <span>PAIR</span>
            <select value={base} onChange={(event) => changeBase(event.target.value as CurrencyCode)} aria-label="Basiswährung">
              {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
            </select>
            <b>/</b>
            <select value={quote} onChange={(event) => changeQuote(event.target.value as CurrencyCode)} aria-label="Gegenwährung">
              {currencies.map((currency) => <option key={currency} value={currency}>{currency}</option>)}
            </select>
            <button type="button" onClick={() => { setBase(quote); setQuote(base); }} aria-label="Basis- und Gegenwährung tauschen"><ArrowLeftRight /></button>
          </div>
          <div className="pair-horizons">
            {pairForecast.map((forecast) => (
              <div key={forecast.horizon}>
                <span>{forecast.horizon}T</span>
                <strong className={forecast.signal === "neutral" ? "" : forecast.signal === "up" ? "positive" : "negative"}>{percent(forecast.probability)}</strong>
                <small title={`Konfidenz aus Signalstreuung und ${forecast.sampleCount} Trainingsbeispielen`}>
                  {forecast.signal === "neutral" ? "NEUTRAL" : forecast.signal === "up" ? "LONG" : "SHORT"} · CONF {percent(forecast.confidence)}
                </small>
              </div>
            ))}
          </div>
        </div>

        <div className="currency-filter" role="group" aria-label="Währungen in der Verteilung">
          <span className="filter-label">UNIVERSE</span>
          {currencies.map((currency) => {
            const checked = selected.includes(currency);
            return (
              <label key={currency} className={`currency-toggle ${checked ? "selected" : ""}`} style={{ "--currency": currencyColors[currency] } as React.CSSProperties}>
                <Checkbox
                  checked={checked}
                  onCheckedChange={(value) => toggleCurrency(currency, value === true)}
                  className="currency-checkbox"
                  aria-label={`${currency} ${checked ? "ausblenden" : "einblenden"}`}
                />
                <i />
                <span>{currency}</span>
              </label>
            );
          })}
          <button className="filter-reset" onClick={() => setSelected([...currencies])}>ALLE</button>
        </div>

        {refreshFailed ? <div className="data-warning">Aktualisierung nicht verfügbar · letzter vollständiger Snapshot bleibt aktiv</div> : null}

        <div className="model-grid">
          <section className="distribution-panel">
            <div className="distribution-chart">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 18, right: 24, bottom: 14, left: 2 }}>
                  <ReferenceArea y1={0.5} y2={1} fill="#154d41" fillOpacity={0.54} />
                  <ReferenceArea y1={0} y2={0.5} fill="#51343a" fillOpacity={0.48} />
                  <ReferenceLine y={0.5} stroke="#e4e8e9" strokeOpacity={0.48} strokeDasharray="5 5" strokeWidth={1} />
                  <XAxis
                    type="number"
                    dataKey="horizon"
                    domain={[8, 92]}
                    ticks={[10, 30, 60, 90]}
                    tickFormatter={(value) => `${value}d`}
                    stroke="#7e858d"
                    tickLine={false}
                    axisLine={{ stroke: "#777f8748" }}
                    tickMargin={12}
                  />
                  <YAxis
                    type="number"
                    dataKey="probability"
                    domain={[0, 1]}
                    ticks={[0, 0.5, 1]}
                    tickFormatter={(value) => value.toFixed(1)}
                    stroke="#7e858d"
                    tickLine={false}
                    axisLine={{ stroke: "#777f8748" }}
                    width={48}
                  />
                  <ZAxis range={[34, 34]} />
                  <RechartsTooltip content={<PointTooltip />} cursor={false} />
                  {pointGroups.map((group) => (
                    <Scatter
                      key={group.currency}
                      name={group.currency}
                      data={group.points}
                      shape={<DistributionDot />}
                      isAnimationActive={false}
                    />
                  ))}
                </ScatterChart>
              </ResponsiveContainer>
              <span className="axis-title">P(↑)</span>
            </div>
            <footer className="result-strip">
              {strongest && weakest && selected.length > 1 ? (
                <div className="result-leading">
                  <span>LEAD</span>
                  <strong style={{ color: currencyColors[strongest.currency] }}>{strongest.currency}</strong>
                  <b>über</b>
                  <strong style={{ color: currencyColors[weakest.currency] }}>{weakest.currency}</strong>
                  <em>+{percent(edge)}</em>
                </div>
              ) : null}
              <span className="state-note">{distribution.pointCount} Modellzustände · jeder Punkt bündelt alle Evidenzfaktoren, kein Event</span>
            </footer>
          </section>
        </div>
      </section>
    </main>
  );
}
