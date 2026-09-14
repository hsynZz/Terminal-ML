# Hypothesis integration contract

The production budget is still **0%**. This change does not grant permission to
enable it. Research continues automatically after the existing successful refresh.
The scheduler, its secrets, its schedules and the core model are unchanged.

## Input provenance

Refresh records the exact World Bank and FRED values actually received, their
economic periods and actual receipt times. Alpha Vantage momentum also retains
the daily closes used in that calculation. No API keys or keyed URLs are stored.
The economic period is not treated as a publication date. The guarantee is
"available to this application by receipt time", not an official release vintage.

Each snapshot contains a versioned SHA-256 checked provenance document.
Unchanged inputs can carry their original receipt forward. A missing or corrupt
certificate cannot be reused. Cross-sectional growth requires receipts for all
currencies in the normalization; inflation requires both rate and inflation.
Receiving a raw US yield does not certify a normalized yields factor that the
existing core never recalculated. Recursive risk retains the unverified status
of its old risk component. This deliberately exposes gaps rather than laundering
old seeded factors into live observations. Regime-dependent qualification also
requires provenance for the regime inputs. Existing factors with missing source
coverage may require future source-adapter work; waiting alone cannot supply it.

Frames retain the then-available provenance, factors and baseline forecasts.
Current and lagged inputs must have been received no later than their own frame.
Older frames are checked again before use. Missing inputs produce diagnostics
only. Qualification is labeled `as-received-v1` so an older diagnostic historical
pass cannot be treated as a new certified pass. Existing rejected IDs stay rejected.

## Immutable research outcomes

The existing calendar-day outcome definition is unchanged. Once the first
complete outcome is observable, research stores its label, actual entry/exit
prices, source and recording time under an insert-only `hypothesis:v1:outcome:`
key. Subsequent provider revisions cannot rewrite it. A hash mismatch fails the
research run closed. This does not assert that the provider's first value is the
ultimate true market price. These records are separate from all core training,
model, snapshot and price tables.

Historical qualification still needs 120 embargoed time blocks, three forward
validation folds and the frozen final holdout. Shadow still needs at least 30
new prospectively recorded blocks after qualification, the existing regime
coverage and the same 32-candidate repeated-look alpha spending. Unverified
diagnostic blocks remain visible but do not count toward qualification.

## Production target and bounds

The audited target is **base/USD up probability at exactly 10/30/60/90 days**.
The predeclared research target is `q = 0.5 + 0.4 * signal`; production uses
`p_final = p_core + weight * (q - p_core)` after qualification. The experiment
uses a 10% mixture; the smaller deployment mixture never exceeds 1% per idea.
This is a mapping into the same probability target, not a conversion of
probability units into fundamental score units.

- A newly eligible idea begins at 0.5%; each later statistical look with at least
  ten additional independent blocks may add 0.1%, up to 1%.
- Only one deterministic candidate ID is selected per pair/horizon. No unknown
  correlations are claimed as diversification. The configured layer budget is
  bounded by 5%; the effective per-prognosis bound here is at most 1%.
- Missing edge, worse calibration, missing provenance, failed research or stale
  evidence removes the contribution. Weak stability halves an existing weight
  only once per new look, provided the remaining statistical gates still pass.
- Inputs and the latest statistical evidence expire after 48 hours. Lack of a
  new independent outcome may therefore temporarily remove an allocation.
- A zero budget or engine kill switch returns the original API Response without
  reading research storage. The default remains zero.
- Core probability must still match the archived baseline exactly. A new model,
  snapshot or changed settings invalidate an incompatible overlay.
- Adjustment is additionally bounded by 2.5 percentage points. Confidence and
  sample counts are never increased. Interval endpoints shift by the same amount;
  they are not advertised as newly calibrated confidence intervals.
- An already-open dashboard rechecks an active overlay every 30 seconds and
  removes it if the server cannot confirm it. Inactive dashboards gain no timer.

The request adapter and dashboard use the same pure mapping. Any failure returns
the original core output. Fundamental scores, evidence rows, all cross-pair core
forecasts and the general currency cloud retain their existing calculations.
Other target mappings require separate evidence rather than extrapolation.

## Persistence and verification

All governance, outcomes and allocation writes use the existing hypothesis
namespace. No schema migrations or production fixtures are introduced. State,
allocation and audit decisions commit together. The most recent unsuccessful
research run blocks use of an older overlay. Allocation reads do not increase
weights or repeatedly apply reductions.

Existing bounded research limits remain: 1,024 frames, 20,000 price rows and
30,000 new outcome records. Exceeding a limit stops research visibly and leaves
the core operating. Longer histories need a separate paging/resource design.

GitHub Actions runs the lockfile installation, all regression tests and the Site
build on the development branch, pull requests and main. It has read-only code
permission and no production credentials or deployment steps. Existing golden
tests cover scores, evidence, model, cloud points and all 56 ordered currency
pairs at four horizons. Added synthetic tests cover receipt integrity, no future
input use, frozen labels, qualification chronology, allocations, bounds, zero
identity and API failure behavior. Synthetic examples never enter production.
