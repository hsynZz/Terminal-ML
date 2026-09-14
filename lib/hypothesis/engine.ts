/** Isolated, finite research protocol. Nothing in this module writes core state. */
import { calibrationMetrics, resolveOutcomes, type AuditClose } from "../calibration";
import { currencies, forecastHorizons, type FactorKey, type ForecastHorizon, type TerminalPayload } from "../terminal-data";
import { PROVENANCE_VERSION, signalProvenance, type ProvenancePayload, type Provenance } from "./provenance";

export const PROTOCOL = "hypothesis-v1";
export const SEARCH_BUDGET = 32; // Eight predeclared ideas, four horizons. No optimizer.
export const MAX_CONTRIBUTION = 0.05;
// Only the audited USD-pair probability target has an adapter. Runtime budget defaults to zero.
export const LIVE_INTEGRATION_APPROVED = true;
export const statuses = ["CANDIDATE", "TESTING", "INSUFFICIENT_DATA", "REJECTED", "SHADOW", "VALIDATED", "PRODUCTION", "DEGRADED", "INACTIVE"] as const;
export type Status = typeof statuses[number];
export type Kind = "yield-divergence" | "policy-change" | "growth-acceleration" | "cot-nonreaction" | "risk-momentum" | "commodity-interaction" | "persistent-policy" | "lagged-yields";
type Template = { kind: Kind; name: string; definition: string; rationale: string; inputs: FactorKey[]; lag: number; regime: string };
export const templates: Template[] = [
  { kind: "yield-divergence", name: "Rendite / FX-Divergenz", definition: "s = clip(relative(yields) - relative(momentum), -1, 1)", rationale: "Relative Renditestärke ohne gleichgerichtetes Momentum könnte verzögert eingepreist werden.", inputs: ["yields", "momentum"], lag: 0, regime: "all" },
  { kind: "policy-change", name: "Relative geldpolitische Veränderung", definition: "s = clip(relative(policy,t) - relative(policy,t-30 calendar days), -1, 1)", rationale: "Eine Veränderung kann informativer sein als ein bereits eingepreistes Niveau.", inputs: ["policy"], lag: 30, regime: "all" },
  { kind: "growth-acceleration", name: "Wachstumsbeschleunigung", definition: "s = clip(relative(growth,t) - 2*relative(growth,t-30) + relative(growth,t-60), -1, 1)", rationale: "Beschleunigung relativer Wachstumssignale könnte Erwartungen verändern.", inputs: ["growth"], lag: 60, regime: "all" },
  { kind: "cot-nonreaction", name: "Positionierung ohne Preisbestätigung", definition: "s = abs(relative(cot)) >= 0.4 && abs(relative(momentum)) <= 0.1 ? -relative(cot) : 0", rationale: "Extreme Positionierung ohne Preisbestätigung könnte anfällig für Auflösung sein. Keine Behauptung über Roh-COT-Perzentile.", inputs: ["cot", "momentum"], lag: 0, regime: "all" },
  { kind: "risk-momentum", name: "Momentum in Risk-Off", definition: "s = regime == risk-off ? relative(momentum) : 0", rationale: "Trendfortsetzung könnte in Risikoabbauphasen anders funktionieren.", inputs: ["momentum", "risk"], lag: 0, regime: "risk-off" },
  { kind: "commodity-interaction", name: "Rohstoffe × Renditen", definition: "s = relative(commodities) * abs(relative(yields))", rationale: "Ein Rohstoffsignal könnte bei ausgeprägtem Renditeunterschied mehr Information enthalten.", inputs: ["commodities", "yields"], lag: 0, regime: "all" },
  { kind: "persistent-policy", name: "Persistente relative Geldpolitik", definition: "s = sign(relative(policy,t)) == sign(relative(policy,t-30)) ? min(abs(relative(policy,t)), abs(relative(policy,t-30))) * sign(relative(policy,t)) : 0", rationale: "Anhaltende relative Stärke könnte weniger flüchtig sein als ein einzelner Ausschlag.", inputs: ["policy"], lag: 30, regime: "all" },
  { kind: "lagged-yields", name: "Verzögerte Renditereaktion", definition: "s = clip(relative(yields,t-30) - relative(momentum,t), -1, 1)", rationale: "Ein vorausgehender Renditeunterschied könnte noch nicht vollständig im Preis sichtbar sein.", inputs: ["yields", "momentum"], lag: 30, regime: "all" },
];
export type Metrics = ReturnType<typeof calibrationMetrics>;
export type Evaluation = {
  blocks: number; samples: number; accuracy: number | null; metrics: Metrics; baseline: Metrics;
  improvement: number | null; p: number; adjustedP: number; alpha: number;
  confidenceInterval: [number, number] | null; stability: number; regimes: Record<string, number>;
};
export type Hypothesis = Template & {
  id: string; version: string; horizon: ForecastHorizon; currencies: string[]; expectedDirection: string;
  createdAt: string; status: Status; reason: string; weight: number; lastEvaluation: string | null;
  historical?: { passed: boolean; folds: Evaluation[]; final: Evaluation; development: string[]; training: string[]; validation: string[]; outOfSample: string[]; dataVersion: string };
  shadow?: Evaluation; shadowStartedAt?: string; lastShadowBlocks?: number; look: number;
  pointInTimeVerified: boolean; lastWeightChange?: string;
  qualificationVersion?: string; diagnosticBlocks?: number; lastAllocationBlocks?: number; lastAllocationLook?: number; lastEvidenceAt?:string;
};
export type Signal = { id: string; pair: string; horizon: number; signal: number; probability: number; baseline: number; phase: "RESEARCH" | "SHADOW"; regime: string; pointInTimeVerified?:boolean };
export type Frame = { issuedAt: string; recordedAt?: string; origin?: "ARCHIVED_SNAPSHOT" | "PROSPECTIVE_CAPTURE"; snapshotAsOf: string; dataVersion: string; sourceMode: string; factors: Record<string, Partial<Record<FactorKey, number>>>; regime: string; signals: Signal[]; pointInTimeVerified: boolean; provenance?:Provenance };
export type Sample = { asOf: string; labelEnd: string; pair: string; probability: number; baseline: number; label: 0 | 1; regime: string; pointInTimeVerified?:boolean };
export type Block = { asOf: string; end: string; rows: Sample[] };
export const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
export function factory(now: string): Hypothesis[] {
  return templates.flatMap(t => forecastHorizons.map(horizon => ({ ...t, id: `${PROTOCOL}:${t.kind}:${horizon}`, version: PROTOCOL, horizon,
    currencies: [...currencies], expectedDirection: "s > 0: base appreciates versus USD; s < 0: depreciates", createdAt: now,
    status: "CANDIDATE" as const, reason: "Predeclared candidate; no empirical evidence yet", weight: 0, lastEvaluation: null, look: 0, pointInTimeVerified: false })));
}
export function flags(env: { HYPOTHESIS_ENGINE_ENABLED?: string; HYPOTHESIS_PRODUCTION_WEIGHT?: string }) {
  const enabled = env.HYPOTHESIS_ENGINE_ENABLED === undefined || env.HYPOTHESIS_ENGINE_ENABLED === "true";
  const n = Number(env.HYPOTHESIS_PRODUCTION_WEIGHT ?? "0");
  return { enabled, requestedWeight: Number.isFinite(n) && n >= 0 && n <= MAX_CONTRIBUTION ? n : 0, effectiveWeight: 0, integrationApproved: LIVE_INTEGRATION_APPROVED };
}
export function signalFor(h: Hypothesis, frame: Frame, history: Frame[], currency: string): number | null {
  if (currency === "USD" || (h.regime !== "all" && frame.regime !== h.regime)) return null;
  const relative = (f: Frame | undefined, key: FactorKey): number | null => {
    const a = f?.factors[currency]?.[key], b = f?.factors.USD?.[key];
    return typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) && a >= 0 && a <= 1 && b >= 0 && b <= 1 ? a - b : null;
  };
  const lag = (days: number) => {
    const cutoff = Date.parse(frame.issuedAt) - days * 86400000;
    return [...history].filter(f => Date.parse(f.issuedAt) <= cutoff && Date.parse(f.issuedAt) >= cutoff - 4 * 86400000).sort((a,b) => b.issuedAt.localeCompare(a.issuedAt))[0];
  };
  if (h.inputs.some(k => relative(frame, k) === null)) return null;
  const p = relative(frame, "policy"), m = relative(frame, "momentum"), y = relative(frame, "yields");
  let s: number;
  switch (h.kind) {
    case "yield-divergence": s = y! - m!; break;
    case "policy-change": { const old = relative(lag(30), "policy"); if (old === null) return null; s = p! - old; break; }
    case "growth-acceleration": { const a = relative(lag(30), "growth"), b = relative(lag(60), "growth"); if (a === null || b === null) return null; s = relative(frame, "growth")! - 2*a + b; break; }
    case "cot-nonreaction": { const c = relative(frame, "cot")!; s = Math.abs(c) >= .4 && Math.abs(m!) <= .1 ? -c : 0; break; }
    case "risk-momentum": s = m!; break;
    case "commodity-interaction": s = relative(frame, "commodities")! * Math.abs(y!); break;
    case "persistent-policy": { const old = relative(lag(30), "policy"); if (old === null) return null; s = Math.sign(p!) === Math.sign(old) ? Math.sign(p!) * Math.min(Math.abs(p!), Math.abs(old)) : 0; break; }
    case "lagged-yields": { const old = relative(lag(30), "yields"); if (old === null) return null; s = old - m!; break; }
  }
  return Number.isFinite(s) ? clamp(s) : null;
}
export function makeFrame(payload: TerminalPayload, now: string, dataVersion: string, hypotheses: Hypothesis[], history: Frame[], baselines: Record<string, number>): Frame {
  if (!["live", "partial-live"].includes(payload.sourceMode) || !Number.isFinite(Date.parse(payload.asOf)) || Date.parse(payload.asOf) > Date.parse(now) || Date.parse(now)-Date.parse(payload.asOf) > 48*3600000) throw new Error("NO_FRESH_LIVE_SNAPSHOT");
  const frame: Frame = { issuedAt: now, recordedAt:now, origin:"PROSPECTIVE_CAPTURE", snapshotAsOf: payload.asOf, dataVersion, sourceMode: payload.sourceMode,
    factors: Object.fromEntries(payload.currencies.map(c => [c.code, { ...c.factors }])), regime: payload.regime.label, signals: [],
    // Existing snapshots lack per-input publication/vintage and fallback lineage. Never invent it.
    pointInTimeVerified: false, provenance:(payload as ProvenancePayload).inputProvenance };
  for (const h of hypotheses.filter(h => !["REJECTED", "INACTIVE"].includes(h.status))) for (const c of currencies.filter(c => c !== "USD")) {
    const s = signalFor(h, frame, history, c), base = baselines[`${c}/${h.horizon}`];
    if (s === null || !Number.isFinite(base) || base <= 0 || base >= 1) continue;
    // Fixed predeclared 10% probability blend for research only, NOT production score weighting.
    const probability = clamp(.9 * base + .1 * (.5 + .4*s), .001, .999);
    frame.signals.push({ id: h.id, pair: `${c}/USD`, horizon: h.horizon, signal: s, probability, baseline: base,
      phase: h.shadowStartedAt && h.shadowStartedAt < now ? "SHADOW" : "RESEARCH", regime: frame.regime,
      pointInTimeVerified:signalProvenance(h,frame,history,c) });
  }
  frame.pointInTimeVerified=frame.signals.length>0&&frame.signals.every(s=>s.pointInTimeVerified===true);
  return frame;
}
export type ResolvedObservation={pair:string;horizon:number;asOf:string;labelEnd:string;label:0|1};
export function outcomes(h: Hypothesis, frames: Frame[], closes: AuditClose[], now: string, phase: "RESEARCH" | "SHADOW", ledger?:ResolvedObservation[]): Sample[] {
  const entries = frames.flatMap(f => f.signals.filter(s => s.id === h.id && s.phase === phase && (phase !== "SHADOW" || (f.origin === "PROSPECTIVE_CAPTURE" && f.recordedAt === f.issuedAt && !!h.shadowStartedAt && f.issuedAt > h.shadowStartedAt))).map(s => ({ f, s })));
  const lookup = new Map(entries.map(e => [`${e.s.pair}:${e.f.issuedAt}`, e]));
  const resolved = resolveOutcomes(entries.map(({f,s}) => ({ pair:s.pair, horizon:s.horizon, probability:s.probability, observedAt:f.issuedAt, sourceMode:f.sourceMode })), closes, now);
  const rows=ledger?ledger.filter(o=>o.horizon===h.horizon&&lookup.has(`${o.pair}:${o.asOf}`)):resolved.outcomes;
  return rows.map(o => { const e = lookup.get(`${o.pair}:${o.asOf}`)!; return { ...o, probability:e.s.probability, baseline:e.s.baseline, regime:e.s.regime, pointInTimeVerified:!!ledger&&e.s.pointInTimeVerified===true }; });
}
/** One time block contains all currencies. No seven-fold inflation of sample size.
 * A full extra horizon embargo is used to reduce serial dependence, not prove independence. */
export function independentBlocks(rows: Sample[], horizon: number): Block[] {
  const groups = new Map<string, Sample[]>();
  for (const r of rows) {
    if (![r.probability,r.baseline].every(v=>Number.isFinite(v)&&v>0&&v<1) || ![0,1].includes(r.label) || !Number.isFinite(Date.parse(r.asOf)) || !Number.isFinite(Date.parse(r.labelEnd)) || r.labelEnd <= r.asOf.slice(0,10)) continue;
    const key=r.asOf.slice(0,10); groups.set(key,[...(groups.get(key)??[]),r]);
  }
  const result: Block[]=[]; let next=-Infinity;
  for (const [date, values] of [...groups].sort(([a],[b])=>a.localeCompare(b))) {
    if(Date.parse(date)<=next) continue;
    const unique=[...new Map(values.map(r=>[r.pair,r])).values()];
    const end=unique.reduce((s,r)=>r.labelEnd>s?r.labelEnd:s, date);
    result.push({asOf:date,end,rows:unique}); next=Date.parse(end)+horizon*86400000;
  }
  return result;
}
/** Alpha spending across EVERY horizon/idea and repeated shadow look, including rejects. */
export function alphaFor(look: number) { return .05 / SEARCH_BUDGET / (look*(look+1)); }
export function signP(wins:number,n:number) {
  if(!n||wins<=n/2) return 1;
  // Stable upper binomial tail under median(loss improvement) <= 0.
  let logChoose=0, sum=0;
  for(let k=0;k<=n;k++) { if(k>=wins) sum+=Math.exp(logChoose-n*Math.log(2)); if(k<n) logChoose+=Math.log(n-k)-Math.log(k+1); }
  return Math.min(1,sum);
}
export function evaluate(blocks: Block[], look: number): Evaluation {
  const rows=blocks.flatMap(b=>b.rows), metrics=calibrationMetrics(rows), baseline=calibrationMetrics(rows.map(r=>({...r,probability:r.baseline})));
  const effects=blocks.map(b=>b.rows.reduce((n,r)=>n+(r.baseline-r.label)**2-(r.probability-r.label)**2,0)/b.rows.length);
  const mean=effects.length?effects.reduce((a,b)=>a+b,0)/effects.length:null;
  // Exact sign test of positive median block improvement; ties count against the idea.
  // Does not claim a causal effect or that embargo proves serial independence.
  const alpha=alphaFor(look), sorted=[...effects].sort((a,b)=>a-b);
  const p=signP(effects.filter(e=>e>0).length,effects.length);
  let lo=-1,hi=1;
  for(let k=1;k<=Math.floor(effects.length/2);k++) if(2*signP(effects.length-k+1,effects.length)<=.05) { lo=sorted[k-1]; hi=sorted[effects.length-k]; }
  const regimes:Record<string,number>={}; for(const b of blocks) for(const r of new Set(b.rows.map(r=>r.regime))) regimes[r]=(regimes[r]??0)+1;
  return {blocks:blocks.length,samples:rows.length,metrics,baseline,accuracy:rows.length?rows.filter(r=>(r.probability>=.5?1:0)===r.label).length/rows.length:null,
    improvement:mean,p,adjustedP:Math.min(1,p*SEARCH_BUDGET*look*(look+1)),alpha,
    confidenceInterval:mean===null?null:[lo,hi],
    stability:effects.length?effects.filter(e=>e>0).length/effects.length:0,regimes};
}
const beneficial=(e:Evaluation)=>e.improvement!==null&&e.improvement>0&&e.metrics!==null&&e.baseline!==null&&e.metrics.logLoss<e.baseline.logLoss&&e.stability>=.6;
export function historicalTest(rows: Sample[], horizon: number, dataVersion: string) {
  const b=independentBlocks(rows,horizon);
  // Frozen first 120 blocks: 20 development, 20 fitting reserve, 3x20 validation, 20 final OOS.
  if(b.length<120) return {status:"INSUFFICIENT_DATA" as const,reason:`${b.length}/120 embargoed time blocks; currencies are not independent samples`,blocks:b.length};
  const first=b.slice(0,120), development=first.slice(0,20), training=first.slice(20,40);
  const folds=[40,60,80].map(i=>evaluate(first.slice(i,i+20),1));
  const final=evaluate(first.slice(100,120),1);
  const passed=folds.every(beneficial)&&beneficial(final)&&final.p<=final.alpha;
  return {status:passed?"SHADOW" as const:"REJECTED" as const, reason:passed?"Frozen historical protocol passed; prospective shadow required":"Frozen OOS or walk-forward baseline improvement / multiplicity test failed",
    blocks:b.length,historical:{passed,folds,final,development:[development[0].asOf,development.at(-1)!.end],training:[training[0].asOf,training.at(-1)!.end],
      validation:[first[40].asOf,first[99].end],outOfSample:[first[100].asOf,first[119].end],dataVersion}};
}
export function advance(h:Hypothesis, frames:Frame[], closes:AuditClose[], now:string, dataVersion:string, ledger?:ResolvedObservation[]):Hypothesis {
  const next={...h,lastEvaluation:now,weight:0};
  if(["REJECTED","INACTIVE"].includes(h.status)) return next;
  if(!h.historical || h.qualificationVersion!==PROVENANCE_VERSION) {
    const diagnostic=outcomes(h,frames,closes,now,"RESEARCH",ledger);
    const qualified=diagnostic.filter(r=>r.pointInTimeVerified);
    const test=historicalTest(qualified,h.horizon,dataVersion);
    return {...next,status:test.status,reason:test.reason+"; verified inputs and immutable outcomes required",
      diagnosticBlocks:independentBlocks(diagnostic,h.horizon).length,pointInTimeVerified:qualified.length>0,
      qualificationVersion:PROVENANCE_VERSION,historical:"historical" in test?test.historical:undefined,
      ...(test.status==="SHADOW"?{shadowStartedAt:now,look:1,lastEvidenceAt:now}:{} )};
  }
  if(!h.historical.passed) return {...next,status:"REJECTED",reason:"Historical gate failed"};
  const blocks=independentBlocks(outcomes(h,frames,closes,now,"SHADOW",ledger).filter(r=>r.pointInTimeVerified),h.horizon);
  if(blocks.length<(h.lastShadowBlocks??0)+10) return next;
  const look=h.look+1, shadow=evaluate(blocks,look);
  const base={...next,look,shadow,lastShadowBlocks:blocks.length,lastEvidenceAt:now};
  if(blocks.length>=30&&!beneficial(shadow)) return {...base,status:"DEGRADED",reason:"Prospective baseline edge absent; weight zero",lastWeightChange:now};
  if(blocks.length<30) return {...base,status:"SHADOW",reason:`${blocks.length}/30 new embargoed shadow blocks`};
  const regimeOK=h.regime!=="all"?((shadow.regimes[h.regime]??0)>=30):Object.values(shadow.regimes).filter(n=>n>=10).length>=2;
  if(shadow.p>shadow.alpha||!regimeOK) return {...base,status:"SHADOW",reason:"More multiplicity-adjusted evidence / regime coverage required"};
  if(!h.pointInTimeVerified) return {...base,status:"SHADOW",reason:"Production blocked: input publication/vintage/fallback lineage not certified"};
  return {...base,status:"VALIDATED",reason:"Verified historical and prospective evidence passed; bounded USD-pair adapter requires an enabled budget"};
}
/** Explicit read-only identity contract. See safety.ts for the separately tested proposed
 * allocation policy. This is NOT advertised as a connected production adapter. */
export function contribution(core:number, hypotheses:Hypothesis[], enabled:boolean, requestedWeight:number) {
  void hypotheses; void enabled; void requestedWeight;
  return {coreScore:core,hypothesisAdjustment:0,finalScore:core,totalWeight:0,maxWeight:MAX_CONTRIBUTION,reason:"FUNDAMENTAL_SCORE_TARGET_NOT_VALIDATED"};
}
