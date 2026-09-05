import { buildPairForecast, effectiveModelWeights } from "@/lib/model-engine";
import { factorMeta, type CurrencyCode, type FactorKey, type TerminalPayload } from "@/lib/terminal-data";

export type FeatureContribution = {
  factor: FactorKey;
  label: string;
  baseValue: number;
  quoteValue: number;
  weight: number;
  contribution: number;
  absoluteImportance: number;
};

export function buildFeatureExplanation(
  payload: TerminalPayload,
  base: CurrencyCode,
  quote: CurrencyCode,
  horizon: 10 | 30 | 60 | 90,
) {
  const baseCurrency = payload.currencies.find((currency) => currency.code === base);
  const quoteCurrency = payload.currencies.find((currency) => currency.code === quote);
  if (!baseCurrency || !quoteCurrency || base === quote) return null;
  const weights = effectiveModelWeights(payload, horizon);
  const contributions = (Object.keys(factorMeta) as FactorKey[]).map((factor) => {
    const contribution = (baseCurrency.factors[factor] - quoteCurrency.factors[factor]) * weights[factor];
    return {
      factor,
      label: factorMeta[factor].label,
      baseValue: baseCurrency.factors[factor],
      quoteValue: quoteCurrency.factors[factor],
      weight: weights[factor],
      contribution,
      absoluteImportance: Math.abs(contribution),
    } satisfies FeatureContribution;
  }).sort((a, b) => b.absoluteImportance - a.absoluteImportance);
  const forecast = buildPairForecast(payload, base, quote).find((item) => item.horizon === horizon);
  if (!forecast) return null;
  return {
    pair: `${base}/${quote}`,
    base,
    quote,
    horizon,
    probability: forecast.probability,
    confidence: forecast.confidence,
    confidenceLabel: forecast.confidenceLabel,
    signal: forecast.signal,
    neutralThreshold: forecast.neutralThreshold,
    regime: payload.regime,
    netContribution: contributions.reduce((sum, item) => sum + item.contribution, 0),
    topDriver: contributions[0] ?? null,
    contributions,
    observedAt: payload.asOf,
    modelVersion: "ML-H 1.2",
  };
}
