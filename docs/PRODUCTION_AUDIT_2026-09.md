# Production baseline and change contract

Audit started 2026-09-20 UTC. Site version 16, source `a7dd853c2125e567c87137622fc434b1a40e9bc9`; GitHub main `de3cfe993056c0a77819ad39f19777e9ed6f3e67`. Scheduler version `86191677-0a0c-4fd1-9c2e-5f653fb5267c`, existing daily and SAT cron expressions retained. Hosted environment revision 9; secret names only were inspected. No secret rotation.

## Baseline findings

| Component | Diagnosis | Evidence |
|---|---|---|
| Daily cron → snapshots | PARTIAL | Persisted successful real cron runs Sep 14–19. Sep 20 invocations failed on the older scheduler version; current repaired version has not yet reached its regular due window. |
| Weekly cron | PARTIAL | Sep 19 due invocations failed on that older version; other successful invocations outside the due window did no work. |
| D1 | WORKING | Existing five tables and operational records readable. No database replacement needed. |
| Observation revisions | BROKEN | Conflict update assigns the column to itself, retaining the old value while advancing observed_at. No revision archive. |
| Raw → policy/yields | BROKEN | Raw rates/yields update, normalized policy/yields remain initial constants. |
| Risk repeatability | BROKEN | Each refresh recursively halves prior risk and adds unchanged macro ranks. Identical inputs therefore change scores. |
| Macro frequency | PARTIAL | World Bank inputs are annual. A daily retrieval does not make annual releases daily data. |
| Historical chart/evidence ages | BROKEN | Seed deltas and cyclic 0/10/30/60/90 evidence ages masquerade as observations. |
| Core forecast | WORKING/PARTIAL | Deterministic and input-sensitive; uncertainty and coverage are model heuristics, not measured predictive confidence. |
| ML training | PARTIAL | Existing temporal purge is useful. Dataset/outcomes rebuilt from mutable observations, no frozen predictions or challenger acceptance gate; training overwrites the model regardless of comparative quality. Stored model has 0 samples, trainedAt null. |
| Hypotheses v1 | PARTIAL | Persistent 32-candidate research catalog, multiplicity controls, immutable outcomes and disabled USD adapter exist. Latest persisted successful research Sep 19, 24 frames, WAITING_FOR_DATA, influence 0. Sources cannot certify several inherited factors. |
| Currency hypothesis → Evidence | NOT IMPLEMENTED | v1 adapter is restricted to USD probability; fundamental contribution function is an identity. |
| Health | PARTIAL | Operational logs exist; no complete dataset/source/evidence/change history or champion/rollback status. |

## Repair contract

Preserve the core weights, deterministic simulation and existing stored history. New refreshes get an explicit calculation/feature version. Fix risk recursion by anchoring its unchanged 50/30/20 formula to the original risk input; connect raw rate and yield changes through anchored cross-sectional rank deltas (old rank at the original anchor gives exactly the original factor). This is an explicit correction to missing input plumbing, not an assertion that ranks measure future returns. Inflation/growth formulas and factor weights remain unchanged. Missing historical observations are marked missing; no fabricated past trajectory.

Append new observation vintages and production records. Existing tables remain backward compatible; old snapshots/outcomes are not rewritten or certified retroactively. ECB reference prices are a separately identified daily fixing, never represented as traded closes or executable prices. Official release time is null if unavailable; actual receipt time is the point-in-time boundary.

Validation uses chronological, non-overlapping blocks, frozen definitions, multiplicity/repeated-look budgets, comparative core losses, calibration, regimes and prospective shadow outcomes. No synthetic production rows. Unit fixtures and controlled production invocations are not real cron evidence. Existing v1 research remains archived and separate; adaptive v2 cannot borrow v1 qualification.

Rollback: republish version 16 if necessary; new additive tables can remain, because old code ignores them. Adaptive state uses immutable versions and decision records; zero/invalid/stale state returns core. Do not restore or delete D1 data to roll back application code.

Provider references: [ECB reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html), [FRED observations](https://fred.stlouisfed.org/docs/api/fred/series_observations.html), [World Bank API](https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api-documentation).

## Implemented production contract (v2)

`observation_vintages` and `production_records` are additive, append-only domain tables. A refresh archives receipts, resolves past predictions and prepares a new daily frame; frame, lifecycle state, evidence attribution and public snapshot are committed in one D1 batch. A failed commit publishes none of them. Both manual and scheduled refresh/retrain share the existing lease. Provider failures are recorded with affected raw metrics, URL without credentials, time, cause, latency and the carried-input fallback. The 30-refresh source reliability record is operational availability, not an estimate of trading performance.

The revised current-observation view updates revised values; the immutable archive retains every observed vintage. Receipt timestamps are never replaced with the observation year. Unknown release times remain null. Historical snapshots are not retrospectively certified. Training uses only newly issued versioned frames; entry is the next complete ECB fixing strictly after issue, labels resolve after 1/3/5/10/30/60/90 calendar days plus the next available fixing. Existing synthetic baseline factors (COT, seasonality, commodities and unobserved rates) are identified as carried inputs, not fabricated live data. They remain part of the existing deterministic baseline. A qualified adaptive regime additionally requires an actually received valid VIX observation.

Every daily frame freezes all eight currencies, relative features, prices, volatility, regime, source lineage, core/final Evidence and shadow candidate predictions. All 28 unordered pairs preserve core and adaptive 10/30/60/90 forecasts and later fixing-based outcomes. These pair forecast records are monitoring data; currency-versus-equal-basket losses qualify the currency Evidence layer. Daily fixing MFE/MAE is not intraday excursion. Volatility expansion is measured as an additional outcome; no unvalidated conversion of a volatility target into bullish/bearish Evidence exists.

Hypothesis discovery scans available feature definitions and World Bank indicator metadata, rather than a fixed list of named market narratives. Annual cross-sectional proxies must have an explicit provider definition, formula version, common observation year and all eight currencies. Metadata discovery does not use outcomes. Bounded collection keeps up to eight proxy feeds active; unavailable definitions are retained, and scanning continues. The feature grammar evaluates levels, changes, seven-day lags and interactions for 1/3/5/10-day targets. At most eight new recipes per refresh, 128 concurrent non-rejected recipes, 4096 lifetime definitions; all rejects remain stored and counted in multiplicity. This is a bounded automatic research program, not an unrestricted internet crawler or a claim to have connected every example data class in the request.

Hypothesis historical qualification reserves 40 development blocks, validates 60 subsequent blocks and freezes a final 20-block holdout. Promotion then needs at least 30 genuinely new shadow blocks, calibration, comparative Brier/log loss, three stable chronological windows and two qualified regimes. All currencies share a time block, with an additional horizon embargo; they are not counted as eight independent trials. Family-wide and repeated-look Bonferroni/alpha spending include rejected definitions. Models have additional chronological purging, held-out comparisons and a quadratic training-attempt multiplicity budget. An incumbent cannot be replaced merely by ranking in-sample fit: the challenger must beat its contemporaneous stored predictions. When no current qualified champion exists the system returns to Core.

Exact combination: `final = core + Σ w_eff * (candidate - core)`, where `w_eff = validated weight × confidence × regime fit × source reliability`, rescaled together if they exceed the shared cap. The configurable cap defaults to 0.10 and cannot exceed 0.15. Initial qualification additionally limits each layer to 0.025, so the combined deployed allocation is at most 0.05. Validation tests each individual 0.05 mixture; the smaller combined allocation is a convex combination of these qualified mixtures. This cap is mixture mass, not a claimed accuracy improvement or a promised score change. Confidence is zero unless the gate passes; dispersion from the old simulator remains explicitly a model heuristic.

Runtime switches: `ADAPTIVE_ENABLED=false`, `ML_ENABLED=false`, `HYPOTHESIS_ENGINE_ENABLED=false`; `ADAPTIVE_MAX_WEIGHT` can lower the shared cap. No new runtime settings are required for prospective collection. Missing/corrupt state, failed source quality, distribution violations, failed validation, stale attribution after 36 hours, changed factors, or a disabled layer remove its effect. Historical values remain unchanged. Status is read with the same expiry/kill rules. Degradation reduces or zeroes weight; reactivation requires a 30-day cooldown and new qualifying evidence. Immutable model records and decision records retain rollback history.

Release verification must distinguish local fixtures, controlled production requests and the next actual scheduled run. No local statistical fixtures may enter production. Neither promotion nor predictive benefit can be LIVE VERIFIED before adequate genuine future outcomes exist. Validation thresholds can require years at long horizons; elapsed time does not grant influence automatically.
