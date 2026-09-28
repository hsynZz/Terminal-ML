import { factorMeta, type CurrencyCode, type FactorKey } from './terminal-data';

/** Display/audit policy only. Does not change weights, factor values or model uncertainty. */
export const COVERAGE_VERSION = 'critical-core-v1';
export function coreRequirement(factor:FactorKey,currency:CurrencyCode) {
  const context = factor==='seasonality'||factor==='sentiment'||factor==='commodities';
  const exposed = factor==='commodities'&&(['CAD','AUD','NZD','JPY'] as string[]).includes(currency);
  const reason:Record<FactorKey,string>={
    policy:'16% baseline; policy-rate cross-section drives carry and relative monetary stance.',
    yields:'15% baseline; both 2Y and 10Y market yields and the full relative cross-section are required. Policy rates cannot replace these.',
    inflation:'9% baseline; real-rate comparison depends on policy rates and comparable inflation inputs.',
    growth:'14% baseline; growth and employment jointly determine the relative activity factor.',
    cot:'9% baseline; independent positioning category, not replaceable by price momentum.',
    risk:'10% baseline; current account and debt do not certify the remaining static risk anchor.',
    momentum:'12% baseline; actual FX observations are the price dependency for relative strength and outcomes.',
    commodities:exposed?'5% baseline but material export/import exposure for this currency; no oil-only substitute for a documented basket.':'5% context factor; isolated gaps may remain visible when critical commodity exposures and the category are covered.',
    sentiment:'6% publication context; an isolated missing feed is tolerable with observed policy, yields and macro inputs. No speech is not a neutral observation.',
    seasonality:'4% weak calendar context; isolated gaps are tolerable, but missing the entire category is disclosed as a coverage gap.',
  };
  const freshness:Record<FactorKey,string>={policy:'14 days',yields:'10 days; both maturities',inflation:'rate 14 days; annual CPI 1095 days after year-end',growth:'annual 1095 days after year-end',cot:'14 days',commodities:'10 days unless a documented monthly basket',risk:'annual 1095 days; static anchor remains PARTIAL',seasonality:'10 days; historical estimator recalculated prospectively',momentum:'10 days',sentiment:'28 days since dated publication'};
  return {critical:!context||exposed,weight:factorMeta[factor].weight,reason:reason[factor],freshness:freshness[factor]};
}
