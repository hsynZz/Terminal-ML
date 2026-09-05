import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { currencyObservations, terminalSettings, terminalSnapshots } from "@/db/schema";
import { partiallyPoolWeights, trainLearnedWeights, walkForwardValidate, type TrainingExample } from "@/lib/retraining";
import {
  currencies,
  hydrateTerminalPayload,
  sanitizeModelSettings,
  type CurrencyCode,
  type FactorKey,
  type FactorScores,
  forecastHorizons,
  type ModelSettings,
  type TerminalPayload,
} from "@/lib/terminal-data";

const horizons = [10, 30, 60, 90] as const;

function day(value: string) {
  return value.slice(0, 10);
}

function addDays(value: string, amount: number) {
  const date = new Date(`${day(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export async function POST() {
  try {
    const db = getDb();
    const [snapshotRows, closeRows, [savedModel]] = await Promise.all([
      db.select().from(terminalSnapshots).orderBy(desc(terminalSnapshots.asOf)).limit(400),
      db.select().from(currencyObservations).where(eq(currencyObservations.metric, "fxCloseUsd")),
      db.select().from(terminalSettings).where(eq(terminalSettings.key, "model")).limit(1),
    ]);
    const uniqueSnapshots = new Map<string, TerminalPayload>();
    for (const row of snapshotRows.reverse()) {
      uniqueSnapshots.set(day(row.asOf), hydrateTerminalPayload(row.payload as TerminalPayload));
    }
    const closes = new Map<CurrencyCode, { period: string; value: number }[]>();
    for (const currency of currencies) closes.set(currency, []);
    for (const row of closeRows) {
      if (!currencies.includes(row.currency as CurrencyCode)) continue;
      closes.get(row.currency as CurrencyCode)?.push({ period: row.period, value: row.value });
    }
    for (const rows of closes.values()) rows.sort((a, b) => a.period.localeCompare(b.period));

    const examples: TrainingExample[] = [];
    for (const [asOf, payload] of uniqueSnapshots) {
      const usd = payload.currencies.find((currency) => currency.code === "USD");
      if (!usd) continue;
      for (const currency of payload.currencies) {
        if (currency.code === "USD") continue;
        const series = closes.get(currency.code) ?? [];
        const current = [...series].reverse().find((row) => row.period <= asOf);
        if (!current) continue;
        const features = Object.fromEntries((Object.keys(currency.factors) as FactorKey[]).map((factor) => [
          factor,
          Math.max(-1, Math.min(1, currency.factors[factor] - usd.factors[factor])),
        ])) as FactorScores;
        for (const horizon of horizons) {
          const future = series.find((row) => row.period >= addDays(asOf, horizon));
          if (!future) continue;
          examples.push({
            features,
            label: future.value > current.value ? 1 : 0,
            asOf,
            pair: `${currency.code}/USD`,
            labelEnd: future.period,
            horizon,
          });
        }
      }
    }

    if (examples.length < 60) {
      return Response.json({ status: "waiting", samples: examples.length, minimum: 60, validation: "walk-forward" });
    }
    const currentModel = savedModel?.value
      ? sanitizeModelSettings(JSON.parse(savedModel.value) as Partial<ModelSettings>)
      : sanitizeModelSettings();
    let validation;
    try {
      validation = walkForwardValidate(examples, currentModel.learnedWeights, {
        mode: "expanding",
        minimumTrainSamples: 40,
        testSamples: Math.max(14, Math.ceil((examples.length - 40) / 6)),
        maxFolds: 6,
      });
    } catch {
      return Response.json({
        status: "waiting",
        samples: examples.length,
        minimum: 60,
        validation: "needs more distinct chronological periods",
      });
    }
    const trained = trainLearnedWeights(examples, currentModel.learnedWeights);
    const validatedAt = new Date().toISOString();
    const horizonWeights = { ...currentModel.horizonWeights };
    const horizonTrainingSamples = { ...currentModel.horizonTrainingSamples };
    const horizonValidation = { ...currentModel.horizonValidation };
    for (const horizon of forecastHorizons) {
      const horizonExamples = examples.filter((example) => example.horizon === horizon);
      const distinctDates = new Set(horizonExamples.map((example) => day(example.asOf ?? ""))).size;
      if (horizonExamples.length < 100 || distinctDates < 30) continue;
      try {
        const horizonWalkForward = walkForwardValidate(horizonExamples, trained.weights, {
          mode: "expanding", minimumTrainSamples: 60, testSamples: 14, maxFolds: 6,
        });
        const horizonTrained = trainLearnedWeights(horizonExamples, trained.weights);
        horizonWeights[horizon] = partiallyPoolWeights(horizonTrained.weights, trained.weights, horizonExamples.length);
        horizonTrainingSamples[horizon] = horizonExamples.length;
        horizonValidation[horizon] = { ...horizonWalkForward, folds: horizonWalkForward.folds.length, validatedAt };
      } catch {
        // Preserve the previous validated horizon model until enough chronological outcomes exist.
      }
    }
    const nextModel = sanitizeModelSettings({
      ...currentModel,
      learnedWeights: trained.weights,
      horizonWeights,
      horizonTrainingSamples,
      horizonValidation,
      trainedAt: validatedAt,
      trainingSamples: examples.length,
      validation: {
        mode: validation.mode,
        folds: validation.folds.length,
        sampleCount: validation.sampleCount,
        accuracy: validation.accuracy,
        logLoss: validation.logLoss,
        brierScore: validation.brierScore,
        validatedAt,
      },
    });
    const now = new Date().toISOString();
    await db.insert(terminalSettings).values({ key: "model", value: JSON.stringify(nextModel), updatedAt: now }).onConflictDoUpdate({
      target: terminalSettings.key,
      set: { value: JSON.stringify(nextModel), updatedAt: now },
    });
    return Response.json({
      status: "trained",
      samples: examples.length,
      trainingLogLoss: trained.logLoss,
      walkForward: nextModel.validation,
      folds: validation.folds,
      horizons: forecastHorizons.map((horizon) => ({
        horizon,
        samples: nextModel.horizonTrainingSamples[horizon],
        validation: nextModel.horizonValidation[horizon] ?? null,
      })),
      trainedAt: nextModel.trainedAt,
    });
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
