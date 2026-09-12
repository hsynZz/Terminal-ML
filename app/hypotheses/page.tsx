import { requireChatGPTUser } from "@/app/chatgpt-auth";
import { HypothesisLab } from "@/components/hypothesis-lab";
export const dynamic = "force-dynamic";
export default async function Page() {
  await requireChatGPTUser("/hypotheses");
  return <HypothesisLab />;
}
