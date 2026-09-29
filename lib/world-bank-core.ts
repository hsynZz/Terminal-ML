import { currencies, type CurrencyCode } from './terminal-data';
import { observationQuality, type Observation, type SourceCheck } from './production-data';
import { sourceAttempt, sourceFetch } from './source-health';

// Same WDI series/definitions as the original refresh route. Batch by indicator,
// not forty simultaneous requests competing for the Worker's connection queue.
export const worldBankCountries: Record<CurrencyCode, string> = {
  USD: 'USA', EUR: 'EMU', GBP: 'GBR', JPY: 'JPN', CHF: 'CHE', CAD: 'CAN', AUD: 'AUS', NZD: 'NZL',
};
export const worldBankIndicators = {
  inflation: 'FP.CPI.TOTL.ZG', growth: 'NY.GDP.MKTP.KD.ZG', unemployment: 'SL.UEM.TOTL.ZS',
  currentAccount: 'BN.CAB.XOKA.GD.ZS', debt: 'GC.DOD.TOTL.GD.ZS',
} as const;
type Metric = keyof typeof worldBankIndicators;
const definitions: Record<Metric, string> = {
  inflation: 'Consumer price inflation, annual percent; not monthly CPI or a latest-month YoY observation.',
  growth: 'GDP growth, annual percent, constant-price national accounts; not quarterly annualized GDP.',
  unemployment: 'Unemployment as percent of total labor force, annual modeled ILO estimate.',
  currentAccount: 'Current account balance as percent of GDP, annual; World Bank country/EMU definition.',
  debt: 'Central government total debt as percent of GDP, annual; not general-government gross debt.',
};

export function worldBankCoreUrl(metric: Metric) {
  // 8 countries * 8 annual periods = 64 records. No gapfill or MRNEV backfill.
  return `https://api.worldbank.org/v2/country/${Object.values(worldBankCountries).join(';')}/indicator/${worldBankIndicators[metric]}?format=json&source=2&mrv=8&per_page=100`;
}
type Row = { indicator?: { id?: string }; countryiso3code?: string; date?: string; value?: unknown; unit?: string; obs_status?: string };

export function parseWorldBankCore(body: unknown, metric: Metric, currency: CurrencyCode, receivedAt: string): Observation | null {
  if (!Number.isFinite(Date.parse(receivedAt)) || !Array.isArray(body) || body.length !== 2 || !Array.isArray(body[1])) throw new Error('INVALID_RESPONSE');
  const meta = body[0] as { page?: number; pages?: number; total?: number; sourceid?: string } | null;
  const rows = body[1] as Row[];
  // Never silently certify an incomplete first page or a different dataset/series.
  if (!meta || meta.page !== 1 || meta.pages !== 1 || meta.total !== rows.length || String(meta.sourceid) !== '2'
    || rows.some(r => !r || r.indicator?.id !== worldBankIndicators[metric])) throw new Error('INVALID_RESPONSE');
  const points = new Map<string, number>();
  for (const row of rows.filter(r => r.countryiso3code === worldBankCountries[currency])) {
    if (row.unit !== '') throw new Error('INVALID_RESPONSE');
    if (row.value === null) continue;
    if (typeof row.value !== 'number' || !Number.isFinite(row.value) || typeof row.date !== 'string' || !/^\d{4}$/.test(row.date)) throw new Error('INVALID_RESPONSE');
    // A WDI update timestamp is NOT this observation's original release date.
    // Annual outcomes for an unfinished year (and flagged projections) cannot be used.
    if (row.date >= receivedAt.slice(0, 4) || row.obs_status) continue;
    if (observationQuality(metric, row.value, row.date, receivedAt) === 'INVALID') throw new Error('INVALID_RESPONSE');
    if (points.has(row.date) && points.get(row.date) !== row.value) throw new Error('INVALID_RESPONSE');
    points.set(row.date, row.value);
  }
  const latest = [...points].sort(([a], [b]) => b.localeCompare(a))[0];
  if (!latest) return null;
  const [period, value] = latest;
  if (observationQuality(metric, value, period, receivedAt) !== 'VALID') throw new Error('INVALID_RESPONSE');
  return {
    currency, metric, value, period, receivedAt, source: 'World Bank Open Data',
    sourceUrl: `https://api.worldbank.org/v2/country/${worldBankCountries[currency]}/indicator/${worldBankIndicators[metric]}`,
    unit: metric === 'currentAccount' || metric === 'debt' ? 'percent of GDP' : metric === 'unemployment' ? 'percent of total labor force' : 'annual percent',
    frequency: 'annual', releaseDate: null, quality: 'VALID', definition: definitions[metric],
    lineage: [`WorldBank:${worldBankIndicators[metric]}:${worldBankCountries[currency]}`],
  };
}

export async function collectWorldBankCore(checks: SourceCheck[]): Promise<Observation[]> {
  const groups = await Promise.all((Object.keys(worldBankIndicators) as Metric[]).map(async metric => {
    // All eight diagnostic records share ONE in-flight response. A failure remains
    // visible for every affected input; one missing country never borrows another.
    const response = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const body: unknown = await (await sourceFetch(worldBankCoreUrl(metric))).json();
          return { body, receivedAt: new Date().toISOString() };
        } catch (error) {
          if (!(error instanceof Error) || (error.name !== 'TimeoutError' && error.name !== 'AbortError')) throw error;
          // One bounded timeout retry; never retry access denial or invalid data.
          if (attempt === 1) throw new Error('TIMEOUT');
        }
      }
      throw new Error('TIMEOUT');
    })();
    return Promise.all(currencies.map(currency => sourceAttempt(checks, 'World Bank Open Data', worldBankCoreUrl(metric), currency, [metric], async () => {
      const { body, receivedAt } = await response;
      return parseWorldBankCore(body, metric, currency, receivedAt);
    })));
  }));
  return groups.flat().filter((row): row is Observation => row !== null);
}
