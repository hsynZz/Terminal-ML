import { TerminalDashboard } from "@/components/terminal-dashboard";
import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { getBaselinePayload } from "@/lib/terminal-data";

export default async function Home() {
  await requireChatGPTUser("/");
  return <TerminalDashboard initialPayload={getBaselinePayload()} />;
}
