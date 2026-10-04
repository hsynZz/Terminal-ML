# FX Seasonality — isolated historical research

Calculation version: `fx-seasonality-v2`. Normalization: `usd-per-unit-v1`. See [v2 quality and presentation changes](FX_SEASONALITY_V2.md). The original source audit remains unchanged as the regression baseline.

This feature has no connection to Core factor weights, ML training, hypothesis discovery, Evidence, rankings, dominance, forecasts or trade selection. It is a separate `/seasonality` research route. Existing forecast fixtures and scoring code are unchanged.

## Official data

The primary feed is Federal Reserve H.10, distributed by FRED. These are daily New York **noon reference rates**, not exchange closing prices. H.10 normally publishes the preceding week's observations on Monday after 16:15 New York time. Therefore a daily updater does not imply a newly published daily price.

Sources: [H.10 methodology](https://www.federalreserve.gov/releases/h10/about.htm), [H.10 archive](https://www.federalreserve.gov/releases/h10/data/FRB_h10_xml.zip), and [FRED CSV](https://fred.stlouisfed.org/graph/fredgraph.csv?id=DEXUSEU,DEXUSUK,DEXUSAL,DEXUSNZ,DEXJPUS,DEXSZUS,DEXCAUS&cosd=1971-01-01&coed=2026-10-01).

The real bootstrap receipt is pinned in `public/data/seasonality/h10-bootstrap-source.json`. Retrieved 2026-10-01, observations through **2026-09-25**, 90,788 nonempty observations. No artificial production quotes or outcomes are included.

| Currency | FRED series | Raw units | First fixing | Fixings | Missing source cells* |
|---|---|---|---|---:|---:|
| EUR | DEXUSEU | USD / EUR | 1999-01-04 | 6,955 | 280 |
| GBP | DEXUSUK | USD / GBP | 1971-01-04 | 13,976 | 564 |
| AUD | DEXUSAL | USD / AUD | 1971-01-04 | 13,969 | 571 |
| NZD | DEXUSNZ | USD / NZD | 1971-01-04 | 13,960 | 580 |
| JPY | DEXJPUS | JPY / USD | 1971-01-04 | 13,970 | 570 |
| CHF | DEXSZUS | CHF / USD | 1971-01-04 | 13,976 | 564 |
| CAD | DEXCAUS | CAD / USD | 1971-01-04 | 13,982 | 558 |

*Blank/dot cells since each series' start, including non-publication holidays; not asserted to be unexpected missing trading days. Weekends are not quote observations. USD/USD = 1 is a mathematical identity, not an invented source series. Each exact series URL is `https://fred.stlouisfed.org/series/<ID>`.

## Normalization and crosses

Store `u(currency) = USD per one currency unit`. Identity conversion for EUR/GBP/AUD/NZD; inversion for JPY/CHF/CAD. For any oriented pair A/B:

`price(A/B, date) = u(A, date) / u(B, date)`

Only exact same-date legs are joined. A missing leg produces no cross on that date. There is no asynchronous forward filling between source legs. All 56 distinct oriented pairs are supported, including inverses. Cross provenance reconstructs both canonical source pairs, operation, original source IDs and normalization version. For example, AUDCAD is raw DEXUSAL × raw DEXCAUS; EURJPY is raw DEXUSEU × raw DEXJPUS. These identities are tested separately from the generic implementation.

## Data quality, persistence and automation

- Additive migration `0003_serious_firebrand.sql` adds only `seasonality_fx_rates`, `seasonality_sync_state` and `seasonality_sync_runs` to the existing DB. No existing table, record, scheduler, binding, secret or URL is replaced.
- Immutable receipt vintages retain revisions **and later reversions**. Unchanged values/quality are not inserted again. The compound `(base_currency, date, ingested_at)` primary key supports latest-vintage and cutoff reads; the query-plan test verifies index use.
- Raw quote, canonical quote, source ID, normalization, quality and verification are retained. Exact historical publication times are unavailable and stay NULL. HTTP Last-Modified is transport metadata, not a vintage availability date. Production `ingested_at` is captured after receipt and validation, not backdated to the job start.
- Validate exact CSV schema, duplicate dates, valid ISO observation dates, weekday fixings, finite positive prices, series start, future data and large moves. Conflicting duplicates, malformed rows, invalid/future observations or a missing series fail the update. Unchanged stored history survives failure.
- Moves greater than a 1.12 multiplicative ratio in either direction are quarantined until the exact value is corroborated in the official Fed archive. Five actual historic observations were confirmed in the downloaded Fed XML; the receipt and exact values are in `h10-verified-large-moves.json`. This is source corroboration, **not** an economic explanation or a statistical edge. A changed/revised value does not match the old confirmation.
- Initial import loads all official history. If the live fetch fails, the pinned real official archive may bootstrap; the UI/health labels `OFFICIAL_ARCHIVE_BOOTSTRAP` and preserves the live-fetch error. It never represents an old archive as a new fixing.
- The existing daily refresh at **17:15 Europe/Berlin** queues the separate updater. The existing retry schedule remains unchanged. Initial authenticated access can queue the same import before the next daily run. A separate lease prevents duplicate jobs; successful receipts are rate-limited to 20 hours.
- Incremental retrieval overlaps 35 days to pick up corrections. A full source reconciliation is attempted every 30 days. Provider revisions outside the overlap are therefore not guaranteed to arrive before the next full reconciliation.
- Normal page reads use D1, not a fresh external history download. Client calculations are memoized, with at most four pair histories cached for five minutes. HTTP cache is private and limited to five minutes.
- `FRESH` allows ten calendar days since the last fixing, reflecting weekly publication plus holiday buffer. The visible pair freshness uses its **last shared fixing**, not a newer unrelated currency. Historical views assess age relative to their selected cutoff.
- API routes remain behind the terminal's existing authentication; POST sync also requires same-origin. A user-supplied schedule header is not accepted as genuine Cron provenance for this module.

## Calendar, windows and look-ahead

Named 5Y / 10Y / 15Y / 20Y / 25Y cohorts request exactly the preceding completed calendar years. As of 2026-10-01, 15Y means **2011–2025**. No 2026 outcomes enter that cohort. Each window is independently checked. Five or more valid windows are usable; fewer than the requested number are explicitly PARTIAL, never relabelled as a full sample. Individual verified results remain inspectable below five, but aggregates are unavailable. MAX and custom periods use the same rules and show every exclusion.

A full eligible chart year requires at least 240 official shared fixings, start/end coverage within seven calendar days, no internal gap longer than seven days and no unconfirmed jump. Annual chart cohorts are independent of window cohorts. A gap outside a selected window no longer erases that valid window. The original v1 source audit retains its stricter whole-year-gated window counts as historical evidence; v2 coverage is separately audited.

- A window enters at the first fixing **on or after** the chosen start; exits at the last **on or before** its end. No pre-window entry. Each boundary shift is at most four calendar days; internal gaps are at most seven days; at least two fixes are required. Actual entry/exit dates and prices are visible per year.
- Cross-year windows require the entire end-year to be completed too. As of 2026, a December–January window last starts in 2024 and ends in 2025.
- Charts align by real **month/day**, never by array position. The annual display omits Feb 29 without shifting March. A manually selected Feb 29 endpoint remains unavailable in non-leap years. Full-month presets explicitly use each year's actual month-end; the February window chart adds a labelled month-end position with the actual Feb 28/29 source date. No price is fabricated.
- Each year's chart is normalized as `100 × P(t) / P(start)` and displayed as percent return since that first fixing (index minus 100). Average remains arithmetic; median is independent. The empirical 25th–75th percentile band is historical dispersion, NOT confidence or a forecast range. A point needs five contributions for aggregates. Display-only calendar carry remains at most four days; no fill before the first fixing. Crosshairs show sample size and source dates.
- The current-year overlay is separate, stops at its last actual fixing and has no projected continuation. Unconfirmed current-year jumps hide that overlay instead of creating a misleading path.
- **Retrospective** mode clips calendar observations to the cutoff but uses the latest stored provider vintage. It is explicitly not a historically revision-safe backtest.
- **Point-in-time** mode permits only receipt vintages archived by the cutoff. It returns DATA_UNAVAILABLE for dates before this archive began. No historic publication time or pre-existing vintage is fabricated.

## Exact statistics

All returns describe being long the pair's base currency. No transaction costs, spread, financing, swap or carry are included.

| Metric | Definition |
|---|---|
| Window return | `P(end) / P(start) − 1` |
| Log return | `ln(P(end) / P(start))`; exact sum of adjacent-fixing log returns |
| Average | Arithmetic mean of the simple yearly window returns |
| Median | Middle sorted return, or mean of the two middle returns |
| Positive share / win rate | `positiveYears / validYears`; flats remain in denominator |
| Standard deviation | Sample SD of simple yearly window returns, divisor `n−1` |
| Spot Return Sharpe (rf=0) | Mean pooled daily log spot returns / their sample SD × √252 |
| Cross-Year Consistency | Mean simple window return / its sample SD; not annualized, not Sharpe |
| Spot Sortino (rf=0) | Mean daily log return / √mean(min(return,0)²) × √252 |
| MFE / MAE | Maximum positive / negative simple return from window entry across actual published fixes, including entry zero |
| 10% trimmed mean | Remove `floor(.1 × n)` simple returns from each tail, then average; n≥10 |

Sharpe/Sortino require at least five valid years and twenty adjacent-fixing returns. Insufficient samples and zero/near-zero denominators are N/A, not infinity. Adjacent daily observations may span weekends/holidays: there are no inserted zero daily returns. MFE/MAE are **noon-fixing excursions, not intraday highs/lows**.

Descriptive direction is Positive only when mean and median are positive and more than half the years are positive; Negative is symmetric; otherwise Mixed. It is not a confidence, ranking or trade signal. Comparing many pairs and windows can find chance patterns. No predictive validation or profitability is asserted.

## UI and accessibility

Dedicated terminal navigation, searchable 56-pair selector with currency filters and inversion, lookback controls, custom historical period/cutoff, average/median/current overlays, selectable historical years, draggable seasonal window plus keyboard-accessible date fields, keyboard crosshair, click/focus definition popovers, best/worst highlighting, sortable year table, robustness comparison and provenance panel. Responsive styles and reduced-motion handling are included. Loading, unavailable, stale and initial-import states do not show placeholder returns.

## Validation evidence

`docs/seasonality-source-audit.json` contains source receipts/hashes, all 20 independently recomputed windows, pair coverage, exact source legs and local persistence results.

1. All **90,788** nonempty FRED quotes were matched against the official Fed H.10 XML: **zero mismatches**. Fed and FRED are the same originating source; this is transport/quote confirmation, not independent market evidence.
2. Independent Python arithmetic from raw source legs was compared with the TypeScript engine for EURUSD, AUDUSD, USDCHF, AUDCAD and GBPCAD in October 2010, June 2016, March 2020 and October 2025. Maximum absolute price/return/excursion difference: **4.44e−16**.
3. The same entry/exit dates were compared with the independent [ECB reference archive](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.xml). All conventions/scales were checked; exact equality is not expected. [ECB reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html) and Fed noon rates use different fixing times. Differences are retained, not adjusted away. This does not establish the cause of every price discrepancy or statistical predictive value.

Example external check, **2025-10-03 → 2025-10-27**:

| Pair | Fed start | Fed end | Fed return | ECB return | Difference (bp) |
|---|---:|---:|---:|---:|---:|
| EURUSD | 1.1747 | 1.1636 | −0.94492% | −0.80109% | −14.383 |
| AUDUSD | 0.6615 | 0.6554 | −0.92215% | −0.66694% | −25.521 |
| USDCHF | 0.7949 | 0.7965 | +0.20128% | −0.04482% | +24.610 |
| AUDCAD | 0.9225279 | 0.9172323 | −0.57403% | −0.54305% | −3.098 |
| GBPCAD | 1.88006026 | 1.86567345 | −0.76523% | −0.62042% | −14.481 |

Across all 20 windows, return differences range from −115.655 bp (GBPCAD, June 2016) to +176.702 bp (AUDUSD, March 2020). Even the sign can differ near zero. Do not treat different daily fixings as interchangeable execution prices.

4. A local D1-compatible SQLite integration imported all 90,788 real observations, re-imported without duplicates, queried 20Y AUDCAD statistics through the actual API function, and confirmed that all six checked Core/ML-related tables remained untouched. Local timings are recorded, not represented as Cloudflare production timings.
5. Hand examples: prices `100,90,120,110` produce +10% return, +20% MFE and −10% MAE. Returns `+.10,−.05,+.20,0` give mean .0625, median .05, positive share .5 and sample SD `sqrt(.036875/3)`. Both are local test fixtures only.

Reproduce with the downloaded source documents and their `<path>.receipt.json` metadata:

```sh
node scripts/audit-seasonality.mjs /path/ecb.xml /path/fed.zip docs/seasonality-source-audit.json
node --test tests/seasonality.test.mjs
npm test
```

The external audit pins the exact Fed archive hash; a newer provider archive must be reviewed before replacing the validation receipt. The bundled real CSV and stored raw source legs allow deterministic calculation regression without network access.

## Release verification boundaries

- Existing release baseline: 143 tests passed before implementation; forecast reference fixture is unchanged.
- New module: 35 focused unit/integration/data tests cover normalization/all 56 pairs, leap/calendar/windows, no-look-ahead, statistics, data failures, immutable vintages, API validation, source integrity and isolation. **178/178 full-suite tests, TypeScript and production build passed on 2026-10-01.** Lint: zero errors, one pre-existing scheduler default-export warning. GitHub CI and deployment results are recorded in the final release handoff.
- Browser interaction/layout E2E could not be verified: the managed browser preview was blocked (`ERR_BLOCKED_BY_CLIENT`). This is **not** a passed browser test. There was no attempt to bypass the blocked preview or weaken authentication.
- A successful deployment/migration is not proof that a genuine post-release Cron has run. Only an actual production `seasonality_sync_runs` record with `source=CLOUDFLARE_CRON` qualifies. Local tests and initial page-triggered imports remain separately labelled.
- Intentionally absent: intraday prices/highs/lows, broker execution prices, carry/excess-return Sharpe, automatic trade signals, seasonality-derived ML/Evidence weights and invented historical point-in-time vintages.
