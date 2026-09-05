# Calibration audit

`GET /api/calibration` evaluates probabilities already recorded by refresh in
`model_debug_logs`, joined to the source snapshot. It does not regenerate old
predictions with current weights. The report is also linked from `/api/model-debug`.
Each request uses the currently available archive and realized Alpha Vantage closes;
no new provider, scheduler, schema or frontend component is required.
Refresh inserts are split into ten-row statements to respect D1's 100-bound-parameter
limit (https://developers.cloudflare.com/d1/platform/limits/). Earlier oversized
inserts could interrupt persistence before forecast logs were written.

## What is measured

Results are separate for 10/30/60/90 calendar days and for each archived pair
against USD. Ten probability bins compare mean predictions with observed up rates.
Brier score, log loss and expected calibration error are descriptive diagnostics.
Empty bins are null, small bins are flagged, and insufficient history is explicit.
Brier score alone is not evidence of calibration:
https://scikit-learn.org/stable/modules/calibration.html

The existing training walk-forward uses a simplified sigmoid formula. Its metrics
must not be interpreted as validation of the deployed ensemble, or of the
currency-cloud display whose benchmark changes with selection. This audit measures
only saved refresh pair predictions, not every forecast requested between refreshes
after a settings change. Baseline-only snapshots are excluded; partial-live
snapshots are included with an explicit limitation about baseline factors.

## Time and sampling policy

One forecast per pair/horizon/issuance day (the first) is retained. Entry is the first
complete daily close strictly after issuance, within four calendar days. The outcome
uses the first complete close on or up to four days after entry plus the horizon.
This is an explicit next-close holding-period audit, not an exact intraday return
from the issuance timestamp. Same-day and future closes are never used. Missing
prices and immature targets are counted; flat returns count as not-up. Daily FX
quotes represent USD per base currency. Provider revisions cannot be eliminated by
this archive because the price store is not a full vintage database.

All matured forecasts and a per-pair non-overlapping subset are both reported.
Shared USD exposure still creates cross-pair dependence. No binomial confidence
interval, effective independent sample count or calibrated-status claim is made.
100 rows and 30 dates only permit diagnostic status, not production approval.
Queries cover at most two years and flag a reached read limit.

## Shadow correction

A small temperature grid (1, 1.25, 1.5, 2, 3, 5) tests shrinking probabilities
towards 50%. For every test date it selects temperature using only outcomes that
had matured strictly before that date, requiring 40 non-overlapping training rows,
20 distinct issuance dates and both labels. Raw and candidate scores are compared
on exactly the same later test rows. These thresholds are conservative engineering
guards, not a proof of statistical significance. The candidate is NEVER applied to
live scores automatically. Reliable results require a longer archive, stability
across periods and a separate deployment decision. No probability improvement is
claimed before those outcomes exist.

Verification: `node --test tests/calibration.test.mjs tests/model-engine.test.mjs`.

## Horizon-specific learning and neutral decisions

The weekly retrain keeps one global learned model as the stable prior. A 10, 30,
60 or 90-day model becomes active only after at least 100 matured examples across
30 issuance dates and a successful horizon-specific walk-forward run. Its fitted
weights are partially pooled with the global weights using an 80-example prior.
Intermediate point-cloud horizons interpolate between their nearest trained anchor
horizons. Until a horizon clears the gate, forecasts use the global model.

Pair forecasts include a decision state (`up`, `down`, or `neutral`). The neutral
band expands modestly when confidence is lower or the model ensemble is more
dispersed. This state does not overwrite, round or otherwise change the probability;
it prevents small estimated edges from being presented as directional conviction.
