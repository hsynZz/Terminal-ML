import { TerminalDashboard } from "@/components/terminal-dashboard";
import { getBaselinePayload } from "@/lib/terminal-data";

export default function Home() {
  return <TerminalDashboard initialPayload={getBaselinePayload()} />;
}
