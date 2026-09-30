// Read-only reproduction from the checked-in, genuine production outcome export.
import {readFileSync,writeFileSync} from 'node:fs';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,appType:'custom',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});
try{
 const temporal=await vite.ssrLoadModule('/lib/temporal-validation.ts'),legacy=await vite.ssrLoadModule('/lib/hypothesis/engine.ts');
 const {outcomes}=JSON.parse(readFileSync('docs/evidence/validation-outcomes-2026-09-30.json','utf8'));
 const report=[1,3,5,10,30,60,90].map(horizon=>{
  const rows=outcomes.filter(o=>o.horizon===horizon).map(o=>({...o,pair:o.currency,probability:.5,baseline:.5})),old=legacy.independentBlocks(rows,horizon),next=temporal.dateClusters(rows),diagnostic=temporal.dependence(rows,r=>r.label);
  return {horizon,oldRaw:rows.length,oldBlocks:old.length,oldRetainedRows:old.flatMap(b=>b.rows).length,newRaw:rows.length,newDates:next.clusters.length,newRetainedRows:next.clusters.flatMap(b=>b.rows).length,duplicateDateEntityRows:next.removed.filter(r=>r.reason==='DUPLICATE').length,labelProcessESS:diagnostic.effectiveSampleSize,overlapRatio:diagnostic.overlappingLabelRatio,qualificationESS:null,qualificationESSReason:'No trained candidate or passed recipe; outcome-series ESS is not loss-difference ESS',folds:0,purgedRows:0};
 });
 writeFileSync('docs/evidence/validation-old-new-2026-09-30.json',JSON.stringify(report,null,2)+'\n');
 console.table(report.map(({horizon,oldRaw,oldBlocks,newDates,newRetainedRows,labelProcessESS})=>({horizon,oldRaw,oldBlocks,newDates,newRetainedRows,labelProcessESS})));
}finally{await vite.close();}
