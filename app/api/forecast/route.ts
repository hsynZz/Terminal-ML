import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { terminalSettings, terminalSnapshots } from "@/db/schema";
import { buildPairForecast } from "@/lib/model-engine";
import {
  currencies,
  getBaselinePayload,
  hydrateTerminalPayload,
  sanitizeModelSettings,
  type CurrencyCode,
  type ModelSettings,
  type TerminalPayload,
} from "@/lib/terminal-data";

function isCurrency(value: string | null): value is CurrencyCode {
  return currencies.includes(value as CurrencyCode);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = url.searchParams.get("base");
  const quote = url.searchParams.get("quote");
  if (!isCurrency(base) || !isCurrency(quote) || base === quote) {
    return Response.json({ error: "Use two different supported currencies" }, { status: 400 });
  }

  let payload = getBaselinePayload();
  try {
    const db = getDb();
    const [[latest], [savedModel]] = await Promise.all([
      db.select().from(terminalSnapshots).orderBy(desc(terminalSnapshots.asOf)).limit(1),
      db.select().from(terminalSettings).where(eq(terminalSettings.key, "model")).limit(1),
    ]);
    payload = hydrateTerminalPayload((latest?.payload as TerminalPayload | undefined) ?? payload);
    if (savedModel?.value) payload.model = sanitizeModelSettings(JSON.parse(savedModel.value) as Partial<ModelSettings>);
  } catch {
    // Baseline remains available when storage is temporarily unavailable.
  }

  return Response.json({
    pair: `${base}/${quote}`,
    asOf: payload.asOf,
    forecasts: buildPairForecast(payload, base, quote),
    model: {
      version: "ML-H 1.2",
      modelBlend: payload.model.modelBlend,
      trainingSamples: payload.model.trainingSamples,
      trainedAt: payload.model.trainedAt,
      validation: payload.model.validation,
      horizonTrainingSamples: payload.model.horizonTrainingSamples,
      horizonValidation: payload.model.horizonValidation,
      regime: payload.regime,
    },
  });
}
