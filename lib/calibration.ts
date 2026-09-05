/** Diagnostics for archived forecasts. Never rewrites scores or fits on future outcomes. */
export const auditHorizons = [10, 30, 60, 90] as const;
export type ArchivedForecast = {
  pair: string; horizon: number; probability: number; observedAt: string; sourceMode: string;
};
export type AuditClose = { currency: string; period: string; value: number };
export type Outcome = {
  pair: string; horizon: number; probability: number; label: 0 | 1;
  asOf: string; entryDate: string; labelEnd: string;
};
const day = (value: string) => value.slice(0, 10);
const addDays = (value: string, n: number) => {
  const date = new Date(`${day(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
};
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));

export function resolveOutcomes(forecasts: ArchivedForecast[], closes: AuditClose[], now: string) {
  const series = new Map<string, Map<string, number>>();
  for (const close of closes) {
    if (!validDate(close.period) || close.period >= day(now) || !Number.isFinite(close.value) || close.value <= 0) continue;
    if (!series.has(close.currency)) series.set(close.currency, new Map());
    series.get(close.currency)!.set(close.period, close.value);
  }
  const outcomes: Outcome[] = [];
  const excluded = { baseline: 0, invalid: 0, duplicate: 0, missingEntry: 0, pending: 0, missingTarget: 0 };
  const seen = new Set<string>();
  for (const row of [...forecasts].sort((a, b) => a.observedAt.localeCompare(b.observedAt))) {
    const [base, quote] = row.pair.split("/");
    if (row.sourceMode !== "live" && row.sourceMode !== "partial-live") { excluded.baseline++; continue; }
    if (!validDate(day(row.observedAt)) || !auditHorizons.includes(row.horizon as 10) ||
      !Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1 ||
      quote !== "USD" || !base || base === quote) { excluded.invalid++; continue; }
    const key = `${row.pair}:${row.horizon}:${day(row.observedAt)}`;
    if (seen.has(key)) { excluded.duplicate++; continue; }
    seen.add(key);
    const prices = [...(series.get(base)?.entries() ?? [])].sort(([a], [b]) => a.localeCompare(b));
    // First complete daily close strictly AFTER issuance: never use an unavailable same-day close.
    const entry = prices.find(([date]) => date > day(row.observedAt) && date <= addDays(row.observedAt, 4));
    if (!entry) { excluded.missingEntry++; continue; }
    const target = addDays(entry[0], row.horizon);
    if (target >= day(now)) { excluded.pending++; continue; }
    const exit = prices.find(([date]) => date >= target && date <= addDays(target, 4));
    if (!exit) { excluded.missingTarget++; continue; }
    outcomes.push({ pair: row.pair, horizon: row.horizon, probability: row.probability,
      label: exit[1] > entry[1] ? 1 : 0, asOf: row.observedAt, entryDate: entry[0], labelEnd: exit[0] });
  }
  return { outcomes, excluded };
}

export function calibrationMetrics(rows: { probability: number; label: 0 | 1 }[]) {
  if (!rows.length) return null;
  const bins = Array.from({ length: 10 }, (_, index) => {
    const members = rows.filter((row) => Math.min(9, Math.floor(row.probability * 10)) === index);
    const n = members.length;
    const predicted = n ? members.reduce((sum, row) => sum + row.probability, 0) / n : null;
    const observed = n ? members.reduce((sum, row) => sum + row.label, 0) / n : null;
    return { lower: index / 10, upper: (index + 1) / 10, count: n,
      meanProbability: predicted, observedUpRate: observed, sparse: n < 20 };
  });
  return {
    sampleCount: rows.length,
    meanProbability: rows.reduce((sum, row) => sum + row.probability, 0) / rows.length,
    observedUpRate: rows.reduce((sum, row) => sum + row.label, 0) / rows.length,
    brierScore: rows.reduce((sum, row) => sum + (row.probability - row.label) ** 2, 0) / rows.length,
    logLoss: -rows.reduce((sum, row) => sum + (row.label ? Math.log(Math.max(1e-9, row.probability)) : Math.log(Math.max(1e-9, 1 - row.probability))), 0) / rows.length,
    expectedCalibrationError: bins.reduce((sum, bin) => sum + bin.count * Math.abs((bin.meanProbability ?? 0) - (bin.observedUpRate ?? 0)), 0) / rows.length,
    bins,
  };
}

export function nonOverlapping(rows: Outcome[]) {
  const endByPair = new Map<string, string>();
  return [...rows].sort((a, b) => a.asOf.localeCompare(b.asOf)).filter((row) => {
    if (day(row.asOf) <= (endByPair.get(row.pair) ?? "")) return false;
    endByPair.set(row.pair, row.labelEnd);
    return true;
  });
}

function temperatureScale(p: number, temperature: number) {
  const bounded = Math.max(1e-6, Math.min(1 - 1e-6, p));
  return 1 / (1 + Math.exp(-Math.log(bounded / (1 - bounded)) / temperature));
}

export function shadowCalibration(rows: Outcome[]) {
  const scored: { probability: number; label: 0 | 1 }[] = [];
  const raw: { probability: number; label: 0 | 1 }[] = [];
  const folds: { testDate: string; trainSamples: number; latestTrainingOutcome: string; temperature: number }[] = [];
  for (const date of [...new Set(rows.map((row) => day(row.asOf)))].sort()) {
    const train = nonOverlapping(rows.filter((row) => row.labelEnd < date));
    if (train.length < 40 || new Set(train.map((row) => day(row.asOf))).size < 20 || new Set(train.map((row) => row.label)).size < 2) continue;
    // A low-capacity, shrink-only candidate. All selection uses already matured history.
    let temperature = 1;
    let bestLoss = Infinity;
    for (const candidate of [1, 1.25, 1.5, 2, 3, 5]) {
      const loss = -train.reduce((sum, row) => {
        const p = temperatureScale(row.probability, candidate);
        return sum + (row.label ? Math.log(p) : Math.log(1 - p));
      }, 0) / train.length;
      if (loss < bestLoss) { bestLoss = loss; temperature = candidate; }
    }
    const test = rows.filter((row) => day(row.asOf) === date);
    raw.push(...test);
    scored.push(...test.map((row) => ({ ...row, probability: temperatureScale(row.probability, temperature) })));
    folds.push({ testDate: date, trainSamples: train.length,
      latestTrainingOutcome: train.reduce((last, row) => row.labelEnd > last ? row.labelEnd : last, ""), temperature });
  }
  return { status: scored.length ? "shadow_only" : "insufficient_history", appliedToLiveScores: false,
    rawOnSameTestRows: calibrationMetrics(raw), candidateOnSameTestRows: calibrationMetrics(scored), folds };
}

export function buildCalibrationAudit(forecasts: ArchivedForecast[], closes: AuditClose[], now = new Date().toISOString()) {
  const { outcomes, excluded } = resolveOutcomes(forecasts, closes, now);
  return {
    evaluatedAt: now, scope: "archived_refresh_pair_forecasts_vs_usd",
    outcomeDefinition: "First complete close after issuance to the first close at or up to 4 calendar days after entry + horizon; flat is not up.",
    limitations: ["Partial-live inputs may include baseline factors.", "Pairs share USD and daily forecast windows overlap; counts are not independent trials.",
      "Refresh forecasts do not cover intraday settings changes or the selectable currency-cloud benchmark.", "Historical closes may be revised by the provider."],
    excluded,
    horizons: auditHorizons.map((horizon) => {
      const rows = outcomes.filter((row) => row.horizon === horizon);
      const distinctDates = new Set(rows.map((row) => day(row.asOf))).size;
      return { horizon, status: rows.length >= 100 && distinctDates >= 30 ? "diagnostic_only" : "insufficient_history",
        distinctDates, allMatured: calibrationMetrics(rows),
        nonOverlappingPerPair: calibrationMetrics(nonOverlapping(rows)),
        byPair: Object.fromEntries([...new Set(rows.map((row) => row.pair))].map((pair) => [pair, calibrationMetrics(rows.filter((row) => row.pair === pair))])),
        shadow: shadowCalibration(rows) };
    }),
  };
}
