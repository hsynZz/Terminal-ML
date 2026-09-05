import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { modelDebugLogs, terminalSettings, terminalSnapshots } from "@/db/schema";
import { buildFeatureExplanation } from "@/lib/explainability";
import {
  currencies,
  getBaselinePayload,
  hydrateTerminalPayload,
  sanitizeModelSettings,
  type CurrencyCode,
  type ModelSettings,
  type TerminalPayload,
} from "@/lib/terminal-data";

const horizons = [10, 30, 60, 90] as const;
type Horizon = (typeof horizons)[number];

function isCurrency(value: string | null): value is CurrencyCode {
  return currencies.includes(value as CurrencyCode);
}

function isHorizon(value: number): value is Horizon {
  return horizons.includes(value as Horizon);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = url.searchParams.get("base") ?? "EUR";
  const quote = url.searchParams.get("quote") ?? "USD";
  const horizon = Number(url.searchParams.get("horizon") ?? 30);
  if (!isCurrency(base) || !isCurrency(quote) || base === quote || !isHorizon(horizon)) {
    return Response.json({ error: "Use a supported pair and a 10, 30, 60 or 90 day horizon" }, { status: 400 });
  }

  let payload = getBaselinePayload();
  let history: unknown[] = [];
  try {
    const db = getDb();
    const [[latest], [savedModel]] = await Promise.all([
      db.select().from(terminalSnapshots).orderBy(desc(terminalSnapshots.asOf)).limit(1),
      db.select().from(terminalSettings).where(eq(terminalSettings.key, "model")).limit(1),
    ]);
    payload = hydrateTerminalPayload((latest?.payload as TerminalPayload | undefined) ?? payload);
    if (savedModel?.value) payload.model = sanitizeModelSettings(JSON.parse(savedModel.value) as Partial<ModelSettings>);
    if (url.searchParams.get("history") === "1") {
      history = await db.select().from(modelDebugLogs).where(and(
        eq(modelDebugLogs.pair, `${base}/${quote}`),
        eq(modelDebugLogs.horizon, horizon),
      )).orderBy(desc(modelDebugLogs.observedAt)).limit(50);
    }
  } catch {
    // Current diagnostics remain available even when history storage is unavailable.
  }

  return Response.json({
    explanation: buildFeatureExplanation(payload, base, quote, horizon),
    history,
    calibrationAudit: "/api/calibration",
    note: "Debug endpoint only; not used as a user-facing evidence panel.",
  });
}
