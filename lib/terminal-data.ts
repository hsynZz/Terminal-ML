export const currencies = ["USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD"] as const;

export type CurrencyCode = (typeof currencies)[number];
export type FactorKey =
  | "policy"
  | "inflation"
  | "growth"
  | "yields"
  | "cot"
  | "commodities"
  | "risk"
  | "seasonality"
  | "momentum"
  | "sentiment";

export type FactorScores = Record<FactorKey, number>;

export type CurrencySnapshot = {
  code: CurrencyCode;
  name: string;
  rate: number;
  realRate: number;
  inflation: number;
  growth: number;
  unemployment: number;
  yield2y: number;
  yield10y: number;
  currentAccount: number;
  debt: number;
  factors: FactorScores;
  history: { ageDays: number; score: number }[];
};

export type CalendarEvent = {
  id: string;
  currency: CurrencyCode;
  date: string;
  time: string;
  title: string;
  impact: "Hoch" | "Mittel" | "Niedrig";
  consensus: string;
  previous: string;
};

export type TerminalPayload = {
  asOf: string;
  nextRefresh: string;
  sourceMode: "baseline" | "partial-live" | "live";
  currencies: CurrencySnapshot[];
  evidence: EvidenceEntry[];
  events: CalendarEvent[];
  sources: { name: string; status: "connected" | "ready" | "missing"; detail: string }[];
  model: ModelSettings;
  regime: MarketRegime;
};

export type MarketRegime = {
  label: "risk-on" | "neutral" | "risk-off";
  riskOffProbability: number;
  vix: number | null;
  observedAt: string;
  source: string;
};

export type WalkForwardValidation = {
  mode: "expanding" | "rolling";
  folds: number;
  sampleCount: number;
  accuracy: number;
  logLoss: number;
  brierScore: number;
  validatedAt: string;
};

export const forecastHorizons = [10, 30, 60, 90] as const;
export type ForecastHorizon = (typeof forecastHorizons)[number];

export type ModelSettings = {
  modelBlend: number;
  expertWeights: FactorScores;
  learnedWeights: FactorScores;
  horizonWeights: Record<ForecastHorizon, FactorScores>;
  horizonTrainingSamples: Record<ForecastHorizon, number>;
  horizonValidation: Partial<Record<ForecastHorizon, WalkForwardValidation>>;
  trainedAt: string | null;
  trainingSamples: number;
  validation: WalkForwardValidation | null;
};

export type EvidenceEntry = {
  id: string;
  currency: CurrencyCode;
  factor: FactorKey;
  ageDays: number;
  score: number;
  weight: number;
  observedAt: string;
  source: string;
};

export const factorMeta: Record<FactorKey, { label: string; weight: number; short: string }> = {
  policy: { label: "Geldpolitik & Zinsen", weight: 0.16, short: "Zinsen" },
  inflation: { label: "Inflation", weight: 0.09, short: "Inflation" },
  growth: { label: "Wachstum, Arbeit & Konsum", weight: 0.14, short: "Wachstum" },
  yields: { label: "Renditen & Zinsdifferenz", weight: 0.15, short: "Renditen" },
  cot: { label: "COT-Positionierung", weight: 0.09, short: "COT" },
  commodities: { label: "Rohstoff-Sensitivität", weight: 0.05, short: "Rohstoffe" },
  risk: { label: "Risk & Geopolitik", weight: 0.1, short: "Risk" },
  seasonality: { label: "Saisonalität", weight: 0.04, short: "Saisonal" },
  momentum: { label: "FX-Momentum", weight: 0.12, short: "Momentum" },
  sentiment: { label: "Zentralbank-Sentiment", weight: 0.06, short: "NLP" },
};

export function getDefaultModelSettings(): ModelSettings {
  const expertWeights = Object.fromEntries(
    (Object.keys(factorMeta) as FactorKey[]).map((factor) => [factor, factorMeta[factor].weight]),
  ) as FactorScores;
  const learnedWeights: FactorScores = {
    policy: 0.16,
    inflation: 0.09,
    growth: 0.14,
    yields: 0.2,
    cot: 0.09,
    commodities: 0.05,
    risk: 0.11,
    seasonality: 0.04,
    momentum: 0.1,
    sentiment: 0.06,
  };
  return {
    modelBlend: 0.8,
    expertWeights,
    learnedWeights,
    horizonWeights: Object.fromEntries(forecastHorizons.map((horizon) => [horizon, { ...learnedWeights }])) as Record<ForecastHorizon, FactorScores>,
    horizonTrainingSamples: Object.fromEntries(forecastHorizons.map((horizon) => [horizon, 0])) as Record<ForecastHorizon, number>,
    horizonValidation: {},
    trainedAt: null,
    trainingSamples: 0,
    validation: null,
  };
}

function normalizeFactorScores(input: Partial<FactorScores> | undefined, fallback: FactorScores) {
  const values = Object.fromEntries((Object.keys(factorMeta) as FactorKey[]).map((factor) => {
    const candidate = Number(input?.[factor]);
    return [factor, Number.isFinite(candidate) && candidate >= 0 ? candidate : fallback[factor]];
  })) as FactorScores;
  const total = (Object.keys(values) as FactorKey[]).reduce((sum, factor) => sum + values[factor], 0);
  if (total <= 0) return { ...fallback };
  return Object.fromEntries((Object.keys(values) as FactorKey[]).map((factor) => [factor, values[factor] / total])) as FactorScores;
}

export function sanitizeModelSettings(input?: Partial<ModelSettings>): ModelSettings {
  const fallback = getDefaultModelSettings();
  const blend = Number(input?.modelBlend);
  const learnedWeights = normalizeFactorScores(input?.learnedWeights, fallback.learnedWeights);
  const sanitizeValidation = (validation: WalkForwardValidation | null | undefined) => validation && Number.isFinite(Number(validation.folds))
    ? {
      mode: validation.mode === "rolling" ? "rolling" as const : "expanding" as const,
      folds: Math.max(0, Math.floor(Number(validation.folds))),
      sampleCount: Math.max(0, Math.floor(Number(validation.sampleCount))),
      accuracy: Math.max(0, Math.min(1, Number(validation.accuracy))),
      logLoss: Math.max(0, Number(validation.logLoss)),
      brierScore: Math.max(0, Number(validation.brierScore)),
      validatedAt: typeof validation.validatedAt === "string" ? validation.validatedAt : new Date(0).toISOString(),
    }
    : null;
  return {
    modelBlend: Number.isFinite(blend) ? Math.max(0, Math.min(1, blend)) : fallback.modelBlend,
    expertWeights: normalizeFactorScores(input?.expertWeights, fallback.expertWeights),
    learnedWeights,
    horizonWeights: Object.fromEntries(forecastHorizons.map((horizon) => [
      horizon,
      normalizeFactorScores(input?.horizonWeights?.[horizon], learnedWeights),
    ])) as Record<ForecastHorizon, FactorScores>,
    horizonTrainingSamples: Object.fromEntries(forecastHorizons.map((horizon) => [
      horizon,
      Math.max(0, Math.floor(Number(input?.horizonTrainingSamples?.[horizon]) || 0)),
    ])) as Record<ForecastHorizon, number>,
    horizonValidation: Object.fromEntries(forecastHorizons.flatMap((horizon) => {
      const validation = sanitizeValidation(input?.horizonValidation?.[horizon]);
      return validation ? [[horizon, validation]] : [];
    })) as Partial<Record<ForecastHorizon, WalkForwardValidation>>,
    trainedAt: typeof input?.trainedAt === "string" ? input.trainedAt : null,
    trainingSamples: Number.isFinite(Number(input?.trainingSamples)) ? Math.max(0, Math.floor(Number(input?.trainingSamples))) : 0,
    validation: sanitizeValidation(input?.validation),
  };
}

const seed: Omit<CurrencySnapshot, "history">[] = [
  {
    code: "USD", name: "US-Dollar", rate: 4.25, realRate: 1.55, inflation: 2.7, growth: 1.9,
    unemployment: 4.2, yield2y: 3.78, yield10y: 4.12, currentAccount: -3.1, debt: 121.0,
    factors: { policy: 0.61, inflation: 0.54, growth: 0.58, yields: 0.63, cot: 0.45, commodities: 0.5, risk: 0.73, seasonality: 0.48, momentum: 0.56, sentiment: 0.5 },
  },
  {
    code: "EUR", name: "Euro", rate: 2.25, realRate: -0.15, inflation: 2.4, growth: 1.4,
    unemployment: 6.2, yield2y: 2.18, yield10y: 2.72, currentAccount: 2.8, debt: 87.0,
    factors: { policy: 0.72, inflation: 0.67, growth: 0.64, yields: 0.70, cot: 0.80, commodities: 0.58, risk: 0.70, seasonality: 0.74, momentum: 0.62, sentiment: 0.5 },
  },
  {
    code: "GBP", name: "Britisches Pfund", rate: 3.75, realRate: 0.65, inflation: 3.1, growth: 1.2,
    unemployment: 4.8, yield2y: 3.65, yield10y: 4.31, currentAccount: -2.4, debt: 98.0,
    factors: { policy: 0.59, inflation: 0.39, growth: 0.47, yields: 0.65, cot: 0.62, commodities: 0.5, risk: 0.49, seasonality: 0.56, momentum: 0.51, sentiment: 0.5 },
  },
  {
    code: "JPY", name: "Japanischer Yen", rate: 0.75, realRate: -1.65, inflation: 2.4, growth: 0.8,
    unemployment: 2.6, yield2y: 0.92, yield10y: 1.48, currentAccount: 4.1, debt: 235.0,
    factors: { policy: 0.48, inflation: 0.50, growth: 0.41, yields: 0.44, cot: 0.57, commodities: 0.38, risk: 0.77, seasonality: 0.60, momentum: 0.44, sentiment: 0.5 },
  },
  {
    code: "CHF", name: "Schweizer Franken", rate: 0.25, realRate: -0.75, inflation: 1.0, growth: 1.3,
    unemployment: 3.0, yield2y: 0.18, yield10y: 0.42, currentAccount: 6.9, debt: 38.0,
    factors: { policy: 0.52, inflation: 0.75, growth: 0.56, yields: 0.40, cot: 0.68, commodities: 0.5, risk: 0.84, seasonality: 0.58, momentum: 0.53, sentiment: 0.5 },
  },
  {
    code: "CAD", name: "Kanadischer Dollar", rate: 2.75, realRate: 0.35, inflation: 2.4, growth: 0.7,
    unemployment: 7.0, yield2y: 2.51, yield10y: 3.08, currentAccount: -1.0, debt: 107.0,
    factors: { policy: 0.33, inflation: 0.42, growth: 0.38, yields: 0.35, cot: 0.25, commodities: 0.31, risk: 0.32, seasonality: 0.27, momentum: 0.35, sentiment: 0.5 },
  },
  {
    code: "AUD", name: "Australischer Dollar", rate: 3.60, realRate: 0.60, inflation: 3.0, growth: 1.6,
    unemployment: 4.3, yield2y: 3.42, yield10y: 4.27, currentAccount: -1.6, debt: 51.0,
    factors: { policy: 0.57, inflation: 0.44, growth: 0.53, yields: 0.59, cot: 0.48, commodities: 0.67, risk: 0.43, seasonality: 0.51, momentum: 0.55, sentiment: 0.5 },
  },
  {
    code: "NZD", name: "Neuseeland-Dollar", rate: 3.25, realRate: 0.35, inflation: 2.9, growth: 0.4,
    unemployment: 5.3, yield2y: 3.18, yield10y: 4.06, currentAccount: -5.7, debt: 47.0,
    factors: { policy: 0.46, inflation: 0.45, growth: 0.35, yields: 0.54, cot: 0.41, commodities: 0.61, risk: 0.38, seasonality: 0.45, momentum: 0.42, sentiment: 0.5 },
  },
];

const historyDeltas: Record<CurrencyCode, number[]> = {
  USD: [0, 0.01, 0.04, 0.07, 0.10], EUR: [0, -0.01, -0.04, -0.08, -0.12],
  GBP: [0, 0.01, 0.02, 0.01, -0.01], JPY: [0, -0.02, -0.03, 0.00, 0.04],
  CHF: [0, 0.00, -0.02, -0.04, -0.05], CAD: [0, 0.02, 0.05, 0.08, 0.11],
  AUD: [0, -0.01, 0.01, 0.03, 0.05], NZD: [0, 0.00, 0.03, 0.05, 0.06],
};

export function strengthScore(currency: Pick<CurrencySnapshot, "factors">) {
  const score = (Object.keys(factorMeta) as FactorKey[]).reduce(
    (total, key) => total + currency.factors[key] * factorMeta[key].weight,
    0,
  );
  return Math.max(0, Math.min(1, score));
}

export function pairScore(base: CurrencySnapshot, quote: CurrencySnapshot) {
  return Math.max(-1, Math.min(1, (strengthScore(base) - strengthScore(quote)) * 2));
}

export function factorContributions(base: CurrencySnapshot, quote: CurrencySnapshot) {
  return (Object.keys(factorMeta) as FactorKey[]).map((key) => ({
    key,
    label: factorMeta[key].short,
    weight: factorMeta[key].weight,
    value: (base.factors[key] - quote.factors[key]) * factorMeta[key].weight * 2,
  }));
}

export function rebuildDerivedScores(items: CurrencySnapshot[]) {
  const normalize = (value: number, values: number[], inverse = false) => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const scaled = max === min ? 0.5 : (value - min) / (max - min);
    return inverse ? 1 - scaled : scaled;
  };
  const growthValues = items.map((item) => item.growth);
  const unemploymentValues = items.map((item) => item.unemployment);
  const accountValues = items.map((item) => item.currentAccount);
  const debtValues = items.map((item) => item.debt);
  for (const item of items) {
    item.realRate = item.rate - item.inflation;
    const inflationTarget = Math.max(0, 1 - Math.abs(item.inflation - 2) / 4);
    const realRateSupport = Math.max(0, Math.min(1, (item.realRate + 2) / 5));
    item.factors.inflation = inflationTarget * 0.65 + realRateSupport * 0.35;
    item.factors.growth = normalize(item.growth, growthValues) * 0.6 + normalize(item.unemployment, unemploymentValues, true) * 0.4;
    item.factors.risk = item.factors.risk * 0.5 + normalize(item.currentAccount, accountValues) * 0.3 + normalize(item.debt, debtValues, true) * 0.2;
    item.history[0].score = strengthScore(item);
  }
  return items;
}

export function buildEvidence(
  items: CurrencySnapshot[],
  asOf: string,
  source = "Model baseline",
  weights?: Partial<FactorScores>,
): EvidenceEntry[] {
  const ages = [0, 10, 30, 60, 90];
  return items.flatMap((currency) => factorKeysForEvidence().map((factor, index) => {
    const ageDays = ages[index % ages.length];
    const observedAt = new Date(new Date(asOf).getTime() - ageDays * 86_400_000).toISOString();
    return {
      id: `${currency.code}-${factor}-${observedAt}`,
      currency: currency.code,
      factor,
      ageDays,
      score: currency.factors[factor],
      weight: weights?.[factor] ?? factorMeta[factor].weight,
      observedAt,
      source,
    };
  }));
}

function factorKeysForEvidence() {
  return Object.keys(factorMeta) as FactorKey[];
}

function withHistory(item: Omit<CurrencySnapshot, "history">): CurrencySnapshot {
  const current = strengthScore(item);
  const ages = [0, 10, 30, 60, 90];
  return {
    ...item,
    history: ages.map((ageDays, index) => ({
      ageDays,
      score: Math.max(0.05, Math.min(0.95, current + historyDeltas[item.code][index])),
    })),
  };
}

export function getBaselinePayload(): TerminalPayload {
  const asOf = "2026-09-04T15:15:00.000Z";
  const currencyData = seed.map(withHistory);
  return {
    asOf,
    nextRefresh: "Täglich 17:15 Europe/Berlin",
    sourceMode: "baseline",
    currencies: currencyData,
    evidence: buildEvidence(currencyData, asOf),
    model: getDefaultModelSettings(),
    regime: {
      label: "neutral",
      riskOffProbability: 0.5,
      vix: null,
      observedAt: asOf,
      source: "Baseline",
    },
    events: [
      { id: "e1", currency: "USD", date: "Mo., 7. Sep.", time: "16:00", title: "ISM Services PMI", impact: "Hoch", consensus: "51,8", previous: "51,5" },
      { id: "e2", currency: "GBP", date: "Di., 8. Sep.", time: "08:00", title: "Arbeitsmarktbericht", impact: "Hoch", consensus: "—", previous: "4,8 %" },
      { id: "e3", currency: "EUR", date: "Do., 10. Sep.", time: "14:15", title: "EZB Zinsentscheidung", impact: "Hoch", consensus: "2,25 %", previous: "2,25 %" },
      { id: "e4", currency: "USD", date: "Do., 10. Sep.", time: "14:30", title: "CPI / Core CPI", impact: "Hoch", consensus: "2,7 %", previous: "2,7 %" },
      { id: "e5", currency: "CAD", date: "Fr., 11. Sep.", time: "14:30", title: "Beschäftigung", impact: "Mittel", consensus: "+12K", previous: "+8K" },
    ],
    sources: [
      { name: "World Bank Open Data", status: "ready", detail: "Makro-Fundamentaldaten ohne API-Key" },
      { name: "FRED", status: "ready", detail: "US-Leitzins und Treasury-Renditen" },
      { name: "Alpha Vantage", status: "missing", detail: "FX-Tageskurse und Momentum – API-Key nicht hinterlegt" },
      { name: "CFTC COT", status: "ready", detail: "Positionierungsdaten – Adapter vorbereitet" },
      { name: "Zentralbanken", status: "ready", detail: "Fed, EZB, BoE, BoJ, SNB, BoC, RBA, RBNZ" },
      { name: "Kalender & Konsens", status: "missing", detail: "Live-Kalenderquelle noch nicht verbunden" },
    ],
  };
}

export function hydrateTerminalPayload(input: TerminalPayload): TerminalPayload {
  const fallback = getBaselinePayload();
  const incomingModel = input.model;
  return {
    ...fallback,
    ...input,
    currencies: fallback.currencies.map((baseCurrency) => {
      const current = input.currencies?.find((currency) => currency.code === baseCurrency.code);
      return current
        ? { ...baseCurrency, ...current, factors: { ...baseCurrency.factors, ...current.factors } }
        : baseCurrency;
    }),
    sources: fallback.sources.map((baseSource) => (
      input.sources?.find((source) => source.name === baseSource.name) ?? baseSource
    )),
    model: sanitizeModelSettings({
      ...fallback.model,
      ...incomingModel,
      expertWeights: { ...fallback.model.expertWeights, ...incomingModel?.expertWeights },
      learnedWeights: { ...fallback.model.learnedWeights, ...incomingModel?.learnedWeights },
    }),
    regime: input.regime ?? fallback.regime,
  };
}
