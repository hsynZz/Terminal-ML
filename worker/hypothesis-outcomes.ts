import { resolveOutcomes, type AuditClose } from '../lib/calibration';
import type { Frame } from '../lib/hypothesis/engine';
import { digest } from '../lib/hypothesis/provenance';
import type { ResearchDB } from './hypothesis-research';
export type ArchivedOutcome={
  pair:string;horizon:number;asOf:string;entryDate:string;labelEnd:string;label:0|1;
  entryPrice:number;exitPrice:number;recordedAt:string;source:string;digest:string;
};
const PREFIX='hypothesis:v1:outcome:';
const keyOf=(r:{pair:string;horizon:number;asOf:string})=>r.pair+':'+r.horizon+':'+r.asOf;
/** Insert-only labels and actual prices used at the first completed observation. */
export async function archiveOutcomes(db:ResearchDB,frames:Frame[],closes:AuditClose[],now:string) {
  const saved=await db.prepare('SELECT value FROM terminal_settings WHERE key>=? AND key<? ORDER BY key ASC LIMIT 30001').bind(PREFIX,'hypothesis:v1:outcome;').all<{value:string}>();
  if(saved.results.length>30000)throw new Error('OUTCOME_READ_BUDGET_EXCEEDED');
  const ledger:ArchivedOutcome[]=[];
  for(const row of saved.results) {
    const item=JSON.parse(row.value) as ArchivedOutcome,{digest:expected,...body}=item;
    if(await digest(body)!==expected||!Number.isFinite(Date.parse(item.recordedAt))||Date.parse(item.recordedAt)>Date.parse(now)||
      ![0,1].includes(item.label)||!Number.isFinite(item.entryPrice)||item.entryPrice<=0||!Number.isFinite(item.exitPrice)||item.exitPrice<=0||
      item.label!==(item.exitPrice>item.entryPrice?1:0)||item.labelEnd>=item.recordedAt.slice(0,10))throw new Error('OUTCOME_INTEGRITY_FAILURE');
    ledger.push(item);
  }
  const seen=new Set(ledger.map(keyOf));
  const forecasts=frames.flatMap(f=>f.signals.map(s=>({pair:s.pair,horizon:s.horizon,probability:s.baseline,observedAt:f.issuedAt,sourceMode:f.sourceMode})));
  const {outcomes}=resolveOutcomes(forecasts,closes,now);
  const prices=new Map(closes.map(c=>[c.currency+':'+c.period,c.value]));
  const writes=[];
  for(const o of outcomes) {
    const key=keyOf(o);if(seen.has(key))continue;
    if(ledger.length>=30000)throw new Error('OUTCOME_READ_BUDGET_EXCEEDED');
    const base=o.pair.split('/')[0];
    const body={pair:o.pair,horizon:o.horizon,asOf:o.asOf,entryDate:o.entryDate,labelEnd:o.labelEnd,label:o.label,
      entryPrice:prices.get(base+':'+o.entryDate)!,exitPrice:prices.get(base+':'+o.labelEnd)!,recordedAt:now,source:'Alpha Vantage; first observed completed daily close'};
    const item={...body,digest:await digest(body)};
    writes.push(db.prepare('INSERT INTO terminal_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING').bind(PREFIX+key,JSON.stringify(item),now));
    ledger.push(item);seen.add(key);
  }
  for(let i=0;i<writes.length;i+=25)await db.batch(writes.slice(i,i+25));
  return ledger;
}
