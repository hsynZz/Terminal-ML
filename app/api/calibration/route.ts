import { and, asc, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { currencyObservations, modelDebugLogs, terminalSnapshots } from "@/db/schema";
import { buildCalibrationAudit } from "@/lib/calibration";

export async function GET() {
  try {
    const db = getDb();
    // Bound reads to the latest two years. No score recalculation using today's model.
    const since = new Date(Date.now() - 730 * 86400000).toISOString();
    const [forecasts, closes] = await Promise.all([
      db.select({ pair: modelDebugLogs.pair, horizon: modelDebugLogs.horizon,
        probability: modelDebugLogs.probability, observedAt: modelDebugLogs.observedAt,
        sourceMode: terminalSnapshots.sourceMode })
        .from(modelDebugLogs).innerJoin(terminalSnapshots, eq(modelDebugLogs.observedAt, terminalSnapshots.asOf))
        .where(gt(modelDebugLogs.observedAt, since)).orderBy(asc(modelDebugLogs.observedAt)).limit(25000),
      db.select({ currency: currencyObservations.currency, period: currencyObservations.period, value: currencyObservations.value })
        .from(currencyObservations).where(and(eq(currencyObservations.metric, "fxCloseUsd"),
          eq(currencyObservations.source, "Alpha Vantage"), gt(currencyObservations.period, since.slice(0, 10))))
        .orderBy(asc(currencyObservations.period)).limit(10000),
    ]);
    return Response.json({ ...buildCalibrationAudit(forecasts, closes),
      windowStart: since, readLimitReached: forecasts.length === 25000 || closes.length === 10000,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ status: "unavailable", reason: "Calibration history could not be read; no baseline metrics substituted." }, { status: 503 });
  }
}
