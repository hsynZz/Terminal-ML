# FX automation deployment

This account-scoped Cloudflare Worker only invokes the existing terminal processes.
Do not deploy it to a dispatch namespace. The private Sites application and its D1 remain in place.

- Daily: 17:15 Europe/Berlin, retries 17:30 and 17:45.
- Weekly: Saturday 22:00 Europe/Berlin, retries every 15 minutes through 22:45.
- UTC schedules cover both offsets; `dueJob` rejects the other offset, including DST transition days.
- The site serializes automated calls with a 15-minute lease and deduplicates completed schedule periods.
- Insufficient training samples return WAITING and finish the weekly attempt. No training threshold is changed.
- `/api/refresh`, `/api/retrain`, `/api/forecast` and all trading modules remain unchanged.

Required Cloudflare Worker secrets (never commit their values):

1. `SITES_API_TOKEN`: the existing Sites machine API bearer accepted in `OAI-Sites-Authorization`.
2. `AUTOMATION_SECRET`: the same secret stored in the existing Site runtime.

From the project root, with the correct Cloudflare account authenticated:

```
npx wrangler secret put SITES_API_TOKEN --config worker/scheduler/wrangler.jsonc
npx wrangler secret put AUTOMATION_SECRET --config worker/scheduler/wrangler.jsonc
npx wrangler deploy --config worker/scheduler/wrangler.jsonc
```

Deployment alone is not verification. Read the account-scoped Worker's schedules API and deployed version,
then inspect a real `scheduled` event, its run ID and `/api/health` on the private terminal.
A CONTROLLED_TEST or MANUAL record must never be reported as evidence of an active cron.
If API access is unavailable, report scheduler deployment and activation as NICHT VERIFIZIERT.

Health reports current snapshot, stored model fingerprint/metadata, latest successful runs and recent logs.
Operational records are stored under `automation:` keys in the existing `terminal_settings` table;
they never modify its `model` key. Historical runs before this instrumentation are not backfilled.
FAILED and unfinished runs remain inspectable. Source/API errors before the Site is reached appear
in this scheduler's Cloudflare logs; absence of a fresh scheduled event is visible in Site health.

The scheduler performs network forwarding only; it does not run ML in its CPU budget.
Runtime availability and API quotas still depend on the hosting and data providers.
