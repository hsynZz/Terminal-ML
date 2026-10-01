import {requireChatGPTUser} from '@/app/chatgpt-auth';
import {SeasonalityDashboard} from '@/components/seasonality-dashboard';
export const dynamic='force-dynamic';
export const metadata={title:'FX Seasonality · Macro Terminal',description:'Offizielle historische FX-Referenzkurse, saisonale Verläufe und reproduzierbare Fensterstatistiken.'};
export default async function SeasonalityPage(){
  await requireChatGPTUser('/seasonality');
  return <SeasonalityDashboard />;
}
