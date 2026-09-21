import { env } from 'cloudflare:workers';
import { productionFailure, productionRetrain, type ProductionEnv } from '@/worker/production';
export async function POST(){
  const runtime=env as unknown as ProductionEnv;
  try{return Response.json(await productionRetrain(runtime),{headers:{'Cache-Control':'no-store'}});}
  catch{await productionFailure(runtime,new Date().toISOString(),'RETRAIN_FAILED');return Response.json({status:'unavailable',reason:'Challenger training failed; core and previous versions retained'},{status:503});}
}
