import { env } from "cloudflare:workers";
import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { currencyObservations, evidenceEntries, modelDebugLogs, terminalSettings, terminalSnapshots } from "@/db/schema";
import { buildFeatureExplanation } from "@/lib/explainability";
import { effectiveModelWeights } from "@/lib/model-engine";
import { detectMarketRegime } from "@/lib/regime";
import { aggregateTextSignals, centralBankFeeds, extractFeedItems } from "@/lib/sentiment";
import { buildEvidence, getBaselinePayload, hydrateTerminalPayload, sanitizeModelSettings, type CurrencyCode, type ModelSettings, type TerminalPayload } from "@/lib/terminal-data";
import { berlinRefreshParts, canReuseRefresh } from "@/lib/refresh-policy";
import { repairDerivedScores, historicalScores, truthfulEvidence, parseEcbRates, momentumFromObservations, observationQuality, type Observation, type ProductionPayload, type SourceCheck } from '@/lib/production-data';
import { sourceAttempt, sourceFetch } from '@/lib/source-health';
import { prepareProductionSnapshot, productionFailure } from '@/worker/production';
import { collectProxies } from '@/worker/proxy-discovery';
import { captureProvenance, type ProvenancePayload, type Receipt } from "@/lib/hypothesis/provenance";

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
  const response = await sourceFetch(url);
  if (!response.ok) return null;
  const body = await response.json() as [unknown, { value: number | null; date: string }[]];
  const row = body?.[1]?.find((item) => typeof item.value === "number" && Number.isFinite(item.value) && item.date<=new Date().toISOString().slice(0,4));
  return row ? { value: row.value as number, period: row.date, receivedAt: new Date().toISOString(),sourceUrl:`https://api.worldbank.org/v2/country/${country}/indicator/${indicator}` } : null;
}

async function latestFred(apiKey: string, seriesId: string) {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: apiKey,
    file_type: "json",
    sort_order: "desc",
    limit: "12",
  });
  const response = await sourceFetch(`https://api.stlouisfed.org/fred/series/observations?${params}`);
  if (!response.ok) return null;
  const body = await response.json() as { observations?: { value: string; date: string }[] };
  const row = body.observations?.find((item) => item.value !== "." && Number.isFinite(Number(item.value)));
  return row && row.date<=new Date().toISOString().slice(0,10) ? { value: Number(row.value), period: row.date, receivedAt: new Date().toISOString(),sourceUrl:`https://fred.stlouisfed.org/series/${seriesId}` } : null;
}

async function alphaMomentum(apiKey: string, currency: Exclude<CurrencyCode, "USD">) {
  const params = new URLSearchParams({
    function: "FX_DAILY",
    from_symbol: currency,
    to_symbol: "USD",
    outputsize: "compact",
    apikey: apiKey,
  });
  const response = await sourceFetch(`https://www.alphavantage.co/query?${params}`);
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
  return { close: latest.close, period: latest.period, score, closes: rows, receivedAt: new Date().toISOString() };
}

async function centralBankSignals(checks:SourceCheck[]) {
  const results = await Promise.allSettled(centralBankFeeds.map(async (feed) => sourceAttempt(checks,feed.source,feed.url,feed.currency,["nlpSentiment"],async()=>{
    const response = await sourceFetch(feed.url,"application/rss+xml, application/atom+xml, text/xml, application/xml");
    if (!response.ok) throw new Error(`feed unavailable: ${feed.source}`);
    return extractFeedItems(await response.text(), feed);
  })));
  return results.flatMap((result) => result.status === "fulfilled" ? result.value??[] : []);
}

function validateInput<T extends {value:number;period:string;receivedAt:string}>(metric:string,value:T|null){if(value&&observationQuality(metric,value.value,value.period,value.receivedAt)!=='VALID')throw new Error('INVALID_RESPONSE');return value;}

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
  const payload:ProductionPayload = previous ? structuredClone(previous) : getBaselinePayload();
  for(const c of payload.currencies)delete c.evidenceAttribution;
  const sourceChecks:SourceCheck[]=[];
  const vintageRows:Observation[]=[];
  let liveValues = 0;
  let fredValues = 0;
  let alphaValues = 0;
  let nlpValues = 0;
  let vix: number | null = payload.regime.vix;
  const receipts: Receipt[] = [];
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
      const result = await sourceAttempt(sourceChecks,"World Bank Open Data",`https://api.worldbank.org/v2/country/${countryMap[currency.code]}/indicator/${indicator}`,currency.code,[metric],async()=>validateInput(metric,await latestWorldBank(countryMap[currency.code], indicator)));
      return [metric, result] as const;
    }));
    for (const [metric, result] of entries) {
      if (!result || observationQuality(metric,result.value,result.period,result.receivedAt)==='INVALID') continue;
      (currency as unknown as Record<string, unknown>)[metric] = result.value;
      liveValues += 1;
      receipts.push({currency:currency.code,metric,value:result.value,period:result.period,source:"World Bank Open Data",sourceUrl:result.sourceUrl,receivedAt:result.receivedAt});
      observations.push({ currency: currency.code, metric, value: result.value, period: result.period, source: "World Bank Open Data", observedAt: new Date().toISOString() });
    }
  }));

  const fredApiKey = (env as unknown as { FRED_API_KEY?: string }).FRED_API_KEY;
  if (fredApiKey) {
    const usd = payload.currencies.find((currency) => currency.code === "USD");
    if (usd) {
      const entries = await Promise.all(Object.entries(fredSeries).map(async ([metric, seriesId]) => {
        const result = await sourceAttempt(sourceChecks,"FRED",`https://fred.stlouisfed.org/series/${seriesId}`,"USD",[metric],async()=>validateInput(metric,await latestFred(fredApiKey, seriesId)));
        return [metric, result] as const;
      }));
      for (const [metric, result] of entries) {
        if (!result || observationQuality(metric,result.value,result.period,result.receivedAt)==='INVALID') continue;
        (usd as unknown as Record<string, unknown>)[metric] = result.value;
        fredValues += 1;
        receipts.push({currency:"USD",metric,value:result.value,period:result.period,source:"FRED",sourceUrl:result.sourceUrl,receivedAt:result.receivedAt});
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
    const vixObservation = await sourceAttempt(sourceChecks,"FRED","https://fred.stlouisfed.org/series/VIXCLS","GLOBAL",["vix"],async()=>validateInput("vix",await latestFred(fredApiKey, "VIXCLS")));
    if (vixObservation && observationQuality('vix',vixObservation.value,vixObservation.period,vixObservation.receivedAt)==='VALID') {
      vix = vixObservation.value;
      receipts.push({currency:"GLOBAL",metric:"vix",value:vixObservation.value,period:vixObservation.period,source:"FRED",sourceUrl:vixObservation.sourceUrl,receivedAt:vixObservation.receivedAt});
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
      result: await sourceAttempt(sourceChecks,"Alpha Vantage","https://www.alphavantage.co/documentation/#fx-daily",currency.code,["momentum","fxCloseUsd"],()=>alphaMomentum(alphaApiKey, currency.code)),
    })));
    const receivedAt = new Date().toISOString();
    for (const { currency, result } of results) {
      if (!result || observationQuality('momentum',result.score,result.period,result.receivedAt)!=='VALID') continue;
      currency.factors.momentum = result.score;
      receipts.push({currency:currency.code,metric:"momentum",value:result.score,period:result.period,source:"Alpha Vantage",receivedAt:result.receivedAt,observations:result.closes.map(r=>({period:r.period,value:r.close}))});
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
    const scored = results.flatMap(({ result }) => result && observationQuality('momentum',result.score,result.period,result.receivedAt)==='VALID' ? [result.score] : []);
    if (usd && scored.length) {
      usd.factors.momentum = 1 - scored.reduce((sum, score) => sum + score, 0) / scored.length;
      alphaValues += 1;
    }
  }

  const ecbRows=await sourceAttempt(sourceChecks,"ECB reference fixing","https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml","ALL",["fxReferenceUsd","momentum"],async()=>{
    const response=await sourceFetch("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml","application/xml");
    const rows=parseEcbRates(await response.text(),new Date().toISOString());return rows.length?rows:null;
  });
  if(ecbRows){
    vintageRows.push(...ecbRows);
    for(const currency of payload.currencies){
      if(currency.code==="USD"||receipts.some(r=>r.currency===currency.code&&r.metric==="momentum"))continue;
      const score=momentumFromObservations(ecbRows,currency.code);
      if(score===null)continue;
      currency.factors.momentum=score;
      const latest=ecbRows.filter(r=>r.currency===currency.code).sort((a,b)=>b.period.localeCompare(a.period))[0];
      receipts.push({currency:currency.code,metric:"momentum",value:score,period:latest.period,source:"ECB reference fixing",receivedAt:latest.receivedAt,observations:ecbRows.filter(r=>r.currency===currency.code).map(r=>({period:r.period,value:r.value}))});alphaValues++;
    }
    const usd=payload.currencies.find(c=>c.code==="USD");
    const scores=payload.currencies.filter(c=>c.code!=="USD"&&receipts.some(r=>r.currency===c.code&&r.metric==="momentum"));
    if(usd&&scores.length===7){usd.factors.momentum=1-scores.reduce((n,c)=>n+c.factors.momentum,0)/7;receipts.push({currency:'USD',metric:'momentum',value:usd.factors.momentum,period:ecbRows[0].period,source:'ECB reference fixing',receivedAt:new Date().toISOString()});}
  }
  const textSignals = await centralBankSignals(sourceChecks);
  // Age weights change by day, not by the millisecond of a button click.
  const sentimentAt = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  for (const currency of payload.currencies) {
    const items = textSignals.filter((item) => item.currency === currency.code);
    if (!items.length) continue;
    const sentiment = aggregateTextSignals(items, sentimentAt);
    currency.factors.sentiment = sentiment.factorScore;
    receipts.push({currency:currency.code,metric:"nlpSentiment",value:sentiment.factorScore,period:sentimentAt.toISOString().slice(0,10),source:"Official central bank RSS",sourceUrl:centralBankFeeds.filter(f=>f.currency===currency.code).map(f=>f.url).join(" "),receivedAt:new Date().toISOString()});
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

  repairDerivedScores(payload);
  const refreshedAt = new Date().toISOString();
  payload.regime = detectMarketRegime(vix, payload.currencies, refreshedAt);
  const totalLiveValues = liveValues + fredValues + alphaValues + nlpValues + (ecbRows?.length??0);
  if (totalLiveValues === 0) {
    await productionFailure(env as unknown as Parameters<typeof productionFailure>[0],refreshedAt,'ALL_SOURCES_FAILED');
    return Response.json({ status: "unavailable", reason: "No fresh source data; last snapshot retained" }, { status: 503 });
  }
  const refreshed: ProductionPayload = {
    ...payload,
    sourceChecks,
    asOf: refreshedAt,
    events: [],
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
          status: receipts.some(r=>r.source==="Alpha Vantage") ? "connected" as const : alphaApiKey ? "ready" as const : "missing" as const,
          detail: receipts.some(r=>r.source==="Alpha Vantage")
            ? `${receipts.filter(r=>r.source==="Alpha Vantage").length} FX-Momentum-Scores aktualisiert`
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

  for(const receipt of receipts){
    const sourceUrl=receipt.sourceUrl??(receipt.source==="FRED"?"https://fred.stlouisfed.org/":receipt.source==="World Bank Open Data"?"https://api.worldbank.org/v2/":receipt.source==="ECB reference fixing"?"https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml":receipt.source==="Alpha Vantage"?"https://www.alphavantage.co/documentation/#fx-daily":"https://www.bis.org/cbanks.htm");
    const quality=observationQuality(receipt.metric,receipt.value,receipt.period,refreshedAt);
    vintageRows.push({...receipt,sourceUrl,unit:["momentum","nlpSentiment"].includes(receipt.metric)?"normalized score":"percent",releaseDate:null,frequency:receipt.period.length===4?"annual":"daily-or-release",quality});
    for(const point of receipt.observations??[])vintageRows.push({...receipt,value:point.value,period:point.period,metric:receipt.source==="ECB reference fixing"?"fxReferenceUsd":"fxCloseUsd",observations:undefined,sourceUrl,unit:"USD per currency",releaseDate:null,frequency:"business-daily",quality:observationQuality("fxCloseUsd",point.value,point.period,refreshedAt)});
  }
  try{vintageRows.push(...await collectProxies((env as unknown as Parameters<typeof prepareProductionSnapshot>[0]).DB,sourceChecks,new Date().toISOString()));}
  catch{sourceChecks.push({at:new Date().toISOString(),source:'Proxy discovery',url:'https://api.worldbank.org/v2/indicator',currency:'ALL',metrics:['proxy.catalog'],status:'FAILED',cause:'CATALOG_UNAVAILABLE',fallback:'No proxy influence',latencyMs:0});}
  refreshed.asOf=new Date().toISOString();
  truthfulEvidence(refreshed,receipts);
  refreshed.observationSummary={count:vintageRows.length,changed:receipts.filter(r=>{const before=previous?.currencies.find(c=>c.code===r.currency);return before&&(before as unknown as Record<string,unknown>)[r.metric]!==r.value;}).length,failedSources:[...new Set(sourceChecks.filter(c=>c.status!=='SUCCESS').map(c=>c.source))]};
  try{
    const history=await getDb().select().from(terminalSnapshots).orderBy(desc(terminalSnapshots.asOf)).limit(400);
    historicalScores(refreshed,history.map(r=>hydrateTerminalPayload(r.payload as TerminalPayload)));
  }catch{return Response.json({status:"unavailable",reason:"Historical inputs unavailable"},{status:503});}
  // Metadata failure must not change core refresh success or reuse a stale certificate.
  delete (refreshed as ProvenancePayload).inputProvenance;
  try { (refreshed as ProvenancePayload).inputProvenance = await captureProvenance(refreshed,previous as ProvenancePayload | undefined,receipts); }
  catch { /* Missing provenance fails closed in research. */ }

  try {
    const db = getDb();
    const prepared=await prepareProductionSnapshot(env as unknown as Parameters<typeof prepareProductionSnapshot>[0],refreshed,vintageRows);
    if (observations.length) {
      // D1 permits at most 100 bound parameters per statement.
      for (let index = 0; index < observations.length; index += 10) {
        await db.insert(currencyObservations).values(observations.slice(index, index + 10)).onConflictDoUpdate({
          target: [currencyObservations.currency, currencyObservations.metric, currencyObservations.period, currencyObservations.source],
          set: { value: sql`excluded.value`, observedAt: sql`excluded.observed_at` },
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
    await prepared.commit();
  } catch {
    await productionFailure(env as unknown as Parameters<typeof productionFailure>[0],refreshedAt,"REFRESH_ARCHIVE_FAILED");
    return Response.json({ status: "unavailable", reason: "Refresh could not be fully archived" }, { status: 503 });
  }

  return Response.json(refreshed);
}
