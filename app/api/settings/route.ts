import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { terminalSettings } from "@/db/schema";
import { getDefaultModelSettings, sanitizeModelSettings, type ModelSettings } from "@/lib/terminal-data";

export async function GET() {
  try {
    const db = getDb();
    const [saved] = await db.select().from(terminalSettings).where(eq(terminalSettings.key, "model")).limit(1);
    return Response.json(saved?.value
      ? sanitizeModelSettings(JSON.parse(saved.value) as Partial<ModelSettings>)
      : getDefaultModelSettings());
  } catch {
    return Response.json(getDefaultModelSettings());
  }
}

export async function PUT() {
  return Response.json({ error: 'AUTOMATIC_VALIDATION_ONLY', message: 'Core is fixed. Adaptive influence requires prospective validation.' }, { status: 409 });
}
