# Hypothesis Lab v1 — isolated research release

## Safety boundary / completion status

Current production contribution is **exactly 0%**. Core modules are not edited or
connected to research. `HYPOTHESIS_ENGINE_ENABLED=false` disables research jobs.
`HYPOTHESIS_PRODUCTION_WEIGHT` defaults to 0 and accepts only finite [0,.05].
`LIVE_INTEGRATION_APPROVED=false` is an additional hard interlock: setting the
environment weight cannot activate scores. No secret changes are necessary.

This release implements a research laboratory, **not the entire requested
autonomous production-promotion system**. The existing snapshots have no reliable
per-input publication/vintage/imputation lineage. That prevents honest production
certification. A future integration review must specify how a horizon-specific
probability signal maps to the core's multiple distinct score/latent surfaces.
Blindly adding probability points to fundamental strength would be incorrect.
The separate `safety.ts` policy is tested but is not a live integration.

## Search and definitions

Eight fixed interpretable templates × 10/30/60/90 calendar days = 32 lifetime
variants for protocol `hypothesis-v1`. IDs include template and horizon. Definitions,
inputs, economic rationale, direction and regime are in the registry and UI.
No coefficient tuning, random searches, new services, NLP calls or paid feeds.
Rejected IDs remain recorded and are never regenerated in this protocol.
The current factory does not autonomously invent new mathematical templates.
Surprise/consensus hypotheses are deliberately absent without consensus history.

Inputs are **as-recorded normalized terminal factors**, not raw economic levels.
Relative means base minus USD. Lags use calendar time with at most four days of
backward tolerance. Missing, nonfinite or out-of-range factors produce no signal.
Prospective probability: `.9 * archived/current core probability + .1 * (.5 + .4*s)`.
This fixed diagnostic experiment is not a 10% production weight.

## Provenance and observations

Historical import reads up to 128 existing snapshots and their actually archived
USD-pair baseline forecasts. It does not recompute old baselines with today's ML.
The existing close/outcome resolver is reused unchanged: entry is the first daily
close strictly after issuance; exit is at/after the calendar horizon, tolerance four
days; only completed daily bars strictly before today count.

Historical frames have `origin=ARCHIVED_SNAPSHOT`, historic `issuedAt` and today's
`recordedAt`. They never count as prospective shadow. New frames have
`origin=PROSPECTIVE_CAPTURE`, issuedAt=recordedAt, and store the then-saved model's
baseline probabilities. Frames are insert-only in an independent namespace.
No baseline hydration is used to manufacture missing research observations.
However existing factors can already contain fallbacks: `pointInTimeVerified=false`
is explicit for ALL currently available inputs. Research metrics are diagnostic.
Live closes are read from existing observations and are not certified immutable
price vintages. Missing prices remain pending, never synthesized.

## Statistical protocol

Group all currencies on an issuance day into one panel time block; average paired
Brier improvements within that block. Deduplicate pairs. Later blocks start after
the previous outcome AND a full additional horizon embargo. This reduces overlap
and USD pseudo-replication, but does not prove independence or remove all regimes.

First 120 completed blocks are frozen: 20 development, 20 reserved training,
three subsequent 20-block forward validation folds, then 20 final OOS blocks.
There are no fitted parameters in these fixed templates; the training reserve is
not secretly reused as confirmation. No random splitting or future features.
Final holdout is tested once. Failing templates are archived, not retuned on it.
Folds must improve mean Brier and log loss and have >=60% positive blocks.

The primary one-sided exact sign test tests a positive **median panel Brier loss
improvement**, not causality or mean-return significance. Ties count as failures.
The 95% order-statistic interval is for the median block effect, not the mean.
Accuracy, Brier, log loss, ECE/bins, mean Brier improvement and positive-block
stability are reported; correlations alone do not qualify an idea.

Family-wise alpha allocation: `.05 / 32 / (look*(look+1))` for every template/horizon.
Historical confirmation is look1; each later shadow look spends the next amount.
The sum over all ideas and infinitely many looks is <=.05 **provided individual
test assumptions hold**. Dependence between ideas is allowed by the union bound;
serial independence of within-idea time blocks is not guaranteed. Production
remains blocked rather than claiming that this correction solves market dependence.
Reference: [Tian & Ramdas, online FWER](https://arxiv.org/abs/1910.04900).
Temporal split reference: [TimeSeriesSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html).

## Shadow and future production

A historical pass enters SHADOW at the real current timestamp. Only subsequently
issued, prospectively recorded SHADOW rows count. At least30 new embargoed blocks;
evaluate only after ten new blocks. Baseline degradation yields DEGRADED, zero weight.
Unconditional ideas require two regimes with at least ten blocks; conditional ideas
require thirty blocks in their declared regime. No post-hoc regime mining.
PIT certification is required even for VALIDATED. Current sources cannot supply it.
These requirements can take many years, especially at90D, not merely a few weeks.

The **unconnected** safety proposal starts at .5%, increases by .1% per ten new
independent blocks, caps each idea at1% and the complete layer at5%. It rejects
missing/stale evidence (>48h), invalid signals, unvalidated regimes; missing edge
or worse calibration ->0, weak stability ->half. Same-family or abs(correlation)
>=.8 ideas are deduplicated; unknown correlation is not counted as diversification.
Proposed aggregate currency adjustment is capped at±.025 on [0,1], so it cannot
reverse a core pair strength gap >=.1. This policy is synthetic-test coverage,
NOT proof of a connected or statistically validated production layer.

## Persistence, automation and resources

Only `terminal_settings` keys prefixed `hypothesis:v1:` are written: independent
lease, state, insert-only frames, audit packages, run records and last-run status.
No schema changes, core settings writes, deletions, snapshot/model changes.
State and decisions commit atomically; frame retries use insert-ignore.
Research failures do not change refresh/retrain response bodies or status codes.
One successful evaluation per UTC day; failed attempts can retry. After successful
existing refresh, `waitUntil` runs research. Existing separate scheduler and its
Cron/DST/retry logic are untouched. Weekly retraining is untouched.
Authenticated same-origin POST `/api/hypotheses/run` allows a controlled research
test without refreshing data or retraining; GET `/api/hypotheses` returns status.

Bounded reads:1024 research frames,20,000 prices, historical import128 snapshots /
5,000 archived forecasts. Exceeding a bound stops research visibly, never drops
rows to select a convenient result. Long-history operation needs incremental/paged
research before these limits are reached. No promise of perpetual operation within
free compute limits. Lease is separate and expires after120 seconds.

## Known incomplete requirements

- Automatic production influence / production promotions: NOT IMPLEMENTED live;
  safety policy only. Need certified provenance and a separately verified mapping.
- Newly learned template generation, post-hoc validated regime discovery, long-history
  paging, immutable outcome archival and indefinite-volume execution: not implemented.
- Actual live shadow success and prediction improvement: WAITING FOR DATA.
- Real background scheduling and production research runs: must be verified from
  persisted run records, not inferred from code, deployment or synthetic tests.
- Browser QA may be unavailable independently of successful build/unit tests.

Tests in `tests/hypothesis.test.mjs` use synthetic fixtures, never write synthetic
training/snapshot data to production. Golden SHA-256 outputs were captured before
implementation from source tree2e23b19: core scores, evidence, model, clouds, and all
56 ordered pairs ×4 horizons. Synthetic SQLite verifies persistence and failures.
