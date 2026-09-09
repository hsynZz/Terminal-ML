import { dueJob, type RunSource } from "../automation-policy";

type Env = { AUTOMATION_SECRET: string };
type Event = { cron: string; scheduledTime: number };
const TERMINAL_AUTOMATION_URL = "https://fx-macro-terminal.hysnzz.chatgpt.site/api/automation/run";

export async function dispatch(event: Event, env: Env, source: RunSource = "CLOUDFLARE_CRON") {
  const type = dueJob(event.cron, event.scheduledTime);
  if (!type) return;
  if (!env.AUTOMATION_SECRET) throw new Error("Scheduler secret missing");
  let status = "FAILED";
  let message = "Terminal request failed";
  try {
    const request = new Request(TERMINAL_AUTOMATION_URL, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.AUTOMATION_SECRET}` },
      body: JSON.stringify({ type, source, cron: event.cron, scheduledTime: event.scheduledTime }),
      signal: AbortSignal.timeout(180000),
    });
    const response = await fetch(request);
    const body = await response.json() as { status?: string; message?: string; id?: string };
    if (response.ok && ["SUCCESS", "WAITING"].includes(body.status ?? "")) {
      status = body.status!; message = `${body.message ?? "Completed"}; run=${body.id ?? "unknown"}`;
    } else { message = `Terminal HTTP ${response.status}: ${String(body.message ?? "Unexpected response").slice(0, 160)}`; }
  } catch {
    message = "Terminal unreachable, timed out, or returned non-JSON; next scheduled retry remains enabled";
  }
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), type, source, status, message,
    scheduledTime: new Date(event.scheduledTime).toISOString(), cron: event.cron }));
  if (status === "FAILED") throw new Error(message);
}

export default {
  async scheduled(event: Event, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }) {
    ctx.waitUntil(dispatch(event, env));
  },
  async fetch() { return new Response("Cron-only FX automation worker", { status: 404 }); },
};
