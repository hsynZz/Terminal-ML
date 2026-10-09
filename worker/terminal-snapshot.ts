import { hydrateTerminalPayload, sanitizeModelSettings, type ModelSettings, type TerminalPayload } from '../lib/terminal-data';
import { refreshSourceStatus } from '../lib/production-data';
import { guardProductionPayload, type ProductionEnv } from './production';

/** The page and API start from the same persisted snapshot, never a temporary demo baseline. */
export async function loadTerminalSnapshot(env: ProductionEnv): Promise<TerminalPayload> {
  const [latest, savedModel] = await Promise.all([
    env.DB.prepare('SELECT payload FROM terminal_snapshots ORDER BY as_of DESC LIMIT 1').first<{payload:string}>(),
    env.DB.prepare('SELECT value FROM terminal_settings WHERE key=?').bind('model').first<{value:string}>(),
  ]);
  if (!latest) throw new Error('SNAPSHOT_UNAVAILABLE');
  const payload = hydrateTerminalPayload(JSON.parse(latest.payload) as TerminalPayload);
  if (savedModel?.value) payload.model = sanitizeModelSettings(JSON.parse(savedModel.value) as Partial<ModelSettings>);
  return guardProductionPayload(env, refreshSourceStatus(payload));
}
