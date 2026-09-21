import { desc, eq } from "drizzle-orm";
import { env } from 'cloudflare:workers';
import { guardProductionPayload, type ProductionEnv } from '@/worker/production';
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
    return Response.json(await guardProductionPayload(env as unknown as ProductionEnv,payload),{headers:{'Cache-Control':'private, no-store'}});
  } catch {
    // The first deployment intentionally falls back until the initial refresh is stored.
  }
  return Response.json({status:'unavailable',reason:'Snapshot storage unavailable; no replacement baseline has been presented as live data'},{status:503,headers:{'Cache-Control':'no-store'}});
}
