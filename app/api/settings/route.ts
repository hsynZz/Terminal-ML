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

export async function PUT(request: Request) {
  try {
    const settings = sanitizeModelSettings(await request.json() as Partial<ModelSettings>);
    const now = new Date().toISOString();
    const db = getDb();
    await db.insert(terminalSettings).values({
      key: "model",
      value: JSON.stringify(settings),
      updatedAt: now,
    }).onConflictDoUpdate({
      target: terminalSettings.key,
      set: { value: JSON.stringify(settings), updatedAt: now },
    });
    return Response.json(settings);
  } catch {
    return Response.json({ error: "Model settings could not be saved" }, { status: 400 });
  }
}
