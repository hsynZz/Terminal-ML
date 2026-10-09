# Terminal operational completion — 2026-10-09

This update repairs transport and display behavior while preserving the existing Core, ML, Evidence, dominance, forecast and weighting formulas.

## Changes

- The page and `/api/terminal` read the same persisted snapshot. The page no longer starts with a temporary baseline, and unavailable storage produces an explicit unavailable state.
- Polling requests cannot overlap. A response started before a manual refresh cannot restore the older snapshot. Requests are aborted when their component unmounts.
- The chart waits for positive measured dimensions and reserves its layout space before rendering. The initial render test records no negative-dimension warning.
- Currency selection retains the existing comparison-universe semantics. The UI now states the selected group and explains that changing it can change relative percentages. Pair forecasts remain independent of this selection. The fixed-universe draft was excluded because it would change dominance behavior.
- Failed HTTP source responses release their bodies before retry or failure. The same cleanup covers seasonality downloads and failed large-move confirmations. Source access failures remain visible.
- The production panel reads independent queries concurrently, reuses committed statistical summaries when applicable, and reports `Server-Timing`. Immutable target integrity and runtime kill switches are still checked on reads; refresh/retrain qualification is preserved.

## Real production evidence before this deployment

The existing `fx-terminal-scheduler` Worker has a secret binding, a scheduled handler and enabled persisted logging. Its current triggers match the source; the Berlin-time guard selects daily 17:15 and Saturday 22:00 with retry slots and daylight-saving handling.

| Berlin date | Started slot | Stored snapshot (UTC) | Completion (UTC) | Result |
| --- | --- | --- | --- | --- |
| 2026-10-05 | 17:15 | 2026-10-05T15:15:56.082Z | 2026-10-05T15:16:53.571Z | SUCCESS |
| 2026-10-06 | 17:15 | 2026-10-06T15:16:10.430Z | 2026-10-06T15:16:39.765Z | SUCCESS |
| 2026-10-07 | 17:30 retry | 2026-10-07T15:31:14.900Z | 2026-10-07T15:31:44.484Z | SUCCESS |
| 2026-10-08 | 17:15 | 2026-10-08T15:15:42.466Z | 2026-10-08T15:16:13.504Z | SUCCESS |
| 2026-10-09 | 17:30 retry | 2026-10-09T15:30:52.308Z | 2026-10-09T15:31:26.790Z | SUCCESS |

The run receipts have `source=CLOUDFLARE_CRON`, HTTP 200 and `snapshotAdvanced=true`. On 7 and 9 October the first slot was interrupted. Site logs on 9 October report unconsumed HTTP response bodies and canceled requests. The transport cleanup addresses that observed failure path; the success of a later retry does not certify the first slot.

The regular weekly job has a completed `WAITING` receipt for 2026-10-03. Invocation alone does not mean trained challengers or adaptive activation.

## Validation

- 196 regression tests passed, zero failures.
- TypeScript `--noEmit` passed.
- Production build passed.
- No changes to `lib/model-engine.ts`, `lib/adaptive-evidence.ts`, `lib/terminal-data.ts` or `lib/production-data.ts` in this update. Existing numerical forecast/dominance fixtures pass.
- The source paths changed by this update match the pre-update GitHub main blobs, avoiding overwriting a divergent base.

## Remaining verification and data limits

- Production browser inspection is unavailable in this managed environment because the required `control-browser` surface is absent. Positive chart dimensions and the initial render are tested, but this is not a visual browser pass.
- The next genuine scheduled refresh must confirm that the HTTP deadlock warnings are gone. No artificial Cron or historical training outcomes are inserted for that claim.
- `Server-Timing` is now available for the status route; an authenticated production measurement is still needed before claiming a numerical latency improvement.
- No new data source or substitute definition is added. Previously audited compatible-yield gaps and Commodity/Risk definition blockers are not solved by this transport patch. Fresh coverage must be read from the next real collection; old audit counts are not presented as current coverage.
- Learning continues under the existing qualification gates. Future labels, sufficient effective information, independent validation and source quality cannot be manufactured by an operational repair.
