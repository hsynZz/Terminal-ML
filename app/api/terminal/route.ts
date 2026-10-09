import { env } from 'cloudflare:workers';
import type { ProductionEnv } from '@/worker/production';
import { loadTerminalSnapshot } from '@/worker/terminal-snapshot';

export async function GET() {
  try {
    return Response.json(await loadTerminalSnapshot(env as unknown as ProductionEnv),{headers:{'Cache-Control':'private, no-store'}});
  } catch {
    // An unavailable store is not evidence for a replacement baseline.
  }
  return Response.json({status:'unavailable',reason:'Snapshot storage unavailable; no replacement baseline has been presented as live data'},{status:503,headers:{'Cache-Control':'no-store'}});
}
