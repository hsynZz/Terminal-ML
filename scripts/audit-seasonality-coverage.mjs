// Read-only, reproducible audit of the same real official archive; no production access.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,appType:'custom',server:{middlewareMode:true,hmr:false}});
try{
  const d=await vite.ssrLoadModule('/lib/seasonality-data.ts'),e=await vite.ssrLoadModule('/lib/seasonality-engine.ts'),w=await vite.ssrLoadModule('/worker/seasonality.ts');
  const parsed=d.parseFxCsv(readFileSync('public/data/seasonality/h10-bootstrap.csv','utf8'),'2026-10-01');
  await w.confirmLargeMoves(parsed.rows,async()=>{throw new Error('Offline audit');});
  const report={scope:'LOCAL_OFFICIAL_ARCHIVE_AUDIT_NOT_LIVE_VALIDATION',version:d.SEASONALITY_VERSION,sourceSha256:JSON.parse(readFileSync('public/data/seasonality/h10-bootstrap-source.json','utf8')).sha256,observations:parsed.rows.length,pairs:[],partialHistoricalExample:null,referencePreserved:true,monthlyCellsChecked:0};
  const old=JSON.parse(readFileSync('docs/seasonality-source-audit.json','utf8')).referenceAnalysis;
  for(const pair of d.FX_PAIRS){
    const points=d.derivePair(parsed.rows,pair,'2026-10-01'),a=e.analyzeSeasonality(points,{asOf:'2026-10-01',lookback:20,start:'10-03',end:'10-27'});
    const months=e.monthlySeasonality(points,a.requestedYears,'2026-10-01');
    for(const m of months)for(const cell of m.cells){
      report.monthlyCellsChecked++;
      if(!cell.result)continue;
      const r=cell.result;
      const first=points.find(p=>p.date===r.startDate),last=points.find(p=>p.date===r.endDate);
      assert.ok(Math.abs(r.return-(last.close/first.close-1))<1e-12);
      assert.ok(r.endDate<'2026-01-01');
    }
    if(pair==='AUDCAD')for(const [key,value] of Object.entries(old.stats))assert.deepEqual(a.stats[key],value);
    if(pair==='EURUSD'){
      const historical=e.analyzeSeasonality(points,{asOf:'2007-10-01',lookback:10,start:'10-03',end:'10-27'});
      report.partialHistoricalExample={pair,asOf:historical.asOf,lookback:10,coverage:historical.coverage,excluded:historical.excluded};
      assert.equal(historical.coverage.status,'PARTIAL');assert.equal(historical.coverage.valid,8);
    }
    report.pairs.push({pair,firstDate:points[0].date,lastDate:points.at(-1).date,windowYears:a.coverage.valid,monthlyMinimum:Math.min(...months.map(m=>m.coverage.valid)),monthlyMaximum:Math.max(...months.map(m=>m.coverage.valid)),incompleteMonths:months.filter(m=>m.coverage.status!=='COMPLETE').map(m=>({month:m.month,...m.coverage}))});
  }
  assert.equal(report.pairs.length,56);
  console.log(JSON.stringify(report));
}finally{await vite.close();}
