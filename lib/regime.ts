import { factorMeta, type CurrencySnapshot, type FactorKey, type FactorScores, type MarketRegime } from "@/lib/terminal-data";

const factors = Object.keys(factorMeta) as FactorKey[];

function clamp(value: number, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function normalize(weights: FactorScores) {
  const total = factors.reduce((sum, factor) => sum + Math.max(0, weights[factor] ?? 0), 0);
  return Object.fromEntries(factors.map((factor) => [
    factor,
    total > 0 ? Math.max(0, weights[factor] ?? 0) / total : 1 / factors.length,
  ])) as FactorScores;
}

export function detectMarketRegime(
  vix: number | null,
  currencies: CurrencySnapshot[],
  observedAt = new Date().toISOString(),
): MarketRegime {
  const averageRisk = currencies.reduce((sum, currency) => sum + currency.factors.risk, 0) / Math.max(1, currencies.length);
  const averageMomentum = currencies.reduce((sum, currency) => sum + currency.factors.momentum, 0) / Math.max(1, currencies.length);
  const vixSignal = vix === null ? 0 : (vix - 20) / 5.5;
  const internalSignal = (0.5 - averageRisk) * 2.4 + (0.5 - averageMomentum) * 1.2;
  const riskOffProbability = clamp(1 / (1 + Math.exp(-(vixSignal + internalSignal))));
  return {
    label: riskOffProbability >= 0.62 ? "risk-off" : riskOffProbability <= 0.38 ? "risk-on" : "neutral",
    riskOffProbability,
    vix,
    observedAt,
    source: vix === null ? "Aggregated risk inputs" : "FRED VIXCLS + aggregated risk inputs",
  };
}

export function applyRegimeWeights(weights: FactorScores, regime: MarketRegime) {
  const riskOff = regime.riskOffProbability;
  const riskOn = 1 - riskOff;
  const multipliers: Partial<Record<FactorKey, number>> = {
    risk: 0.82 + riskOff * 1.55,
    yields: 0.92 + riskOff * 0.32,
    policy: 0.95 + riskOff * 0.2,
    growth: 0.86 + riskOn * 0.34,
    commodities: 0.84 + riskOn * 0.42,
    momentum: 0.9 + riskOn * 0.25,
    sentiment: 0.94 + Math.abs(riskOff - 0.5) * 0.34,
  };
  return normalize(Object.fromEntries(factors.map((factor) => [
    factor,
    weights[factor] * (multipliers[factor] ?? 1),
  ])) as FactorScores);
}
