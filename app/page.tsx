import { TerminalDashboard } from "@/components/terminal-dashboard";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { env } from 'cloudflare:workers';
import type { ProductionEnv } from '@/worker/production';
import { loadTerminalSnapshot } from '@/worker/terminal-snapshot';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function Home() {
  await requireChatGPTUser("/");
  const payload = await loadTerminalSnapshot(env as unknown as ProductionEnv).catch(() => null);
  if (!payload) return <main className="terminal-shell"><p role="status">Der gespeicherte Terminal-Stand ist derzeit nicht erreichbar. Bitte lade die Seite erneut.</p><Link href="/">Erneut laden</Link></main>;
  return <TerminalDashboard initialPayload={payload} />;
}
