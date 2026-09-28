# Source and coverage completion — production v21

This continues Site v20 (`02000db7fbe8b7f0f6425a5294b1ef0a7f56e305`) and GitHub main `2648b3e432573d4fe701d4caec28dee78ca96123`, whose source trees match. It retains the existing Site, D1, scheduler, runtime secrets, automatic model migration and adaptive evidence architecture. The preceding automatic-completion audit remains historical evidence; the coverage rules below supersede its former strict LIVE rule.

## Implemented and source-checked

The adapters below are part of the existing daily refresh. The successful public-source checks on 2026-09-28 were read-only checks outside production D1. They establish parser/source availability, **not** post-deployment Cron or production persistence.

| Input | Official source and definition | Observed result / limit |
|---|---|---|
| CAD 2Y / 10Y | Bank of Canada Valet `BD.CDN.2YR.DQ.YLD` / `BD.CDN.10YR.DQ.YLD` | Paired 2026-09-25 benchmark yields; instrument rolls disclosed |
| JPY 2Y / 10Y | Japan Ministry of Finance `jgbcme.csv` | Paired 2026-09-25 constant-maturity nominal JGB yields |
| AUD 2Y / 10Y | RBA `f2-data.csv`, `FCMYGBAG2D` / `FCMYGBAG10D` | Paired 2026-09-23 interpolated government yields |
| EUR 2Y / 10Y | ECB `YC.B.U2.EUR.4F.G_N_A.SV_C_YM.PY_2Y` / `PY_10Y` | Paired 2026-09-25 AAA sovereign **par** curves; zero-coupon spot series rejected |
| Calendar context | ECB historical daily reference fixings | All eight currencies; 20 prior completed years, minimum 15 samples, split-period stability and shrinkage |
| Export commodities | RBA `i2-data.csv`, USD all/rural/metals/bulk baskets | AUD export exposure; August 2026 observations, actual publication date 2026-09-01 |
| Supply-chain pressure | New York Fed GSCPI vintage CSV | August 2026 value from September vintage; composite proxy, not a freight spot price |
| Container port volumes | World Bank / UNCTAD `IS.SHP.GOOD.TU` | Consecutive 2024/2023 observations for seven currency economies; no CHF series invented |
| Electricity consumption | World Bank `EG.USE.ELEC.KH.PC` | Consecutive 2024/2023 observations for all eight currency economies |
| Aggregate intentional homicide | UNODC via World Bank `VC.IHR.PSRC.P5` | Six eligible currency economies; GBP latest 2021 is stale, EUR aggregate absent |
| Funding / gas | Existing FRED adapter extended with Chicago Fed `NFCI` and EIA `DHHNGSP` | Existing secret reused; official identifiers checked; production ingestion awaits next refresh |

Public endpoints and series definitions are retained in `lib/source-expansion.ts` and `lib/observed-sources.ts`, with source URLs, provider, country/currency, unit, frequency, feature version, lineage and economic rationale on receipts. UK/NZ public endpoints rejected access from this environment. Comparable GBP/CHF/NZD curve pairs remain unconnected; no monthly-average or zero-coupon substitution is represented as equivalent daily par yields.

New rates features include curve slope, five-observation repricing when sufficient recent history exists, and USD spreads only on matching observation dates. Local closing times and curve conventions differ and are disclosed. These are not OIS-implied policy paths.

The seasonal estimator is weak descriptive context, not measured forecasting skill: next full calendar month versus the other seven currencies; last 20 completed historical years; minimum 15; shrinkage by sample size and split-period sign consistency. It stores sample size, historical window, direction, strength, standard deviation, stability and each sample. Future-year history cannot affect the present estimate. The existing 4% Core factor weight is unchanged.

RBA commodity baskets, container volumes, electricity, GSCPI and crime changes enter ordinary observations → immutable vintages → Research features → discovered hypotheses / ML / context models. They do not receive fixed Evidence weights. Crime means national aggregate intentional homicide only; it is neither total crime nor individual or demographic profiling. No missing country is filled using a peer. Protected-characteristic crime metadata is excluded from discovery.

## Point-in-time and immutable history

- Observation period, actual retrieval time and known publication date remain separate. Unknown publication dates stay null. Current retrieval does not mean current publication or historical availability.
- Strict calendar parsing avoids locale/time-zone shifts; malformed dates, future periods, future receipts and future releases fail eligibility.
- Annual observations use the existing 1095-day window after year-end. Monthly baskets/supply proxies use 75 days; yields, market momentum and seasonal source checks use 10 days; policy/COT 14; funding/labor 21; dated central-bank language 28. These windows are explicit availability policy, not a claim that all providers publish on an identical schedule.
- Annual changes require the preceding calendar year. Stale/missing country results remain visible. Raw stale observations can be archived but cannot become eligible frame features.
- Content revisions include normalized values and their underlying inputs, even if the latest raw value is unchanged. Repeated retrieval clocks do not create economic revisions. First receipt and earlier revisions are retained.
- Older vintages predate the content hash: the first v21 receipt may add one as-received vintage, without deleting or rewriting older history. Frozen predictions and outcomes are untouched.
- Health can read existing Research vintages before the first upgraded snapshot. This is read-only and does not pretend the new adapters have already run.

## Coverage rules, independent of ML

The baseline weights remain policy 16%, yields 15%, growth 14%, momentum 12%, risk 10%, inflation 9%, COT 9%, sentiment 6%, commodities 5%, seasonality 4%.

Critical dependencies are policy, yields, growth, momentum, risk, inflation and COT for all eight currencies, plus commodities for CAD/AUD/NZD/JPY due to material export/import exposure: **60 critical factor/currency combinations**. Sentiment, seasonality and the remaining four commodity contexts are noncritical individually. Every defined Core category must still have at least one fully certified factor: an entirely missing context category is not treated as an isolated gap. `lib/core-coverage.ts` records each rationale and freshness window.

| Header | Actual requirement |
|---|---|
| FULL LIVE | 80/80 certified factors, complete current actual dependencies, no carried/fallback input |
| LIVE | All 60 critical combinations certified and no entirely missing Core category; isolated context gaps remain visible |
| PARTIAL LIVE | Some current actual inputs, with at least one critical or category gap |
| BASELINE | No sufficient current actual input basis |

Certification requires finite observed values, actual nonfuture receipts, nonempty dependency lists and each dependency within its own freshness window. Annual data need not be published today. Core and Research counts are separate; absent options, social or crime data do not lower Core coverage. Counts for failed/stale/unavailable can overlap other quality flags and are not additive.

The display-policy change does not recalibrate forecasts. `forecastSourceMode` preserves the preceding strict coverage calibration. A label-only upgrade from PARTIAL LIVE to LIVE is regression-tested across every directed pair and the full 208-point distribution. Sources never create individual scatter points: points remain full currency-model states.

## Automatic learning remains the sole adaptive path

The v20 migration and frozen forecast baseline are retained; the manual modelBlend allocation UI and endpoint remain retired. Core factor weights and the existing risk formula have not been changed. New sources may legitimately update observed Core inputs; that is distinct from a label-only forecast regression.

Daily snapshots, predictions, all applicable 1/3/5/10/30/60/90D outcomes and weekly retraining continue through the existing scheduler. Challenger training starts at SHADOW and cannot itself add influence. Prospective qualification, purged walk-forward/OOS comparisons, calibration, regime fit, incremental information, multiple testing, redundancy, source reliability, drift/OOD and qualification age remain the gates. Qualified models/hypotheses can become active automatically and can automatically lose influence or fall back to Core. Pair context remains outside Currency Evidence. Event targets are not interpreted as automatic directional evidence.

Source reliability uses the actual feature dependencies. Missing GBP crime does not invalidate an observed CAD crime feature; a failure of a source used by that feature still matters. No gate threshold has been relaxed.

ML and hypotheses share the existing default 10% cap, hard maximum 15%. Runtime revision 9 has no false adaptive override: all three flags use enabled defaults. Present influence remains zero without validated components. Final Evidence is combined once and propagated through Strength, Pair, Dominance and Forecasts without modifying NLP sentiment.

## Verification

- **106/106 tests passed**, including parser/freshness/publication/PIT, vintages/revisions, actual dependency failures, four coverage states, missing countries, aggregate crime discovery at zero weight, Core/Research separation, future-data rejection and seasonal history.
- Existing forecast fixtures, immutable baseline hashes, migration backup, exact-once evidence propagation, cap/kill switches, lifecycle/degradation/rollback, context/event targets, Cron classification, atomic persistence, purging and embargo regression checks remain green.
- TypeScript typecheck passed. Lint: zero errors, one existing anonymous-default-export warning in the unchanged scheduler. Production build passed.
- Browser E2E is **blocked, not passed**: managed-preview browser capability is unavailable; direct production health access from this execution environment returns HTTP 403. No authentication boundary was bypassed. Static rendered-HTML tests are not a substitute for browser E2E.
- GitHub CI and deployment identifiers are reported from their final tool results. No new D1, schema, Site, URL, secret or scheduler is created for this release.

## Genuine production baseline and remaining verification

The latest observed genuine Daily Cron before v21 was scheduled **2026-09-28 15:15:53 UTC**. D1 run `88671cac-636f-46c0-a1f4-c64b530aab29` completed at **15:16:42.976**, `source=CLOUDFLARE_CRON`, HTTP 200, SUCCESS, snapshot advanced to **15:16:25.174**. Corresponding frame, source, Evidence and decision records exist. The v20 automatic-model backup and CAD/SNB source records exist in D1.

The genuine weekly run `c63f46a9-b082-4e58-a236-3dc6f4d2313b`, scheduled **2026-09-26 20:00:53 UTC**, completed **20:01:10.777**, HTTP 200, WAITING, training samples 0. Later deduplicated attempts are not mislabeled as executed retrains.

Pre-v21 inventory: 42 snapshots; 208 current observation rows; 859 immutable vintages; 48 direction outcomes (32 × 1D, 16 × 3D); 25 separate event outcomes; 0 main-horizon training examples; 80 testing hypotheses, 0 active/shadow/rejected; DETERMINISTIC_CORE, actual ML status WAITING FOR DATA; ML/hypothesis influence 0%/0%. Last retrain record: 2026-09-26 20:01:07.695 UTC. Core certification was 38/80, with 32/60 critical dependencies certified, 26 carried, 16 partial and 0 explicitly stale factors. The latest recorded pipeline error was null. There were 15 failed source checks among 71 checks, including premium Alpha Vantage requests with functioning ECB fallback and incomplete World Bank series.

These are real v20 observations, **not v21 Cron proof**. The next scheduled daily window starts 2026-09-29 at 15:15 UTC. New v21 receipts, research-status records and revised coverage must be certified from that real invocation. No fake Cron, synthetic production outcome or forced activation was created to complete this report.

The archive contains ten alternative metric definitions in five of the eleven registered Research families: COT, energy, funding, labor/consumption and official narratives. Some large vintage payloads are truncated by the inspection connector; a complete current fresh-feature count is therefore not claimed from that readout. The new health implementation computes it from complete D1 payloads. Metadata discovery has run, but its latest candidate source checks yielded no usable observations.

## Remaining external-data limits

Core remains PARTIAL LIVE while critical gaps remain. Commodity Core still needs a defensible currency-specific exposure mapping; observed energy and AUD export baskets are Research inputs rather than an arbitrary fixed replacement. The existing risk formula retains a 50% static anchor, correctly labeled partial. GBP/CHF/NZD comparable daily yields and JPY/NZD usable full-text central-bank language remain unavailable. Some World Bank country/indicator pairs are missing. Seasonality is implemented for all eight currencies but its new production ingestion awaits the next genuine refresh.

| Premium class | Gap / required data | History, frequency and integration |
|---|---|---|
| FX options, IV, RR, skew | Pair/tenor/delta surfaces with quote conventions | 5–10 years; daily fixed fixing; frozen as-quoted vintages and corrections; separate event calibration |
| Cross-currency basis / implied policy paths | Synchronized basis and OIS curves; funding indices cannot reproduce them | 5–10 years; daily; tenor/collateral/as-of definitions; pair/curve adapter |
| Freight spot / port and vessel activity | Route/container prices and aggregate activity; annual volumes/GSCPI are partial proxies | At least 5 years; daily/weekly; published definitions and revisions; trade exposure mapping |
| Forecast dispersion | Independent timestamped forecast panels, not model-generated dispersion | 5 years; every release; pre-release cutoffs and contributor changes; immutable survey vintages |

Google Trends, broad news, social media, YouTube and retail positioning have no configured stable authorized point-in-time feed. Existing official central-bank narrative features remain connected. No purchase or secret request was made.

Only prospective outcomes, sufficient chronological samples, genuine qualification/activation, weight growth and future degradation/rollback events must wait for market time. Missing external feeds and defensible Core mappings are separate limitations. Metadata discovery searches available provider metadata and transformations automatically; it does not procure unavailable providers or prove causation. New eligible crime, shipping, narrative, commodity and rates features can later influence Final Evidence through the same automatic validated adaptive path, never through a fixed unvalidated bonus.
