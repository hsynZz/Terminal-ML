# Automatic adaptive evidence completion

This release continues source `a31cc89aea8a4249916b5b13e218959c739b234f`, including the unfinished RSS/CAD changes. Its V19 parent has exactly the same Git tree as GitHub main `2534f9410d9efc34fcc968617a60b776b3f2035f`. Production remains the existing `fx-macro-terminal.hysnzz.chatgpt.site`, with the existing D1 and scheduler.

## Implemented

- Manual allocation controls and the settings write endpoint are retired. Core factor weights remain unchanged. Existing effective forecast weights are frozen as `forecastBaseline`, including previously eligible horizon weights. The original model settings are backed up at `model:before-automatic-v1` in the next successful snapshot transaction. Existing snapshots, predictions and labels remain unchanged. No browser action is required for this migration.
- The V1 response/pair overlay is removed from both production boundaries. V1 research remains an explicitly inactive archive. Production V2 is the sole adaptive path.
- Core-only historical anchors prevent adaptive contributions from entering forecast momentum a second time. Strength and Pair use Final Evidence; distribution, relative dominance and forecasts each receive the same separate contribution once. Sentiment inputs are not modified by adaptation.
- Missing adaptive runtime flags default to enabled. Explicit false or malformed values fail closed. Shared default cap is 10%, absolute limit 15%. Retraining never increases influence. Genuine prospective gates, source quality, regime fit, OOD, qualification freshness and current champion identity control influence.
- The existing daily and weekly pipelines remain in place: immutable receipts, issued predictions, all seven outcome horizons where applicable, purged/embargoed walk-forward training, frozen challengers, subsequent shadow qualification, degradation and independently qualified fallback champions. Context ML uses frozen hypothesis predictions and must beat Core and the simple ensemble. Pair context stays out of Currency Evidence.
- Source status is independent of ML status. LIVE requires 80/80 verified Core factors, valid dependency receipts, no future availability, and source-specific freshness windows. Annual data uses its annual window, not a same-day rule. Partial, carried, stale and unavailable inputs prevent LIVE. Active attribution also expires on read. The browser reads updated snapshots automatically.
- Health separates ML lifecycle, hypothesis lifecycle, version, training data, runtime gates, contributions/cap, source quality, actual Cron and retrain timestamps. Effective health influence uses the same current read guard as terminal output. Deduplicated weekly attempts are not mistaken for an executed retrain.
- Undated/invalid/future RSS content cannot become fresh sentiment. Atom `updated` alone is not publication. Existing Bank of Canada speech filtering is retained. The official English SNB speech RSS is connected; its actual `dc:date` is used.
- World Bank metadata discovery stays bounded and does not select features from outcomes. New metadata-defined candidates require an identifiable economic channel. New series use versioned, own-country annual changes, with both raw values retained. Missing currency peers are not imputed. Existing cross-sectional definitions are preserved. Candidate rationales explicitly retain the null hypothesis of coincidence, common cause, or already-explained information.
- Direction, volatility expansion, breakout, reversal and regime-transition research stays separate. Unvalidated event probabilities have zero directional evidence contribution.

## Regression evidence

The original immutable Core, evidence and model-setting hashes are retained. Pre-migration forecast fixtures are generated from the old source, and their default output hashes match the original immutable hashes. All 56 directed pairs, all four forecast horizons, and all distribution points are compared for three settings scenarios. The maximum allowed difference is `1e-12` for floating-point operation ordering; no updated expected forecast is generated from the new engine.

Tests additionally exercise atomic/idempotent backup, legacy controls becoming ineffective after migration, exact single adaptive shift, cap/flags, LIVE/PARTIAL/BASELINE, stale/future/annual receipts, metadata discovery through actual frame features, RSS publication semantics, actual daily-runtime shadow qualification using only local SQLite fixtures, and immediate withdrawal when the stored component degrades. Local fixtures never touch production D1.

The final response records final full-suite, typecheck, lint, build and GitHub CI outcomes. Browser E2E is not claimed: the required managed-preview `control-browser` capability was unavailable; an earlier production-browser attempt encountered the sign-in boundary. Authentication was not weakened for testing.

## Genuine V19 production proof

Read-only Cloudflare logs and existing D1 records agree:

| Item | Observed UTC value |
|---|---|
| Latest real Daily Cron | 2026-09-27 15:15:53 scheduled |
| Automation run | `cc1e1574-cc7f-47eb-a392-3d04faa7db6a` |
| D1 run completed | 2026-09-27 15:16:41.120 |
| Cloudflare success log | 2026-09-27 15:16:41.727 |
| Source / HTTP / status | CLOUDFLARE_CRON / 200 / SUCCESS |
| Latest snapshot | 2026-09-27 15:16:23.841 |
| Genuine Weekly Cron | 2026-09-26 20:00:53 scheduled |
| Weekly run | `c63f46a9-b082-4e58-a236-3dc6f4d2313b` |
| Weekly completed | 2026-09-26 20:01:10.777, WAITING, samples=0 |
| Last retrain record | 2026-09-26 20:01:07.695 |
| Scheduler version | `86191677-0a0c-4fd1-9c2e-5f653fb5267c` (unchanged) |

D1 contains the corresponding frame, evidence, source, decision and coverage records. Stored V19 frame features include COT net/change/acceleration, WTI/Brent, funding stress, initial claims, retail consumption and official narrative activity/novelty. These are persisted observations, not manual verification fixtures.

Production inventory read on 2026-09-27 before this release:

| Metric | Value |
|---|---:|
| Snapshots | 41 |
| Current observations (rows counted) | 204 |
| Immutable vintages (latest snapshot diagnostic) | 829 |
| Production frames | 8 |
| Resolved direction outcomes | 48 (32 × 1D, 16 × 3D) |
| Separate event outcomes | 25 |
| 10/30/60/90D training examples | 0 |
| ML version | DETERMINISTIC_CORE |
| ML status | WAITING FOR DATA; no challenger yet |
| ML / hypothesis influence | 0% / 0% |
| Hypotheses | 72 testing; 0 active, 0 shadow, 0 rejected |
| Full Core coverage | 28/80 (35%) |
| Carried / partial Core factors | 29 / 23 |
| Latest research source reliability | 0.9736046666666667 |
| Cap | 10%, hard maximum 15% |
| Runtime configuration | Revision 9; no false adaptive flag; all three use enabled defaults |

The old umbrella status `SHADOW` is not evidence that a trained model exists. The new health response reports the actual ML lifecycle separately. Individual new source/factor status records are written by the new release on its next successful refresh. Existing aggregate D1 cells are truncated by the inspection connector, so a complete current failed-source list cannot be certified from those cells. No zero-failure assertion is made.

## Waiting and remaining source limits

Future 5/10/30/60/90D outcomes, sufficient independent chronological blocks, qualifying OOS plus subsequent shadow results, real active weight growth, and real degradation/rollback events remain future-data dependent. Technical branch tests are not real market validation. The new release's first genuine Cron, migration backup and CAD/SNB production writes must be confirmed after its next scheduled execution; V19's genuine proof does not certify these newer writes.

Not yet connected: a documented Seasonality Core estimator, validated Commodity Core exposure mapping, comparable non-US daily 2Y/10Y yields, remaining central-bank language coverage, FX options/IV/risk reversals, cross-currency basis, retail positioning, shipping/freight feeds, Google Trends, social/YouTube activity, forecast dispersion and broad-news coverage. Some World Bank country/indicator coverage remains incomplete. Metadata discovery is a bounded search of available provider metadata with deterministic transformations; it does not autonomously procure paid feeds or prove causation.

LIVE cannot be claimed while static risk anchors, carried Seasonality/Commodity inputs or other incomplete Core dependencies remain. These source gaps require actual reliable adapters/mappings; they are not solved merely by waiting for ML training. Adaptive validation can proceed on eligible observed features while the overall terminal remains PARTIAL LIVE.
