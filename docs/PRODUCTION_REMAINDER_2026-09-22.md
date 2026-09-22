# Production remainder after v18 — 2026-09-22

## Baseline and scope

Existing Site `appgprj_6a9af546bb708191b3d1f60440ead234`, URL `https://fx-macro-terminal.hysnzz.chatgpt.site`, v18 source `abb97e5bbe06c6ae25767269067a1a37a76dcf67`. GitHub main `8de3265688ef32acd1b57d94408f35e919f8ad4f`. No changes to deterministic Core weights, existing migrations, production data, secret values, access controls or scheduler deployment. No new Site or D1. Fixtures run only in local in-memory SQLite.

Remaining gaps: regular-v18 Cron evidence, carried rate/COT inputs, more actually observed research variables, lineage-aware redundancy, stale hypothesis qualification, context-specific hypothesis learning, additional non-directional targets, and compact status/coverage.

## Actual production evidence (before this release)

Cloudflare scheduled event on `fx-terminal-scheduler`, version `86191677-0a0c-4fd1-9c2e-5f653fb5267c`, scheduled `2026-09-21T15:15:26Z`, completed `2026-09-21T15:16:12.091Z`, source `CLOUDFLARE_CRON`, DAILY_REFRESH SUCCESS HTTP 200. Run `a7b6cd24-b740-4b9e-9a8f-164beea8b35e` matches the D1 automation record, completed `15:16:11.509Z`, `snapshotAdvanced=true`, snapshot `2026-09-21T15:15:58.477Z`, and matching frame/evidence/decision/source production records. This is real v18 Cron evidence, not evidence for the new release.

Read-only full-table pagination on 2026-09-22: 35 snapshots, 136 current observations, 592 immutable vintages, 12 production records, no resolved outcome or trained-model records. Latest snapshot `2026-09-21T21:29:52.892Z` belongs to MANUAL run `ca010c16-e866-4d3b-939c-35c598d71e19`, completed `21:30:12.252Z`. No successful regular weekly run was found. Last retrain `2026-09-21T09:20:40.307Z` was CONTROLLED_TEST / WAITING_FOR_DATA, zero samples. Native DB cell projections truncate long JSON: do not infer full registry counts, all-current source failures or exact coverage from truncated values.

Both original cron expressions are retained and re-read from Cloudflare: `15,30,45 15,16,17 * * *` and `0,15,30,45 20,21 * * SAT`. The original Berlin due-window/lease/idempotency rules remain.

Resumed read-only verification after the next scheduled v18 run: `d4045ed4-9d43-41da-8ded-ffdd2c28cadb`, source `CLOUDFLARE_CRON`, scheduled `2026-09-22T15:15:26Z`, HTTP 200 / SUCCESS, completed `15:16:08.941Z`. Snapshot advanced to `2026-09-22T15:15:44.440Z`; frame, evidence, decision and source records match. At this check: **36 snapshots, 141 observations, 613 immutable vintages, 16 production records, 0 outcomes/model records**. This remains v18 evidence. The subsequent 15:30/15:45 Cron retries correctly reported the period already completed. An attempted direct Cloudflare connector refresh required reauthentication; no alternate credential was used. The new proof is from the authorized Sites D1 read interface.

## Connected source definitions

| Adapter | Uses | Definition and availability |
|---|---|---|
| BIS `WS_CBPOL`, API v2 | Non-US selected main policy rate, seven currencies | Daily observations published weekly; percent per annum, unit 368 and multiplier 0 required. Max age 14 days. No claim of intraday pricing. Source: Bank for International Settlements; translations are not official BIS translations. |
| CFTC Legacy futures-only `6dca-aqww` | COT for USD/EUR/GBP/JPY/CHF/CAD/AUD/NZD | Non-commercial long/short/open interest only. No mixing with TFF leveraged funds. Core factor explicitly normalized as `0.5 + 0.5*(long-short)/OI`; its existing weight is unchanged. USD is ICE USD-index futures, not an equal-weight basket. |
| CFTC research | Net positioning, weekly change, acceleration | Same raw contracts. Differences require exactly consecutive seven-day report dates; gaps remain unavailable. Three underlying reports are stored. |
| FRED / EIA `DCOILWTICO`, `DCOILBRENTEU` | Global energy shadow proxies | Bounded 20-observation log change. Not actual commodity demand; no replacement of the commodity Core factor. Existing configured FRED credential, no new secret. |
| FRED `STLFSI4` | Financial/funding-stress shadow proxy | Weekly broad stress index, `tanh(level/3)`; not an FX basis quote. |
| FRED / DOL `ICSA` | USD labor shadow proxy | Negative four-observation log change in initial claims. |
| FRED / Census `RSAFS` | USD consumption shadow proxy | Three-observation log change in advance retail sales. Revisions are available only at actual receipt, never retroactively. |
| Existing official central-bank RSS | Publication activity/novelty | Deduplicated dated publications, 7-day activity vs prior 21-day weekly average; Jaccard novelty against older publications. Bounded feed sample, not all news, Google Trends, YouTube or social-media reach. Existing feeds cover USD/EUR/GBP/AUD, not all eight currencies. |
| Existing World Bank metadata discovery | Additional unusual annual proxies | Existing open-ended indicator scan retained. Shared year/all-eight coverage still required. Failed candidates are quarantined and retried after 30 days; no fabricated cross-country fill. |

All new research receipts retain provider, public URL, observation date, retrieval time, null release date when unknown, feature version/definition, raw inputs and lineage/economic cause. Existing append-only archiving adds actual-receipt vintage ID and freshness. Source checks retain failure/fallback and operational reliability; that score is not predictive confidence. Global features remain global, USD-only observations are not copied to other currencies. Old historical frames are not augmented or re-certified.

Provider documentation: [BIS data API](https://stats.bis.org/api-doc/v2/), [BIS policy rates](https://data.bis.org/topics/CBPOL), [CFTC Legacy futures-only](https://publicreporting.cftc.gov/Commitments-of-Traders/Legacy-Futures-Only/6dca-aqww), [FRED observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html). Public adapters need successful deployed runtime receipts before they can be called production-live.

## Adaptive additions, not a replacement architecture

- Existing feature grammar/lifecycle/holdout/shadow/multiplicity remains. New recipes receive provenance and an explicitly unproven economic rationale. No outcome-based source selection.
- Redundancy now compares aligned common feature, signal and loss observations; shared lineage and economic cause also block duplicated direct contributions. Missing overlap fails conservatively, never zero-filled correlations.
- Existing 180-day decay now also gates positive performance. Hypothesis effective allocation gradually ages and becomes zero 180 days after last qualification; renewed evidence is needed.
- Context residual ridge-logistic models use frozen hypothesis predictions, currency/pair and regime interactions plus bounded combinations. Initial feature vocabulary is fixed before test periods; bounded cohorts rotate deterministically across retrain attempts without using outcomes to choose features. Only outcomes already resolved by the training cutoff are admitted. Purged walk-forward evaluation must beat Core **and** a simple hypothesis ensemble. Prospective shadow predictions are separate from later labels; no model activates because retraining ran. Existing shared adaptive cap remains. Direct hypotheses consumed by qualified context models are excluded from additional direct contribution. Pair context models are monitored but never projected into currency Evidence.
- New versioned Breakout, Reversal, Volatility Expansion and VIX-side-of-20 Regime Transition predictions resolve on actual future ECB fixings/VIX observations. Initial candidate scores are explicitly uncalibrated. Baseline frequencies need 30 previously resolved outcomes. Target-specific OOS gates never map an event probability automatically into bullish/bearish Evidence. Influence remains zero.
- Existing 1/3/5/10/30/60/90 calendar-day outcomes, immutable frames and atomic snapshot publication stay in place. Long-horizon validation can legitimately take years.
- `/api/production` and the existing status panel now distinguish last successful daily refresh, last genuine successful Cron, regular weekly invocation, full versus partial/carried Core factors, context learning and event targets. Compact append-only status/coverage records support later checks. No new public diagnostic endpoint or authentication exception.

## Still unavailable / carried

Seasonality Core, commodity Core, unverified non-US 2Y/10Y yields, missing World Bank measurements and unsupported central-bank feeds stay carried or unavailable. No new core weights or guessed exposure signs. Social media, YouTube, Google Trends, broad news feeds, FX options/IV/risk reversals, cross-currency basis, retail positioning, freight/shipping and forecast dispersion are NOT YET CONNECTED. Market-implied rate-path repricing is not the same as observed policy rates. Lexical central-bank features are not a complete speech-understanding system.

Status definitions: FRESH means valid within source-specific observation age, never automatically LIVE/today. PARTIAL/CARRIED INPUT contains inherited components. FALLBACK records why a prior value was preserved; FAILED identifies a retrieval error; UNAVAILABLE/NOT YET CONNECTED means no reliable configured input. WAITING FOR DATA is expected for immature outcomes. A daily fetch cannot make annual data daily releases.

## Release gates

Targeted tests cover parser units/freshness/future data, COT normalization/gaps, raw provenance, source unavailability, bounded narrative coverage, no synthetic peers, decay/deduplication, separate immutable event outcomes, context entity/regime/missing-input gates, temporal purging, local-only qualification/degradation fixtures and Cron-vs-manual health. Final **81/81 tests, typecheck, lint and production build passed** (one existing scheduler lint warning). Browser preview navigation was blocked with `ERR_BLOCKED_BY_CLIENT`; no browser E2E success is claimed. Preserve v18 as the safe software rollback baseline; never roll back or reset D1 data.

Source-only HTTP probes on 2026-09-22 returned HTTP 200 with all seven valid BIS policy-rate observations and all eight CFTC contracts plus 24 COT research features. Those probes wrote no production data. New FRED/RSS feature collection still needs its first deployed refresh receipt.

Real new-release Cron, provider persistence in production, weekly training on genuine mature outcomes, qualification, activation, weight increases, degradation and rollback remain unverified until their corresponding production events exist. Local synthetic fixtures and source-only HTTP probes are never those events.
