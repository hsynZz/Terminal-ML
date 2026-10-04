import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,appType:'custom',cacheDir:'node_modules/.vite-seasonality-overview',optimizeDeps:{noDiscovery:true,include:[]},esbuild:{jsx:'automatic'},resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});
after(()=>vite.close());
const engine=await vite.ssrLoadModule('/lib/seasonality-engine.ts'),ui=await vite.ssrLoadModule('/components/seasonality-overview.tsx');
const history=[];
for(let year=2016;year<=2025;year++)for(let n=0;n<366;n++){
  const date=new Date(Date.UTC(year,0,n+1));if(date.getUTCFullYear()!==year)break;if([0,6].includes(date.getUTCDay()))continue;
  const value=1+n*.0003,day=date.toISOString().slice(0,10);if(day>='2020-03-10'&&day<='2020-03-25')continue;
  history.push({date:day,close:value,baseUsd:value,quoteUsd:1,quality:'VALID'});
}
const analysis=engine.analyzeSeasonality(history,{asOf:'2026-10-01',lookback:10,start:'03-01',end:'03-31'});
test('coverage render exposes numerator, denominator, missing reason and independent chart cohort',()=>{
  const html=renderToStaticMarkup(React.createElement(ui.CoverageOverview,{analysis,firstDate:'2016-01-01',lastDate:'2025-12-31',fixings:history.length,view:'year'}));
  assert.match(html,/9 <em>\/ 10 Jahre/);assert.match(html,/Teilweise/);assert.match(html,/Zu große Kurslücke im Fenster/);assert.match(html,/Abdeckung ist keine Prognosegüte/);assert.doesNotMatch(html,/NaN|undefined|Infinity/);
});
test('monthly overview renders all 12 actionable months and keyboard-accessible exact-value heatmap cells',()=>{
  const months=engine.monthlySeasonality(history,analysis.requestedYears,'2026-10-01');
  const html=renderToStaticMarkup(React.createElement(ui.MonthlyOverview,{months,start:'03-01',end:'03-31',onSelect(){}}));
  assert.match(html,/Januar/);assert.match(html,/Dezember/);assert.match(html,/9\/10 Jahre · teilweise/);assert.match(html,/März 2020: Zu große Kurslücke im Fenster/);assert.match(html,/ohne Übernacht-Rendite vom Vormonat/);assert.match(html,/29. Februar/);assert.doesNotMatch(html,/NaN|undefined|Infinity/);
  assert.equal((html.match(/Details anzeigen/g)??[]).length,120);
});
test('distribution render describes empirical historical spread without predictive confidence',()=>{
  const html=renderToStaticMarkup(React.createElement(ui.WindowDistribution,{analysis}));
  assert.match(html,/n = 9/);assert.match(html,/25.–75. Perzentil/);assert.match(html,/Kein Konfidenzintervall/);assert.equal((html.match(/season-return-track/g)??[]).length,9);assert.doesNotMatch(html,/NaN|undefined|Infinity/);
});
