import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const root = fileURLToPath(new URL("..", import.meta.url));
const vite = await createServer({ appType: "custom", configFile: false, root,
  resolve: { alias: { "@": root } }, server: { middlewareMode: true } });
after(() => vite.close());
const { calibrationMetrics, resolveOutcomes, buildCalibrationAudit, shadowCalibration } = await vite.ssrLoadModule("/lib/calibration.ts");

test("70 percent forecast is compared with observed frequency; endpoints and empty bins are safe", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ probability: 0.7, label: i < 70 ? 1 : 0 }));
  const report = calibrationMetrics(rows);
  assert.ok(Math.abs(report.expectedCalibrationError) < 1e-12);
  assert.ok(Math.abs(report.brierScore - 0.21) < 1e-12);
  assert.equal(report.bins[7].count, 100);
  assert.equal(report.bins[0].observedUpRate, null);
  assert.equal(calibrationMetrics([]), null);
  assert.ok(Number.isFinite(calibrationMetrics([{ probability: 1, label: 0 }]).logLoss));
});

test("archive evaluation excludes baseline, duplicates, immature and incomplete daily closes", () => {
  const first = { pair: "EUR/USD", horizon: 10, probability: 0.72, observedAt: "2025-01-01T12:00:00Z", sourceMode: "partial-live" };
  const closes = [
    { currency: "EUR", period: "2025-01-01", value: 10 },
    { currency: "EUR", period: "2025-01-02", value: 1 },
    { currency: "EUR", period: "2025-01-13", value: 2 },
  ];
  const result = resolveOutcomes([first, first, { ...first, sourceMode: "baseline" }, { ...first, horizon: 90 }], closes, "2025-01-14T00:00:00Z");
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0].label, 1);
  assert.equal(result.outcomes[0].entryDate, "2025-01-02");
  assert.equal(result.excluded.baseline, 1);
  assert.equal(result.excluded.duplicate, 1);
  assert.equal(result.excluded.pending, 1);
  assert.equal(resolveOutcomes([first], closes, "2025-01-13T23:00:00Z").outcomes.length, 0);
  assert.ok(buildCalibrationAudit([], []).horizons.every((row) => row.status === "insufficient_history" && row.allMatured === null));
});

test("shadow calibration only learns matured past outcomes and never applies to live scores", () => {
  const date = (n) => new Date(Date.UTC(2020, 0, n + 1)).toISOString().slice(0, 10);
  const rows = Array.from({ length: 70 }, (_, i) => ({ pair: "EUR/USD", horizon: 10,
    probability: 0.9, label: i % 2, asOf: date(i * 15), entryDate: date(i * 15 + 1), labelEnd: date(i * 15 + 11) }));
  const result = shadowCalibration(rows);
  assert.ok(result.folds.length > 0);
  assert.ok(result.folds.every((fold) => fold.latestTrainingOutcome < fold.testDate));
  assert.equal(result.appliedToLiveScores, false);
  assert.equal(result.rawOnSameTestRows.sampleCount, result.candidateOnSameTestRows.sampleCount);
  const changedFuture = shadowCalibration(rows.map((row, i) => i >= 60 ? { ...row, label: 1 } : row));
  assert.deepEqual(result.folds.slice(0, 10), changedFuture.folds.slice(0, 10));
  assert.equal(shadowCalibration(rows.slice(0, 10)).status, "insufficient_history");
});
