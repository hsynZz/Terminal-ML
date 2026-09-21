import { desc, eq } from "drizzle-orm";
import { env } from 'cloudflare:workers';
import { guardProductionPayload, type ProductionEnv } from '@/worker/production';
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
    return Response.json({status:'unavailable',reason:'Forecast storage unavailable'},{status:503});
  }

  await guardProductionPayload(env as unknown as ProductionEnv,payload);
  return Response.json({
    pair: `${base}/${quote}`,
    asOf: payload.asOf,
    forecasts: buildPairForecast(payload, base, quote),
    model: {
      version: "DETERMINISTIC_CORE + GATED_ADAPTIVE_V2",
      modelBlend: payload.model.modelBlend,
      trainingSamples: payload.model.trainingSamples,
      trainedAt: payload.model.trainedAt,
      validation: payload.model.validation,
      horizonTrainingSamples: payload.model.horizonTrainingSamples,
      horizonValidation: payload.model.horizonValidation,
      regime: payload.regime,
    },
  },{headers:{'Cache-Control':'private, no-store'}});
}
