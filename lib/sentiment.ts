import type { CurrencyCode } from "@/lib/terminal-data";

export type TextSignal = {
  currency: CurrencyCode;
  title: string;
  summary: string;
  publishedAt: string | null;
  source: string;
};

export const centralBankFeeds: { currency: CurrencyCode; source: string; url: string; speechOnly?: boolean }[] = [
  { currency: "USD", source: "Federal Reserve · Monetary Policy", url: "https://www.federalreserve.gov/feeds/press_monetary.xml" },
  { currency: "USD", source: "Federal Reserve · Speeches", url: "https://www.federalreserve.gov/feeds/speeches.xml" },
  { currency: "EUR", source: "European Central Bank", url: "https://www.ecb.europa.eu/rss/press.html" },
  { currency: "GBP", source: "Bank of England", url: "https://www.bankofengland.co.uk/rss/speeches" },
  { currency: "AUD", source: "Reserve Bank of Australia · Releases", url: "https://www.rba.gov.au/rss/rss-cb-media-releases.xml" },
  { currency: "AUD", source: "Reserve Bank of Australia · Speeches", url: "https://www.rba.gov.au/rss/rss-cb-speeches.xml" },
  { currency: "CAD", source: "Bank of Canada · Speeches", url: "https://www.bankofcanada.ca/content_type/speeches/feed/", speechOnly: true },
  { currency: "CHF", source: "Swiss National Bank · Speeches", url: "https://www.snb.ch/public/rss/en/speeches" },
];

const positiveTerms = [
  "raise", "raised", "raising", "higher rates", "tighten", "tightening", "restrictive",
  "persistent inflation", "inflation pressure", "strong growth", "resilient", "robust",
  "upside risk", "above target", "price stability", "hawkish", "accelerat",
];
const negativeTerms = [
  "cut rates", "rate cut", "lower rates", "easing", "accommodative", "weak growth",
  "downside risk", "recession", "contraction", "disinflation", "below target", "dovish",
  "slowdown", "unemployment rising", "economic weakness", "decelerat",
];
const negations = ["not ", "no longer ", "less ", "without "];

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, names: string[]) {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match) return decodeXml(match[1]);
  }
  return "";
}

export function extractFeedItems(xml: string, feed: { currency: CurrencyCode; source: string; speechOnly?: boolean }, limit = 12): TextSignal[] {
  const blocks = xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  return blocks.filter(block => !feed.speechOnly || /<cb:speech(?:\s|>)/i.test(block)).slice(0, limit).map((block) => {
    // An Atom modification timestamp is not an original publication date.
    const date = tag(block, ["pubDate", "published", "dc:date"]);
    const parsed = date ? new Date(date) : null;
    return {
      currency: feed.currency,
      source: feed.source,
      title: tag(block, ["title"]),
      summary: tag(block, ["description", "summary", "content"]),
      publishedAt: parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null,
    };
  }).filter((item) => item.title || item.summary);
}

export function scoreFinancialText(text: string) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9%\s-]/g, " ").replace(/\s+/g, " ");
  const count = (terms: string[]) => terms.reduce((sum, term) => {
    let index = normalized.indexOf(term);
    let hits = 0;
    while (index >= 0) {
      const prefix = normalized.slice(Math.max(0, index - 14), index);
      hits += negations.some((negation) => prefix.endsWith(negation)) ? -1 : 1;
      index = normalized.indexOf(term, index + term.length);
    }
    return sum + hits;
  }, 0);
  return Math.tanh((count(positiveTerms) - count(negativeTerms)) / 3);
}

/** Only dated, already published items in the documented 28-day collection window. */
export function eligibleTextSignals(items: TextSignal[], now = new Date()) {
  const seen = new Set<string>();
  return items.filter(item => {
    const age = now.getTime() - Date.parse(item.publishedAt ?? '');
    const key = `${item.currency}:${item.title}:${item.publishedAt}`;
    if (!Number.isFinite(age) || age < 0 || age >= 28 * 86_400_000 || seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function aggregateTextSignals(items: TextSignal[], now = new Date()) {
  const eligible = eligibleTextSignals(items, now);
  let weighted = 0;
  let totalWeight = 0;
  for (const item of eligible) {
    const ageDays = Math.floor(now.getTime() / 86_400_000) - Math.floor(Date.parse(item.publishedAt!) / 86_400_000);
    const recency = Math.exp(-ageDays / 21);
    const score = scoreFinancialText(`${item.title}. ${item.summary}`);
    weighted += score * recency;
    totalWeight += recency;
  }
  const rawScore = totalWeight > 0 ? weighted / totalWeight : 0;
  return {
    factorScore: Math.max(0.05, Math.min(0.95, 0.5 + rawScore * 0.45)),
    rawScore,
    sampleCount: eligible.length,
    latestPublishedAt: eligible.map(item => item.publishedAt!).sort().at(-1) ?? null,
  };
}
