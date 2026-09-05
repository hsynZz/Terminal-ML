import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({
  appType: "custom",
  configFile: false,
  root,
  resolve: { alias: { "@": root } },
  server: { middlewareMode: true },
});

after(async () => vite.close());

test("refresh timestamps do not move clouds or change dominance", async () => {
  const { getBaselinePayload } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { buildModelDistribution, buildPairForecast } = await vite.ssrLoadModule("/lib/model-engine.ts");
  const payload = getBaselinePayload();
  const later = structuredClone(payload);
  later.asOf = "2026-09-06T12:34:56.000Z";
  assert.deepEqual(buildModelDistribution(payload, ["EUR", "USD"]), buildModelDistribution(later, ["EUR", "USD"]));
  assert.deepEqual(buildPairForecast(payload, "EUR", "USD"), buildPairForecast(later, "EUR", "USD"));
  later.currencies.find(currency => currency.code === "EUR").factors.policy += 0.4;
  assert.notDeepEqual(buildPairForecast(payload, "EUR", "USD"), buildPairForecast(later, "EUR", "USD"));
});

test("refresh cooldown expires and Berlin cutoff follows daylight saving", async () => {
  const { canReuseRefresh, berlinRefreshParts } = await vite.ssrLoadModule("/lib/refresh-policy.ts");
  const now = Date.parse("2026-09-05T15:15:00Z");
  assert.equal(canReuseRefresh("2026-09-05T15:14:00Z", now), true);
  assert.equal(canReuseRefresh("2026-09-05T15:00:00Z", now), false);
  assert.equal(canReuseRefresh("2026-09-05T15:16:00Z", now), false);
  assert.equal(canReuseRefresh("invalid", now), false);
  assert.equal(berlinRefreshParts(new Date("2026-09-05T15:15:00Z")).afterCutoff, true);
  assert.equal(berlinRefreshParts(new Date("2026-09-05T08:00:00Z")).afterCutoff, false);
  assert.equal(berlinRefreshParts(new Date("2026-01-05T15:15:00Z")).afterCutoff, false);
  assert.equal(berlinRefreshParts(new Date("2026-01-05T16:15:00Z")).afterCutoff, true);
});

test("builds a deterministic non-event ensemble distribution", async () => {
  const { getBaselinePayload } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { buildModelDistribution } = await vite.ssrLoadModule("/lib/model-engine.ts");
  const payload = getBaselinePayload();
  const selected = ["EUR", "CAD"];
  const first = buildModelDistribution(payload, selected);
  const second = buildModelDistribution(payload, selected);

  assert.deepEqual(first, second);
  assert.equal(first.pointCount, 52);
  assert.equal(first.estimates.length, 2);
  assert.ok(first.points.every((point) => selected.includes(point.currency)));
  assert.ok(first.points.every((point) => point.probability > 0 && point.probability < 1));
  assert.ok(new Set(first.points.map((point) => point.horizon.toFixed(2))).size > 40);
  assert.ok(first.points.some((point) => Math.abs(point.horizon % 5) > 0.1));
});

test("removes every point belonging to a deselected currency", async () => {
  const { getBaselinePayload } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { buildModelDistribution } = await vite.ssrLoadModule("/lib/model-engine.ts");
  const result = buildModelDistribution(getBaselinePayload(), ["EUR"]);

  assert.equal(result.pointCount, 26);
  assert.ok(result.points.every((point) => point.currency === "EUR"));
});

test("produces bounded pair forecasts for all four target horizons", async () => {
  const { getBaselinePayload } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { buildPairForecast } = await vite.ssrLoadModule("/lib/model-engine.ts");
  const result = buildPairForecast(getBaselinePayload(), "EUR", "USD");

  assert.deepEqual(result.map((point) => point.horizon), [10, 30, 60, 90]);
  assert.ok(result.every((point) => point.probability > 0 && point.probability < 1));
  assert.ok(result.every((point) => point.low <= point.probability && point.probability <= point.high));
  assert.ok(result.every((point) => point.confidence > 0 && point.confidence < 1));
  assert.ok(result.every((point) => point.dispersion >= 0));
});

test("blends normalized trader and model weights", async () => {
  const { getBaselinePayload } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { effectiveModelWeights } = await vite.ssrLoadModule("/lib/model-engine.ts");
  const payload = getBaselinePayload();
  payload.model.modelBlend = 0.8;
  const weights = effectiveModelWeights(payload);

  assert.ok(Math.abs(Object.values(weights).reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.ok(weights.momentum > 0);
});

test("uses validated horizon weights while untrained horizons remain anchored to the global model", async () => {
  const { getBaselinePayload, factorMeta } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { effectiveModelWeights } = await vite.ssrLoadModule("/lib/model-engine.ts");
  const payload = getBaselinePayload();
  payload.model.modelBlend = 1;
  payload.regime.riskOffProbability = 0.5;
  payload.model.horizonWeights[10] = Object.fromEntries(Object.keys(factorMeta).map((factor) => [factor, factor === "momentum" ? 1 : 0]));
  payload.model.horizonTrainingSamples[10] = 120;
  payload.model.horizonWeights[90] = Object.fromEntries(Object.keys(factorMeta).map((factor) => [factor, factor === "policy" ? 1 : 0]));
  payload.model.horizonTrainingSamples[90] = 0;

  const short = effectiveModelWeights(payload, 10);
  const long = effectiveModelWeights(payload, 90);
  assert.ok(short.momentum > long.momentum);
  assert.ok(Math.abs(long.policy - effectiveModelWeights(payload).policy) < 1e-9);
});

test("marks low-edge forecasts neutral without changing their probability", async () => {
  const { getBaselinePayload } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { buildPairForecast } = await vite.ssrLoadModule("/lib/model-engine.ts");
  const payload = getBaselinePayload();
  const eur = payload.currencies.find((item) => item.code === "EUR");
  const usd = payload.currencies.find((item) => item.code === "USD");
  eur.factors = { ...usd.factors };
  eur.history = usd.history.map((item) => ({ ...item }));
  const forecasts = buildPairForecast(payload, "EUR", "USD");
  assert.ok(forecasts.every((item) => item.signal === "neutral"));
  assert.ok(forecasts.every((item) => item.probability > 0 && item.probability < 1));
});

test("partially pooled horizon weights stay between the global and horizon estimates", async () => {
  const { getDefaultModelSettings } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { partiallyPoolWeights } = await vite.ssrLoadModule("/lib/retraining.ts");
  const defaults = getDefaultModelSettings();
  const candidate = { ...defaults.learnedWeights, momentum: 1 };
  const pooled = partiallyPoolWeights(candidate, defaults.learnedWeights, 80, 80);
  assert.ok(pooled.momentum > defaults.learnedWeights.momentum);
  assert.ok(pooled.momentum < 1);
  assert.ok(Math.abs(Object.values(pooled).reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
});

test("retraining learns from labeled pair outcomes", async () => {
  const { getDefaultModelSettings } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { trainLearnedWeights } = await vite.ssrLoadModule("/lib/retraining.ts");
  const defaults = getDefaultModelSettings();
  const examples = Array.from({ length: 40 }, (_, index) => {
    const label = index % 2;
    return {
      label,
      features: Object.fromEntries(Object.keys(defaults.expertWeights).map((factor) => [
        factor,
        factor === "momentum" ? (label ? 0.8 : -0.8) : 0,
      ])),
    };
  });
  const trained = trainLearnedWeights(examples, defaults.learnedWeights, 200);

  assert.ok(trained.weights.momentum > defaults.learnedWeights.momentum);
  assert.ok(Math.abs(Object.values(trained.weights).reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
  assert.ok(trained.logLoss < 0.7);
});

test("walk-forward validation never trains on a future test date", async () => {
  const { getDefaultModelSettings } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { walkForwardValidate } = await vite.ssrLoadModule("/lib/retraining.ts");
  const defaults = getDefaultModelSettings();
  const examples = Array.from({ length: 90 }, (_, index) => {
    const label = index % 3 === 0 ? 1 : 0;
    const asOf = new Date(Date.UTC(2025, 0, index + 1));
    const labelEnd = new Date(asOf);
    labelEnd.setUTCDate(labelEnd.getUTCDate() + 10);
    return {
      label,
      asOf: asOf.toISOString(),
      labelEnd: labelEnd.toISOString(),
      features: Object.fromEntries(Object.keys(defaults.expertWeights).map((factor) => [
        factor,
        factor === "momentum" ? (label ? 0.7 : -0.7) : 0,
      ])),
    };
  });
  const result = walkForwardValidate(examples, defaults.learnedWeights, {
    mode: "rolling",
    minimumTrainSamples: 30,
    testSamples: 12,
    rollingTrainSamples: 45,
  });

  assert.ok(result.folds.length >= 4);
  assert.ok(result.folds.every((fold) => fold.trainEnd < fold.testStart));
  assert.ok(result.folds.some((fold) => fold.purgedSamples > 0));
  assert.ok(result.brierScore >= 0);
});

test("risk-off regimes increase the relative risk-factor weight", async () => {
  const { getBaselinePayload } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { effectiveModelWeights } = await vite.ssrLoadModule("/lib/model-engine.ts");
  const payload = getBaselinePayload();
  payload.regime.riskOffProbability = 0.1;
  const riskOn = effectiveModelWeights(payload);
  payload.regime.riskOffProbability = 0.9;
  const riskOff = effectiveModelWeights(payload);

  assert.ok(riskOff.risk > riskOn.risk);
});

test("central-bank text sentiment is normalized and auditable", async () => {
  const { scoreFinancialText, aggregateTextSignals } = await vite.ssrLoadModule("/lib/sentiment.ts");
  assert.ok(scoreFinancialText("Inflation remains persistent and policy must stay restrictive") > 0);
  assert.ok(scoreFinancialText("Weak growth and downside risk support a rate cut") < 0);
  const result = aggregateTextSignals([{
    currency: "EUR",
    source: "ECB",
    title: "Policy remains restrictive",
    summary: "Inflation pressure remains above target",
    publishedAt: new Date().toISOString(),
  }]);
  assert.ok(result.factorScore > 0.5);
  assert.equal(result.sampleCount, 1);
});

test("explainability ranks every regime-adjusted factor", async () => {
  const { getBaselinePayload, factorMeta } = await vite.ssrLoadModule("/lib/terminal-data.ts");
  const { buildFeatureExplanation } = await vite.ssrLoadModule("/lib/explainability.ts");
  const explanation = buildFeatureExplanation(getBaselinePayload(), "EUR", "USD", 30);

  assert.equal(explanation.pair, "EUR/USD");
  assert.equal(explanation.contributions.length, Object.keys(factorMeta).length);
  assert.ok(explanation.contributions[0].absoluteImportance >= explanation.contributions.at(-1).absoluteImportance);
});
