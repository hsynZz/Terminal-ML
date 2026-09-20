import { AUTOMATION_CRONS, LEGACY_WEEKLY_CRON, dueJob, type RunSource } from "../automation-policy";

// Cloudflare numbers Sunday=1; use a named weekday to avoid Unix ambiguity.
export const CLOUDFLARE_CRONS = [AUTOMATION_CRONS[0], "0,15,30,45 20,21 * * SAT"];

type Env = { AUTOMATION_SECRET: string };
type Event = { cron: string; scheduledTime: number };
const TERMINAL_AUTOMATION_URL = "https://fx-macro-terminal.hysnzz.chatgpt.site/api/automation/run";

export async function dispatch(event: Event, env: Env, source: RunSource = "CLOUDFLARE_CRON") {
  // Preserve the existing Site automation protocol and its Berlin-time guard.
  if (event.cron === CLOUDFLARE_CRONS[1]) event = { ...event, cron: LEGACY_WEEKLY_CRON };
  const type = dueJob(event.cron, event.scheduledTime);
  if (!type) return;
  if (!env.AUTOMATION_SECRET) throw new Error("Scheduler secret missing");

  let status = "FAILED";
  let message = "Terminal request failed";
  let stage = "REQUEST";
  let httpStatus: number | null = null;
  let failureDetail: string | null = null;

  try {
    const request = new Request(TERMINAL_AUTOMATION_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.AUTOMATION_SECRET}`,
      },
      body: JSON.stringify({ type, source, cron: event.cron, scheduledTime: event.scheduledTime }),
      signal: AbortSignal.timeout(180000),
    });

    stage = "FETCH";
    const response = await fetch(request);
    httpStatus = response.status;

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`AUTOMATION_REDIRECT_REJECTED_${response.status}`);
    }

    stage = "JSON_RESPONSE";
    const raw = await response.text();
    let body: { status?: string; message?: string; id?: string };
    try {
      body = JSON.parse(raw) as { status?: string; message?: string; id?: string };
    } catch {
      const contentType = response.headers.get("content-type") ?? "unknown";
      throw new Error(`NON_JSON_RESPONSE_${response.status}_${contentType.slice(0, 80)}`);
    }

    if (response.ok && ["SUCCESS", "WAITING"].includes(body.status ?? "")) {
      status = body.status!;
      message = `${body.message ?? "Completed"}; run=${body.id ?? "unknown"}`;
    } else {
      message = `Terminal HTTP ${response.status}: ${String(body.message ?? "Unexpected response").slice(0, 160)}`;
    }
  } catch (error) {
    failureDetail = error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
    message = `Automation failed at ${stage}; HTTP ${httpStatus ?? "not received"}; ${failureDetail}; next scheduled retry remains enabled`;
  }

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    type,
    source,
    status,
    message,
    stage,
    httpStatus,
    failureDetail,
    scheduledTime: new Date(event.scheduledTime).toISOString(),
    cron: event.cron,
  }));

  if (status === "FAILED") throw new Error(message);
}

export default {
  async scheduled(event: Event, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    ctx.waitUntil(dispatch(event, env));
  },
  async fetch() { return new Response("Cron-only FX automation worker", { status: 404 }); },
};
