# Seasonality v2 — availability, precision and overview

Scope: existing `/seasonality` route only. Core, ML, hypotheses, Evidence, dominance, forecasts, runtime flags, scheduler and the existing DB remain unchanged. No new source, synthetic quote, database, backdated vintage or manual activation.

## Findings and repairs

1. **All-or-nothing availability:** v1 disabled a named lookback if a single year was incomplete, including gaps outside the requested window. v2 validates the exact window separately; `19/20` stays 19 observations and is explicitly PARTIAL. Annual paths keep the strict 240-fixing/full-year checks. Fewer than five windows never produces an aggregate.
2. **Mixed-range source diagnostics:** genuine production incremental jobs returned 83,858 parsed rows because the multi-series provider response retained long history for some legs but not EUR. This did not delete the earlier 90,788-row archive. v2 bounds every leg and missing-cell counter to the actual import range, exposes separate total observation/vintage counts and last-import rows, and rejects source-date regression. Blank source cells (including holidays) are not asserted to be missing trading days.
3. **Unclear percentages and variation:** chart axes/tooltips now use percent returns from the first actual fixing. Mean and median remain separate. An empirical interquartile band and individual-year return bars expose dispersion. No confidence, predictive quality or increased source precision is claimed.
4. **Timeframes:** twelve-month overview (mean/median/positive share), exact-cell heatmap, quarter/year shortcuts and existing custom windows. Every month has its own numerator/denominator. Clicking cells shows actual entry/exit dates and source-derived prices. The full-February preset handles Feb 28/29 explicitly and reconciles the heatmap, window statistics and last curve point.
5. **Missingness:** selectable lookbacks, understandable year-by-year exclusion reasons, independent curve/window sample counts, readable source age and same-date fixing coverage. Missing data are not zero returns. A larger requested period cannot create earlier EUR history before 1999.

## Unchanged arithmetic

Window entry remains the first official fixing on/after start; exit the last on/before end. Boundary shifts ≤4 calendar days; internal gaps ≤7 days; no unverified large move. Crosses require same-date legs. Monthly returns use first-to-last fixing WITHIN the month, not the previous month's closing fixing; no omitted overnight move is silently treated as observed.

The v1 complete AUDCAD 20-year October 3–27 reference is protected field-by-field against `seasonality-source-audit.json`, including its mean **0.9409739784428961%**, median **1.217700398039867%** and 20-window sample. Existing 20 independently calculated real-source windows remain regression tests.

Quantiles use sorted empirical observations with linear `(n−1) × p` interpolation. Actual quote arithmetic remains full precision; additional displayed digits are not evidence of more precise underlying fixing quotes.

## Verification

- Baseline before edits: 35 seasonality tests passed; prior source audit and raw archive preserved.
- Full regression: **191 tests passed**, including unchanged Core/forecast propagation fixtures. TypeScript passed; lint had zero errors and one pre-existing scheduler warning. The isolated component-render test uses its own Vite cache to avoid interfering with other test processes.
- `node --test tests/seasonality.test.mjs tests/seasonality-overview.test.mjs`: calculation, source, import, vintage, sample, leap-year and server-rendered component regressions.
- `node scripts/audit-seasonality-coverage.mjs`: all 56 oriented pairs and 13,440 year/month cells from the pinned 90,788-observation real archive. Report in `seasonality-v2-quality-audit.json`.
- Real partial example: EURUSD, as-of 2007-10-01, requested ten years → eight usable (1999–2006), with 1997/1998 explicitly unavailable.
- Fresh native production read on 2026-10-04: last genuine seasonality Cron started **2026-10-04T15:16:17.704Z**, SUCCESS at **15:16:28.451Z**, source `CLOUDFLARE_CRON`; source quotes through **2026-09-25**. This proves the existing v24 collector, not a post-v2 Cron event.
- Browser E2E remains unverified: the managed browser-control prerequisite is unavailable in this session. Prior attempts were blocked by client infrastructure. Component SSR checks are not browser interaction or visual QA.

No assertion of a trading edge, improved forecasting accuracy, missing-source reconstruction or future production event follows from these checks.
