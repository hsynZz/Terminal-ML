import { dueJob, type RunSource } from "../automation-policy";

type Env = { TERMINAL_ORIGIN: string; SITES_API_TOKEN: string; AUTOMATION_SECRET: string };
type Event = { cron: string; scheduledTime: number };

export async function dispatch(event: Event, env: Env, source: RunSource = "CLOUDFLARE_CRON", fetcher: typeof fetch = fetch) {
  const type = dueJob(event.cron, event.scheduledTime);
  if (!type) return;
  if (!env.SITES_API_TOKEN || !env.AUTOMATION_SECRET) throw new Error("Scheduler secrets missing");
  const origin = new URL(env.TERMINAL_ORIGIN);
  if (origin.origin !== "https://fx-macro-terminal.hysnzz.chatgpt.site") throw new Error("Unexpected terminal origin");
  let status = "FAILED";
  let message = "Terminal request failed";
  try {
    const response = await fetcher(new URL("/api/automation/run", origin), {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", "OAI-Sites-Authorization": `Bearer ${env.SITES_API_TOKEN}`,
        Authorization: `Bearer ${env.AUTOMATION_SECRET}` },
      body: JSON.stringify({ type, source, cron: event.cron, scheduledTime: event.scheduledTime }),
      signal: AbortSignal.timeout(180000),
    });
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
