# Seasonality precision — 2026-10-18

Scope: the existing `/seasonality` calculation and chart. Existing colors, contrast, line colors and line weights are retained. Core, ML, Evidence, dominance, forecasts, scheduler, data sources and database schema are untouched.

## Defects corrected

- An explicit February 29 start/end was converted to March 1/February 28 on the display axis. A February 29-only window could consequently display 365 unrelated days; February 29 endpoints could omit the actual exit fixing. The selected axis now retains its exact leap-day boundary, including windows crossing New Year. Full-February presets still map non-leap years to their actual month end. The annual axis remains 365 days.
- A floating tooltip used percentages of the full chart without accounting for horizontal zoom/scroll. Values now live outside the scrolling SVG, and pointer coordinates use the actual rendered bounds. Axis margins cannot accidentally select January 1 or December 31.
- Drag selection rejected adjacent days. Both drag directions now accept them and preserve the displayed ordering across New Year.
- A best/worst window year could be valid for the chosen window but excluded from the annual chart. Focusing it now opens its window path. Other selected years are displayed only when valid for the current chart sample.

## Precise operation

- Exact calendar-date selector, one-day buttons, arrow keys, Shift+arrow for seven days, Home/End and a pinnable cursor. Escape releases it and cancels selection.
- “Als Start” / “Als Ende” set boundaries from the cursor. “Auswahl im Detail” opens the selected window, rebased to its first actual fixing. The readout identifies the current normalization basis.
- Mouse/pen dragging and an explicit touch selection mode. Ordinary touch interaction preserves scrolling and pinch gestures; tapping fixes the inspected day.
- The SVG follows its measured container width and supports 1×/2×/4× zoom. Cursor navigation keeps the selected day in view. Thin, unsmoothed paths and existing colors are preserved.
- Values show percentage return and index to three decimals, the sample at that date, and each displayed individual year's actual source-fixing date. Carried values are labelled. Display rounding does not change calculations or imply greater source accuracy.
- Cursor context resets on pair, cutoff, vintage mode and displayed-axis changes. Hidden or invalid year curves do not affect scaling or dim the remaining lines.

## Validation

- Both new leap-boundary regressions failed on the previous code and pass after the fix. Endpoints reconcile with actual window returns, including New Year crossings and full-February presets.
- 57 focused calculation, geometry and server-render checks pass. These include pointer mapping at normal, zoomed/scrolled and phone widths; adjacent-day selection; missing values; source-date carry labels; and accessible controls.
- Full local suite: 205 tests passed. TypeScript and the production build pass. The existing 90,788-observation pinned archive, all 56 oriented pairs and 20 independent historical-window calculations remain covered.
- The complete AUDCAD 20-year October 3–27 baseline remains unchanged: mean 0.9409739784428961%, median 1.217700398039867%, sample 20.
- Read-only production inspection before deployment: seasonality state READY, last successful import 2026-10-18T15:17:39.031Z, stored quotes through 2026-10-09, no lastError or import issues. This is not a claim about a post-deployment scheduled run.
- Browser/device interaction and visual QA remain unverified because the supported managed browser-control capability is unavailable. Geometry and SSR checks do not substitute for a browser test.
