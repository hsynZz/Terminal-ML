import {
  factorMeta,
  forecastHorizons,
  type CurrencyCode,
  type CurrencySnapshot,
  type FactorKey,
  type TerminalPayload,
  type ForecastHorizon,
} from "@/lib/terminal-data";
import { applyRegimeWeights } from "@/lib/regime";

export type DistributionPoint = {
  id: string;
  currency: CurrencyCode;
  horizon: number;
  probability: number;
  confidence: number;
  sample: number;
};

export type CurrencyEstimate = {
  currency: CurrencyCode;
  probability: number;
  low: number;
  high: number;
  dispersion: number;
  strength: number;
};

export type ModelDistribution = {
  points: DistributionPoint[];
  estimates: CurrencyEstimate[];
  coverage: number;
  pointCount: number;
  version: string;
};

export type PairForecastPoint = {
  horizon: 10 | 30 | 60 | 90;
  probability: number;
  low: number;
  high: number;
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
  dispersion: number;
  sampleCount: number;
  signal: "up" | "neutral" | "down";
  neutralThreshold: number;
};

const factors = Object.keys(factorMeta) as FactorKey[];
// Common deterministic samples: refresh time is metadata, never a model input.
const samplingVersion = "fx-common-samples-v1";

function hashUnit(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function gaussianLike(seed: string) {
  const a = Math.max(1e-7, hashUnit(`${seed}:a`));
  const b = hashUnit(`${seed}:b`);
  return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
}

function clamp(value: number, low = 0.015, high = 0.985) {
  return Math.max(low, Math.min(high, value));
}

function sigmoid(value: number) {
  return 1 / (1 + Math.exp(-value));
}

function quantile(values: number[], position: number) {
  if (!values.length) return 0.5;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * position;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function projectedFeature(currency: CurrencySnapshot, factor: FactorKey, horizon: number) {
  const current = currency.factors[factor];
  const recentMove = currency.history[0].score - currency.history[1].score;
  const decayedMomentum = recentMove * Math.exp(-horizon / 48) * 0.85;
  const meanReversion = (0.5 - current) * (horizon / 90) * 0.12;
  return clamp(current + decayedMomentum + meanReversion, 0.02, 0.98);
}

function normalizeWeights(weights: Record<FactorKey, number>) {
  const total = factors.reduce((sum, factor) => sum + Math.max(0, weights[factor] ?? 0), 0);
  return Object.fromEntries(factors.map((factor) => [
    factor,
    total > 0 ? Math.max(0, weights[factor] ?? 0) / total : 1 / factors.length,
  ])) as Record<FactorKey, number>;
}

function learnedWeightsForHorizon(payload: TerminalPayload, horizon?: number) {
  const global = normalizeWeights(payload.model?.learnedWeights ?? Object.fromEntries(factors.map((factor) => [factor, factorMeta[factor].weight])) as Record<FactorKey, number>);
  if (horizon === undefined) return global;
  const lower = [...forecastHorizons].reverse().find((value) => value <= horizon) ?? forecastHorizons[0];
  const upper = forecastHorizons.find((value) => value >= horizon) ?? forecastHorizons.at(-1)!;
  const at = (anchor: ForecastHorizon) => payload.model?.horizonTrainingSamples?.[anchor] >= 100
    ? normalizeWeights(payload.model.horizonWeights[anchor])
    : global;
  if (lower === upper) return at(lower);
  const share = (horizon - lower) / (upper - lower);
  const lowWeights = at(lower);
  const highWeights = at(upper);
  return normalizeWeights(Object.fromEntries(factors.map((factor) => [
    factor,
    lowWeights[factor] * (1 - share) + highWeights[factor] * share,
  ])) as Record<FactorKey, number>);
}

export function effectiveModelWeights(payload: TerminalPayload, horizon?: number) {
  const modelBlend = clamp(payload.model?.modelBlend ?? 0.8, 0, 1);
  const expert = normalizeWeights(payload.model?.expertWeights ?? Object.fromEntries(factors.map((factor) => [factor, factorMeta[factor].weight])) as Record<FactorKey, number>);
  const learned = learnedWeightsForHorizon(payload, horizon);
  const hybrid = normalizeWeights(Object.fromEntries(factors.map((factor) => [
    factor,
    expert[factor] * (1 - modelBlend) + learned[factor] * modelBlend,
  ])) as Record<FactorKey, number>);
  return applyRegimeWeights(hybrid, payload.regime);
}

function weightedStrength(currency: CurrencySnapshot, weights: Record<FactorKey, number>) {
  return factors.reduce((score, factor) => score + currency.factors[factor] * weights[factor], 0);
}

function latentSample(
  currency: CurrencySnapshot,
  horizon: number,
  sample: number,
  snapshotId: string,
  coverage: number,
  weights: Record<FactorKey, number>,
) {
  let weighted = 0;
  let totalWeight = 0;
  for (const factor of factors) {
    const seed = `${snapshotId}:${currency.code}:${factor}:${horizon}:${sample}`;
    const resample = 1 + gaussianLike(seed) * (0.09 + (1 - coverage) * 0.12);
    const weight = Math.max(0.01, weights[factor] * resample);
    const featureNoise = gaussianLike(`${seed}:residual`) * (0.018 + (1 - coverage) * 0.045);
    weighted += clamp(projectedFeature(currency, factor, horizon) + featureNoise, 0, 1) * weight;
    totalWeight += weight;
  }
  return weighted / totalWeight;
}

function dataCoverage(mode: TerminalPayload["sourceMode"]) {
  if (mode === "live") return 0.92;
  if (mode === "partial-live") return 0.68;
  return 0.46;
}

export function buildModelDistribution(
  payload: TerminalPayload,
  selected: CurrencyCode[],
): ModelDistribution {
  const coverage = dataCoverage(payload.sourceMode);
  const globalWeights = effectiveModelWeights(payload);
  const selectedSet = new Set(selected);
  const visible = payload.currencies.filter((item) => selectedSet.has(item.code));
  const benchmarkUniverse = visible.length > 1 ? visible : payload.currencies;
  const points: DistributionPoint[] = [];
  const statesPerCurrency = 26;
  const goldenRatioStep = 0.61803398875;

  for (const currency of visible) {
    const horizonOffset = hashUnit(`${samplingVersion}:${currency.code}:horizon-offset`);
    for (let sample = 0; sample < statesPerCurrency; sample++) {
      const horizonUnit = (horizonOffset + (sample + 1) * goldenRatioStep) % 1;
      const horizon = 10 + horizonUnit * 80;
      const horizonWeights = effectiveModelWeights(payload, horizon);
      const latent = new Map(payload.currencies.map((currency) => [
        currency.code,
        latentSample(currency, horizon, sample, samplingVersion, coverage, horizonWeights),
      ]));

      const opponents = benchmarkUniverse.filter((item) => item.code !== currency.code);
      const opponentMean = opponents.reduce((sum, item) => sum + (latent.get(item.code) ?? 0.5), 0) / Math.max(1, opponents.length);
      const relative = (latent.get(currency.code) ?? 0.5) - opponentMean;
      const uncertainty = 0.3 + (1 - coverage) * 0.72 + (horizon / 90) * 0.16;
      const posteriorNoise = gaussianLike(`${samplingVersion}:${currency.code}:${sample}:posterior`) * uncertainty;
      const probability = clamp(sigmoid(relative * 7.4 + posteriorNoise));
      points.push({
        id: `${currency.code}-${sample}`,
        currency: currency.code,
        horizon,
        probability,
        confidence: clamp(coverage - horizon / 540, 0.25, 0.96),
        sample,
      });
    }
  }

  const estimates = visible.map((currency) => {
    const currencyPoints = points.filter((point) => point.currency === currency.code && point.horizon <= 35);
    const probabilities = currencyPoints.map((point) => point.probability);
    const low = quantile(probabilities, 0.1);
    const high = quantile(probabilities, 0.9);
    return {
      currency: currency.code,
      probability: probabilities.reduce((sum, value) => sum + value, 0) / Math.max(1, probabilities.length),
      low,
      high,
      dispersion: high - low,
      strength: weightedStrength(currency, globalWeights),
    };
  }).sort((a, b) => b.probability - a.probability);

  return { points, estimates, coverage, pointCount: points.length, version: "ML-H 1.2" };
}

export function buildPairForecast(
  payload: TerminalPayload,
  base: CurrencyCode,
  quote: CurrencyCode,
): PairForecastPoint[] {
  const baseCurrency = payload.currencies.find((currency) => currency.code === base);
  const quoteCurrency = payload.currencies.find((currency) => currency.code === quote);
  if (!baseCurrency || !quoteCurrency || base === quote) return [];

  const coverage = dataCoverage(payload.sourceMode);
  return forecastHorizons.map((horizon) => {
    const weights = effectiveModelWeights(payload, horizon);
    const probabilities = Array.from({ length: 48 }, (_, sample) => {
      const baseLatent = latentSample(baseCurrency, horizon, sample, samplingVersion, coverage, weights);
      const quoteLatent = latentSample(quoteCurrency, horizon, sample, samplingVersion, coverage, weights);
      const uncertainty = 0.22 + (1 - coverage) * 0.55 + (horizon / 90) * 0.14;
      const posteriorNoise = gaussianLike(`${samplingVersion}:${base}:${quote}:${horizon}:${sample}:pair`) * uncertainty;
      return clamp(sigmoid((baseLatent - quoteLatent) * 7.4 + posteriorNoise));
    });
    const probability = probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length;
    const dispersion = Math.sqrt(probabilities.reduce((sum, value) => sum + (value - probability) ** 2, 0) / probabilities.length);
    const sampleAdequacy = 1 - Math.exp(-(payload.model.trainingSamples ?? 0) / 240);
    const signalStability = clamp(1 - dispersion / 0.24, 0, 1);
    const confidence = clamp(coverage * 0.42 + sampleAdequacy * 0.34 + signalStability * 0.24, 0.08, 0.97);
    const neutralThreshold = 0.04 + (1 - confidence) * 0.035 + Math.min(0.02, dispersion * 0.08);
    const signal = Math.abs(probability - 0.5) <= neutralThreshold
      ? "neutral" as const
      : probability > 0.5 ? "up" as const : "down" as const;
    return {
      horizon,
      probability,
      low: quantile(probabilities, 0.1),
      high: quantile(probabilities, 0.9),
      confidence,
      confidenceLabel: confidence >= 0.72 ? "high" : confidence >= 0.48 ? "medium" : "low",
      dispersion,
      sampleCount: payload.model.trainingSamples ?? 0,
      signal,
      neutralThreshold,
    };
  });
}
