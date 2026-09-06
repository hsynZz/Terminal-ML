// Operational scheduling only. No model inputs or trading thresholds live here.
export const AUTOMATION_CRONS = ["15,30,45 15,16,17 * * *", "0,15,30,45 20,21 * * 6"];
export type JobType = "DAILY_REFRESH" | "WEEKLY_RETRAIN";
export type RunSource = "MANUAL" | "CONTROLLED_TEST" | "CLOUDFLARE_CRON";
export type Outcome = "SUCCESS" | "WAITING" | "FAILED";

export function berlinParts(time: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(time));
  const value = (key: string) => parts.find((part) => part.type === key)?.value ?? "";
  return { date: `${value("year")}-${value("month")}-${value("day")}`,
    weekday: value("weekday"), minute: Number(value("hour")) * 60 + Number(value("minute")) };
}

export function dueJob(cron: string, time: number): JobType | null {
  const p = berlinParts(time);
  if (cron === AUTOMATION_CRONS[0] && [1035, 1050, 1065].includes(p.minute)) return "DAILY_REFRESH";
  if (cron === AUTOMATION_CRONS[1] && p.weekday === "Sat" && [1320, 1335, 1350, 1365].includes(p.minute)) return "WEEKLY_RETRAIN";
  return null;
}

export function jobPath(type: JobType) {
  return type === "DAILY_REFRESH" ? "/api/refresh" : "/api/retrain";
}

export function classifyOutcome(type: JobType, http: number, body: Record<string, unknown>): { status: Outcome; message: string } {
  if (http < 200 || http >= 300) return { status: "FAILED", message: `HTTP ${http}: ${String(body.reason ?? body.status ?? "endpoint failed").slice(0, 160)}` };
  if (type === "WEEKLY_RETRAIN") {
    if (body.status === "waiting") return { status: "WAITING", message: `Training deferred: ${String(body.validation ?? "insufficient samples")}; samples=${String(body.samples ?? "unknown")}` };
    if (body.status === "trained" && typeof body.trainedAt === "string") return { status: "SUCCESS", message: "Stored model trained" };
  } else {
    if (typeof body.asOf === "string") return { status: "SUCCESS", message: body.status === "already-current" ? "Snapshot already current" : "Refresh returned snapshot" };
    if (body.status === "waiting-for-berlin-cutoff") return { status: "WAITING", message: "Before Berlin cutoff" };
  }
  return { status: "FAILED", message: "Unexpected endpoint response" };
}
