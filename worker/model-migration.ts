import { sanitizeModelSettings, type ModelSettings } from '../lib/terminal-data';
import type { ResearchDB } from './hypothesis-research';

/** Part of the snapshot transaction; old snapshots and predictions remain untouched. */
export async function prepareModelMigration(db: ResearchDB, fallback: ModelSettings, now: string) {
  const saved = await db.prepare('SELECT value FROM terminal_settings WHERE key=?').bind('model').first<{value:string}>();
  const raw = saved ? JSON.parse(saved.value) as ModelSettings : fallback;
  const model = sanitizeModelSettings(raw);
  if (raw.forecastBaseline?.version === 'frozen-core-v1') return { model, writes: [] };
  const backup = db.prepare('INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING').bind('model:before-automatic-v1', JSON.stringify({ at: now, settings: raw, reason: 'Frozen pre-migration forecast baseline; legacy allocation retired' }), now);
  const write = saved
    ? db.prepare('UPDATE terminal_settings SET value=?,updated_at=? WHERE key=? AND value=?').bind(JSON.stringify(model), now, 'model', saved.value)
    : db.prepare('INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING').bind('model', JSON.stringify(model), now);
  return { model, writes: [backup, write] };
}
