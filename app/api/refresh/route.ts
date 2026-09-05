import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { currencyObservations, evidenceEntries, modelDebugLogs, terminalSettings, terminalSnapshots } from "@/db/schema";
import { buildFeatureExplanation } from "@/lib/explainability";
import { effectiveModelWeights } from "@/lib/model-engine";
import { detectMarketRegime } from "@/lib/regime";
import { aggregateTextSignals, centralBankFeeds, extractFeedItems } from "@/lib/sentiment";
import { buildEvidence, getBaselinePayload, hydrateTerminalPayload, rebuildDerivedScores, sanitizeModelSettings, type CurrencyCode, type ModelSettings, type TerminalPayload } from "@/lib/terminal-data";
import { berlinRefreshParts, canReuseRefresh } from "@/lib/refresh-policy";

const countryMap: Record<CurrencyCode, string> = {
  USD: "USA", EUR: "EMU", GBP: "GBR", JPY: "JPN", CHF: "CHE", CAD: "CAN", AUD: "AUS", NZD: "NZL",
};

const indicatorMap = {
  inflation: "FP.CPI.TOTL.ZG",
  growth: "NY.GDP.MKTP.KD.ZG",
  unemployment: "SL.UEM.TOTL.ZS",
  currentAccount: "BN.CAB.XOKA.GD.ZS",
  debt: "GC.DOD.TOTL.GD.ZS",
} as const;

const fredSeries = {
  rate: "DFF",
  yield2y: "DGS2",
  yield10y: "DGS10",
} as const;

async function latestWorldBank(country: string, indicator: string) {
  const url = `https://api.worldbank.org/v2/country/${country}/indicator/${indicator}?format=json&per_page=8`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  const body = await response.json() as [unknown, { value: number | null; date: string }[]];
  const row = body?.[1]?.find((item) => typeof item.value === "number");
  return row ? { value: row.value as number, period: row.date } : null;
}

async function latestFred(apiKey: string, seriesId: string) {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: "json",
    sort_order: "desc",
    limit: "12",
  });
  const response = await fetch(`https://api.stlouisfed.org/fred/series/observations?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const body = await response.json() as { observations?: { value: string; date: string }[] };
  const row = body.observations?.find((item) => item.value !== "." && Number.isFinite(Number(item.value)));
  return row ? { value: Number(row.value), period: row.date } : null;
}

async function alphaMomentum(apiKey: string, currency: Exclude<CurrencyCode, "USD">) {
  const params = new URLSearchParams({
    function: "FX_DAILY",
    from_symbol: currency,
    to_symbol: "USD",
    outputsize: "compact",
    apikey: apiKey,
  });
  const response = await fetch(`https://www.alphavantage.co/query?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) return null;
  const body = await response.json() as Record<string, unknown>;
  const timeSeries = body["Time Series FX (Daily)"] as Record<string, { "4. close"?: string }> | undefined;
  if (!timeSeries) return null;
  const rows = Object.entries(timeSeries)
    .map(([period, values]) => ({ period, close: Number(values["4. close"]) }))
    .filter((row) => Number.isFinite(row.close) && row.close > 0)
    .sort((a, b) => b.period.localeCompare(a.period));
  if (rows.length < 2) return null;
  const latest = rows[0];
  const day20 = rows[Math.min(19, rows.length - 1)];
  const day60 = rows[Math.min(59, rows.length - 1)];
  const shortReturn = Math.log(latest.close / day20.close);
  const longReturn = Math.log(latest.close / day60.close);
  const score = Math.max(0.05, Math.min(0.95, 0.5 + shortReturn * 4.5 + longReturn * 2.2));
  return { close: latest.close, period: latest.period, score, closes: rows };
}

async function centralBankSignals() {
  const results = await Promise.allSettled(centralBankFeeds.map(async (feed) => {
    const response = await fetch(feed.url, {
      headers: { Accept: "application/rss+xml, application/atom+xml, text/xml, application/xml" },
    });
    if (!response.ok) throw new Error(`feed unavailable: ${feed.source}`);
    return extractFeedItems(await response.text(), feed);
  }));
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

export async function POST(request: Request) {
  let previous: TerminalPayload | undefined;
  try {
    const db = getDb();
    const [latest] = await db.select().from(terminalSnapshots).orderBy(desc(terminalSnapshots.asOf)).limit(1);
    if (latest) previous = hydrateTerminalPayload(latest.payload as TerminalPayload);
    if (previous && previous.sourceMode !== "baseline" && canReuseRefresh(previous.asOf)) {
      const [model] = await db.select().from(terminalSettings).where(eq(terminalSettings.key, "model")).limit(1);
      if (model?.value) previous.model = sanitizeModelSettings(JSON.parse(model.value));
      return Response.json(previous, { headers: { "Cache-Control": "private, no-store", "X-FX-Refresh": "reused-recent-snapshot" } });
    }
  } catch {
    return Response.json({ status: "unavailable", reason: "Snapshot storage unavailable" }, { status: 503 });
  }
  if (request.headers.has("x-fx-schedule")) {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
    if (part("hour") * 60 + part("minute") < 17 * 60 + 15) {
      return Response.json({ status: "waiting-for-berlin-cutoff" });
    }
    try {
      const db = getDb();
      const [latest] = await db.select().from(terminalSnapshots).orderBy(desc(terminalSnapshots.asOf)).limit(1);
      const today = `${part("year")}-${String(part("month")).padStart(2, "0")}-${String(part("day")).padStart(2, "0")}`;
      const latestDay = latest?.asOf
        ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(latest.asOf))
        : null;
      if (latestDay === today && latest?.asOf && berlinRefreshParts(new Date(latest.asOf)).afterCutoff) {
        return Response.json({ status: "already-current", asOf: latest.asOf });
      }
    } catch {
      // Continue: persistence failure must not suppress the scheduled data attempt.
    }
  }
  const payload = previous ? structuredClone(previous) : getBaselinePayload();
  let liveValues = 0;
  let fredValues = 0;
  let alphaValues = 0;
  let nlpValues = 0;
  let vix: number | null = payload.regime.vix;
  const observations: { currency: string; metric: string; value: number; period: string; source: string; observedAt: string }[] = [];

  try {
    const db = getDb();
    const [savedModel] = await db.select().from(terminalSettings).where(eq(terminalSettings.key, "model")).limit(1);
    if (savedModel?.value) payload.model = sanitizeModelSettings(JSON.parse(savedModel.value) as Partial<ModelSettings>);
  } catch {
    // Use the stable default blend when settings storage is unavailable.
  }

  await Promise.all(payload.currencies.map(async (currency) => {
    const entries = await Promise.all(Object.entries(indicatorMap).map(async ([metric, indicator]) => {
      const result = await latestWorldBank(countryMap[currency.code], indicator);
      return [metric, result] as const;
    }));
    for (const [metric, result] of entries) {
      if (!result) continue;
      (currency as unknown as Record<string, unknown>)[metric] = result.value;
      liveValues += 1;
      observations.push({ currency: currency.code, metric, value: result.value, period: result.period, source: "World Bank Open Data", observedAt: new Date().toISOString() });
    }
  }));

  const fredApiKey = (env as unknown as { FRED_API_KEY?: string }).FRED_API_KEY;
  if (fredApiKey) {
    const usd = payload.currencies.find((currency) => currency.code === "USD");
    if (usd) {
      const entries = await Promise.all(Object.entries(fredSeries).map(async ([metric, seriesId]) => {
        const result = await latestFred(fredApiKey, seriesId);
        return [metric, result] as const;
      }));
      for (const [metric, result] of entries) {
        if (!result) continue;
        (usd as unknown as Record<string, unknown>)[metric] = result.value;
        fredValues += 1;
        observations.push({
          currency: "USD",
          metric,
          value: result.value,
          period: result.period,
          source: "FRED",
          observedAt: new Date().toISOString(),
        });
      }
    }
    const vixObservation = await latestFred(fredApiKey, "VIXCLS");
    if (vixObservation) {
      vix = vixObservation.value;
      fredValues += 1;
      observations.push({
        currency: "GLOBAL",
        metric: "vix",
        value: vixObservation.value,
        period: vixObservation.period,
        source: "FRED",
        observedAt: new Date().toISOString(),
      });
    }
  }

  const alphaApiKey = (env as unknown as { ALPHA_VANTAGE_API_KEY?: string }).ALPHA_VANTAGE_API_KEY;
  if (alphaApiKey) {
    const nonUsd = payload.currencies.filter((currency): currency is typeof currency & { code: Exclude<CurrencyCode, "USD"> } => currency.code !== "USD");
    const results = await Promise.all(nonUsd.map(async (currency) => ({
      currency,
      result: await alphaMomentum(alphaApiKey, currency.code),
    })));
    const receivedAt = new Date().toISOString();
    for (const { currency, result } of results) {
      if (!result) continue;
      currency.factors.momentum = result.score;
      alphaValues += 1;
      observations.push(
        { currency: currency.code, metric: "momentum", value: result.score, period: result.period, source: "Alpha Vantage", observedAt: receivedAt },
      );
      observations.push(...result.closes.map((row) => ({
        currency: currency.code,
        metric: "fxCloseUsd",
        value: row.close,
        period: row.period,
        source: "Alpha Vantage",
        observedAt: receivedAt,
      })));
    }
    const usd = payload.currencies.find((currency) => currency.code === "USD");
    const scored = results.flatMap(({ result }) => result ? [result.score] : []);
    if (usd && scored.length) {
      usd.factors.momentum = 1 - scored.reduce((sum, score) => sum + score, 0) / scored.length;
      alphaValues += 1;
    }
  }

  const textSignals = await centralBankSignals();
  // Age weights change by day, not by the millisecond of a button click.
  const sentimentAt = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  for (const currency of payload.currencies) {
    const items = textSignals.filter((item) => item.currency === currency.code);
    if (!items.length) continue;
    const sentiment = aggregateTextSignals(items, sentimentAt);
    currency.factors.sentiment = sentiment.factorScore;
    nlpValues += sentiment.sampleCount;
    observations.push({
      currency: currency.code,
      metric: "nlpSentiment",
      value: sentiment.factorScore,
      period: sentimentAt.toISOString().slice(0, 10),
      source: "Official central bank RSS",
      observedAt: sentimentAt.toISOString(),
    });
  }

  rebuildDerivedScores(payload.currencies);
  const refreshedAt = new Date().toISOString();
  payload.regime = detectMarketRegime(vix, payload.currencies, refreshedAt);
  const totalLiveValues = liveValues + fredValues + alphaValues + nlpValues;
  if (totalLiveValues === 0) {
    return Response.json({ status: "unavailable", reason: "No fresh source data; last snapshot retained" }, { status: 503 });
  }
  const refreshed: TerminalPayload = {
    ...payload,
    asOf: refreshedAt,
    sourceMode: totalLiveValues > 0 ? "partial-live" : "baseline",
    evidence: buildEvidence(
      payload.currencies,
      refreshedAt,
      totalLiveValues > 0 ? "Live sources + hybrid model" : "Model baseline",
      effectiveModelWeights(payload),
    ),
    sources: payload.sources.map((source) => {
      if (source.name === "World Bank Open Data") {
        return { ...source, status: liveValues > 0 ? "connected" as const : "ready" as const, detail: `${liveValues} aktuelle Makro-Beobachtungen geladen` };
      }
      if (source.name === "FRED") {
        return {
          ...source,
          status: fredValues > 0 ? "connected" as const : fredApiKey ? "ready" as const : "missing" as const,
          detail: fredValues > 0
            ? `${fredValues} aktuelle US-Zinsreihen geladen`
            : fredApiKey
              ? "API-Key aktiv · Abruf derzeit ohne neue Beobachtung"
              : "Zinsen und US-Renditen – API-Key nicht hinterlegt",
        };
      }
      if (source.name === "Alpha Vantage") {
        return {
          ...source,
          status: alphaValues > 0 ? "connected" as const : alphaApiKey ? "ready" as const : "missing" as const,
          detail: alphaValues > 0
            ? `${alphaValues} FX-Momentum-Scores aktualisiert`
            : alphaApiKey
              ? "API-Key aktiv · Abruf derzeit ohne neue Kurse"
              : "FX-Tageskurse und Momentum – API-Key nicht hinterlegt",
        };
      }
      if (source.name === "Zentralbanken") {
        return {
          ...source,
          status: nlpValues > 0 ? "connected" as const : "ready" as const,
          detail: nlpValues > 0
            ? `${nlpValues} offizielle Veröffentlichungen als NLP-Signal aggregiert`
            : "Offizielle RSS-Feeds aktiv · derzeit kein verwertbarer Text",
        };
      }
      return source;
    }),
  };

  try {
    const db = getDb();
    if (observations.length) {
      // D1 permits at most 100 bound parameters per statement.
      for (let index = 0; index < observations.length; index += 10) {
        await db.insert(currencyObservations).values(observations.slice(index, index + 10)).onConflictDoUpdate({
          target: [currencyObservations.currency, currencyObservations.metric, currencyObservations.period, currencyObservations.source],
          set: { value: currencyObservations.value, observedAt: refreshedAt },
        });
      }
    }
    const evidenceRows = refreshed.evidence.map((item) => ({
      pair: item.currency,
      factor: item.factor,
      score: item.score,
      weight: item.weight,
      observedAt: item.observedAt,
      source: item.source,
    }));
    for (let index = 0; index < evidenceRows.length; index += 10) {
      await db.insert(evidenceEntries).values(evidenceRows.slice(index, index + 10));
    }
    const debugRows = refreshed.currencies
      .filter((currency) => currency.code !== "USD")
      .flatMap((currency) => ([10, 30, 60, 90] as const).flatMap((horizon) => {
        const explanation = buildFeatureExplanation(refreshed, currency.code, "USD", horizon);
        return explanation ? [{
          pair: explanation.pair,
          baseCurrency: explanation.base,
          quoteCurrency: explanation.quote,
          horizon: explanation.horizon,
          probability: explanation.probability,
          confidence: explanation.confidence,
          regime: explanation.regime.label,
          contributions: explanation.contributions,
          observedAt: explanation.observedAt,
        }] : [];
      }));
    for (let index = 0; index < debugRows.length; index += 10) {
      await db.insert(modelDebugLogs).values(debugRows.slice(index, index + 10));
    }
    // Publish the reusable snapshot only after its supporting records are stored.
    await db.insert(terminalSnapshots).values({
      asOf: refreshed.asOf,
      sourceMode: refreshed.sourceMode,
      payload: refreshed,
    });
  } catch {
    return Response.json({ status: "unavailable", reason: "Refresh could not be fully archived" }, { status: 503 });
  }

  return Response.json(refreshed);
}
