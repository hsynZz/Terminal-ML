import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { terminalSettings, terminalSnapshots } from "@/db/schema";
import { getBaselinePayload, hydrateTerminalPayload, sanitizeModelSettings, type ModelSettings, type TerminalPayload } from "@/lib/terminal-data";

export async function GET() {
  try {
    const db = getDb();
    const [[latest], [savedModel]] = await Promise.all([
      db.select().from(terminalSnapshots).orderBy(desc(terminalSnapshots.asOf)).limit(1),
      db.select().from(terminalSettings).where(eq(terminalSettings.key, "model")).limit(1),
    ]);
    const payload = hydrateTerminalPayload((latest?.payload as TerminalPayload | undefined) ?? getBaselinePayload());
    if (savedModel?.value) {
      payload.model = sanitizeModelSettings(JSON.parse(savedModel.value) as Partial<ModelSettings>);
    }
    return Response.json(payload);
  } catch {
    // The first deployment intentionally falls back until the initial refresh is stored.
  }
  return Response.json(getBaselinePayload());
}
