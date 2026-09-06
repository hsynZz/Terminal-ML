import { berlinParts, classifyOutcome, dueJob, jobPath, type JobType, type RunSource } from "./automation-policy";

// Operational records use isolated keys in the existing key/value table.
// The model key and all domain tables are read-only here.
type Database = {
  prepare(sql: string): {
    bind(...values: unknown[]): any;
    first<T = Record<string, unknown>>(): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    run(): Promise<{ meta: { changes: number } }>;
  };
};
type Environment = { DB: Database; AUTOMATION_SECRET?: string };
type Invoke = (request: Request) => Promise<Response>;
type Run = {
  id: string; timestamp: string; completedAt: string | null; type: JobType;
  source: RunSource; status: string; message: string; httpStatus: number | null;
  scheduledTime: string | null; cron: string | null; period: string;
  snapshotBefore: string | null; snapshotAfter: string | null; snapshotAdvanced: boolean;
  trainedAtBefore: string | null; trainedAtAfter: string | null;
  trainingSamples: number | null; modelStateChanged: boolean;
};
const LEASE_MS = 15 * 60 * 1000;

async function state(db: Database) {
  const [snapshot, model] = await Promise.all([
    db.prepare("SELECT as_of FROM terminal_snapshots ORDER BY as_of DESC LIMIT 1").first<{ as_of: string }>(),
    db.prepare("SELECT value, updated_at FROM terminal_settings WHERE key = 'model'").first<{ value: string; updated_at: string }>(),
  ]);
  return { snapshot: snapshot?.as_of ?? null, model: model ? JSON.parse(model.value) : null,
    modelRaw: model?.value ?? null, modelUpdatedAt: model?.updated_at ?? null };
}

async function writeRun(db: Database, run: Run) {
  await db.prepare("INSERT INTO terminal_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(`automation:run:${run.id}`, JSON.stringify(run), run.completedAt ?? run.timestamp).run();
}

function output(run: Run, http = 200) {
  return Response.json(run, { status: http, headers: { "Cache-Control": "private, no-store", "X-FX-Automation-Run": run.id } });
}

export async function executeJob(env: Environment, invoke: Invoke, type: JobType, source: RunSource,
  options: { scheduledTime?: number; cron?: string; request?: Request } = {}) {
  const now = Date.now();
  const scheduled = options.scheduledTime ?? now;
  const run: Run = { id: crypto.randomUUID(), timestamp: new Date(now).toISOString(), completedAt: null,
    type, source, status: "RUNNING", message: "Endpoint started", httpStatus: null,
    scheduledTime: source === "CLOUDFLARE_CRON" ? new Date(scheduled).toISOString() : null,
    cron: options.cron ?? null, period: berlinParts(scheduled).date,
    snapshotBefore: null, snapshotAfter: null, snapshotAdvanced: false,
    trainedAtBefore: null, trainedAtAfter: null, trainingSamples: null, modelStateChanged: false };
  let response: Response | undefined;
  let invoked = false;
  let leased = false;
  try {
    // A single shared lease serializes automated refresh and training without changing either endpoint.
    if (source !== "MANUAL") {
      const lease = await env.DB.prepare("INSERT INTO terminal_settings (key, value, updated_at) VALUES ('automation:lease', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE json_extract(terminal_settings.value, '$.expiresAt') < ?")
        .bind(JSON.stringify({ owner: run.id, expiresAt: now + LEASE_MS }), run.timestamp, now).run();
      leased = lease.meta.changes > 0;
      if (!leased) {
        run.status = "WAITING"; run.message = "Another automation is in progress";
        run.completedAt = new Date().toISOString(); await writeRun(env.DB, run);
        return output(run, 409);
      }
      if (source === "CLOUDFLARE_CRON") {
        const previous = await env.DB.prepare("SELECT value FROM terminal_settings WHERE key = ?")
          .bind(`automation:completed:${type}:${run.period}`).first();
        if (previous) {
          run.status = "WAITING"; run.message = "This scheduled period already completed";
          run.completedAt = new Date().toISOString(); await writeRun(env.DB, run);
          return output(run);
        }
      }
    }
    const before = await state(env.DB);
    run.snapshotBefore = before.snapshot;
    run.trainedAtBefore = before.model?.trainedAt ?? null;
    await writeRun(env.DB, run);
    const request = options.request ?? new Request(`https://fx-terminal.internal${jobPath(type)}`, {
      method: "POST", headers: source === "CLOUDFLARE_CRON" ? { "x-fx-schedule": options.cron ?? "external" } : {},
    });
    invoked = true;
    response = await invoke(request);
    run.httpStatus = response.status;
    let body: Record<string, unknown> = {};
    try { body = await response.clone().json(); } catch { /* Classified as an unexpected response. */ }
    Object.assign(run, classifyOutcome(type, response.status, body));
    const after = await state(env.DB);
    run.snapshotAfter = after.snapshot;
    run.snapshotAdvanced = after.snapshot !== null && after.snapshot !== before.snapshot;
    run.trainedAtAfter = after.model?.trainedAt ?? null;
    run.trainingSamples = typeof body.samples === "number" ? body.samples : after.model?.trainingSamples ?? null;
    run.modelStateChanged = after.modelRaw !== before.modelRaw;
    if (run.status === "SUCCESS" && type === "DAILY_REFRESH" && (!after.snapshot || after.snapshot !== body.asOf)) {
      run.status = "FAILED"; run.message = "Refresh response does not match persisted snapshot";
    }
    if (run.status === "SUCCESS" && type === "WEEKLY_RETRAIN" &&
      (after.model?.trainedAt !== body.trainedAt || !run.modelStateChanged)) {
      run.status = "FAILED"; run.message = "Training response not reflected in stored model";
    }
    if (run.status === "WAITING" && type === "WEEKLY_RETRAIN" && run.modelStateChanged) {
      run.status = "FAILED"; run.message = "Waiting endpoint unexpectedly changed model state";
    }
    run.completedAt = new Date().toISOString();
    await writeRun(env.DB, run);
    // WAITING for insufficient samples is a completed weekly attempt, never force training.
    const completed = run.status === "SUCCESS" || (type === "WEEKLY_RETRAIN" && run.status === "WAITING");
    // A recent pre-cutoff manual snapshot must not suppress the later daily retry.
    const dailyReady = type !== "DAILY_REFRESH" || (after.snapshot &&
      berlinParts(Date.parse(after.snapshot)).date === run.period && berlinParts(Date.parse(after.snapshot)).minute >= 1035);
    if (source === "CLOUDFLARE_CRON" && completed && dailyReady) {
      await env.DB.prepare("INSERT INTO terminal_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING")
        .bind(`automation:completed:${type}:${run.period}`, JSON.stringify({ runId: run.id, status: run.status }), run.completedAt).run();
    }
    console.log(JSON.stringify({ event: "FX_AUTOMATION", ...run }));
    if (source === "MANUAL") {
      const headers = new Headers(response.headers); headers.set("X-FX-Automation-Run", run.id);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    return output(run, run.status === "FAILED" ? 502 : 200);
  } catch {
    run.status = "FAILED"; run.message = "Automation endpoint or persistence failed; inspect Worker logs";
    run.completedAt = new Date().toISOString();
    console.error(JSON.stringify({ event: "FX_AUTOMATION", ...run }));
    try { await writeRun(env.DB, run); } catch { /* Console retains the storage failure. */ }
    // Never retry an already-invoked manual endpoint or rewrite its result because logging failed.
    if (source === "MANUAL") {
      if (response) return response;
      if (!invoked) return invoke(options.request!);
    }
    return output(run, 503);
  } finally {
    if (leased) {
      try {
        await env.DB.prepare("UPDATE terminal_settings SET value = ?, updated_at = ? WHERE key = 'automation:lease' AND json_extract(value, '$.owner') = ?")
          .bind(JSON.stringify({ owner: run.id, expiresAt: 0 }), new Date().toISOString(), run.id).run();
      } catch { console.error("FX_AUTOMATION lease release failed; lease expires automatically"); }
    }
  }
}

export async function automationRequest(request: Request, env: Environment, invoke: Invoke) {
  if (!env.AUTOMATION_SECRET || request.headers.get("Authorization") !== `Bearer ${env.AUTOMATION_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: { type?: JobType; source?: RunSource; cron?: string; scheduledTime?: number };
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!["DAILY_REFRESH", "WEEKLY_RETRAIN"].includes(body.type ?? "") ||
    !["CLOUDFLARE_CRON", "CONTROLLED_TEST"].includes(body.source ?? "")) {
    return Response.json({ error: "Invalid job or source" }, { status: 400 });
  }
  if (body.source === "CLOUDFLARE_CRON" && (!Number.isFinite(body.scheduledTime) ||
    Math.abs(Date.now() - body.scheduledTime!) > 15 * 60 * 1000 ||
    dueJob(body.cron ?? "", body.scheduledTime!) !== body.type)) {
    return Response.json({ error: "Invalid or stale schedule" }, { status: 400 });
  }
  return executeJob(env, invoke, body.type!, body.source!, body);
}

export async function healthResponse(env: Environment, invoke: Invoke) {
  try {
    const lastRecord = async (type: JobType, status?: string, source?: RunSource) => {
      const filters = ["key GLOB 'automation:run:*'", "json_extract(value, '$.type') = ?"];
      const bindings: string[] = [type];
      if (status) { filters.push("json_extract(value, '$.status') = ?"); bindings.push(status); }
      if (source) { filters.push("json_extract(value, '$.source') = ?"); bindings.push(source); }
      const row = await env.DB.prepare(`SELECT value FROM terminal_settings WHERE ${filters.join(" AND ")} ORDER BY updated_at DESC LIMIT 1`)
        .bind(...bindings).first();
      return row ? JSON.parse(row.value) as Run : null;
    };
    const [current, records, forecastResponse, dailySuccess, weeklySuccess, dailyCron, weeklyCron] = await Promise.all([
      state(env.DB),
      env.DB.prepare("SELECT value FROM terminal_settings WHERE key GLOB 'automation:run:*' ORDER BY updated_at DESC LIMIT 100").all<{ value: string }>(),
      invoke(new Request("https://fx-terminal.internal/api/forecast?base=EUR&quote=USD")),
      lastRecord("DAILY_REFRESH", "SUCCESS"), lastRecord("WEEKLY_RETRAIN", "SUCCESS"),
      lastRecord("DAILY_REFRESH", undefined, "CLOUDFLARE_CRON"), lastRecord("WEEKLY_RETRAIN", undefined, "CLOUDFLARE_CRON"),
    ]);
    const runs = records.results.map((row) => JSON.parse(row.value) as Run).map((run) =>
      run.status === "RUNNING" && Date.now() - Date.parse(run.timestamp) > LEASE_MS
        ? { ...run, status: "FAILED", message: "No completion recorded within execution lease" } : run);
    const forecast = await forecastResponse.json() as { asOf?: string; model?: Record<string, unknown> };
    const scheduler = (type: JobType, schedule: string, maxAge: number) => {
      const last = type === "DAILY_REFRESH" ? dailyCron : weeklyCron;
      const observed = !!last && Date.now() - Date.parse(last.timestamp) < maxAge;
      return { status: observed ? "ACTIVE" : "NOT ACTIVE", schedule, timeZone: "Europe/Berlin",
        evidence: last ?? null, verification: observed ? "Authenticated scheduled invocation observed" : "NICHT VERIFIZIERT",
        controlPlaneVerification: "NICHT VERIFIZIERT: Cloudflare schedules API must be checked separately",
        lastOutcome: last?.status ?? null };
    };
    const latest = (type: JobType, status?: string) => runs.find((run) => run.type === type && (!status || run.status === status)) ?? null;
    const model = forecast.model ?? {};
    const fingerprint = current.modelRaw ? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(current.modelRaw))))
      .map((b) => b.toString(16).padStart(2, "0")).join("") : null;
    return Response.json({ checkedAt: new Date().toISOString(),
      dailyScheduler: scheduler("DAILY_REFRESH", "Daily 17:15; retries 17:30 and 17:45", 27 * 3600000),
      weeklyScheduler: scheduler("WEEKLY_RETRAIN", "Saturday 22:00; retries 22:15, 22:30 and 22:45", 8 * 86400000),
      lastSuccessfulDailyRefresh: dailySuccess,
      lastSuccessfulMlRetrain: weeklySuccess,
      lastDailyRun: latest("DAILY_REFRESH"), lastWeeklyRun: latest("WEEKLY_RETRAIN"),
      snapshot: { asOf: current.snapshot, ageSeconds: current.snapshot ? Math.round((Date.now() - Date.parse(current.snapshot)) / 1000) : null },
      model: { version: model.version ?? null, stateSha256: fingerprint, storedModelPresent: !!current.model,
        trainedAt: model.trainedAt ?? null, trainingSamples: model.trainingSamples ?? null,
        walkForwardImplementationPresent: true, walkForwardValidation: model.validation ?? null,
        walkForwardResultPresent: !!model.validation, updatedAt: current.modelUpdatedAt,
        forecastModelMetadataMatchesStored: !!current.model && forecastResponse.ok &&
          model.trainedAt === current.model.trainedAt && model.trainingSamples === current.model.trainingSamples },
      lastError: runs.find((run) => run.status === "FAILED") ?? null,
      logs: runs, logWindow: "Last 100 operational records; manual/test events never prove cron activation",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return Response.json({ status: "FAILED", error: "Health storage or forecast unavailable" }, { status: 503 });
  }
}
