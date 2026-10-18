import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createServer} from 'vite';

const vite=await createServer({configFile:false,appType:'custom',cacheDir:'node_modules/.vite-seasonality-chart',optimizeDeps:{noDiscovery:true,include:[]},esbuild:{jsx:'automatic'},resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});
after(()=>vite.close());
const chart=await vite.ssrLoadModule('/lib/seasonality-chart.ts'),ui=await vite.ssrLoadModule('/components/seasonality-chart.tsx');

test('the same day is picked at 1x and in a horizontally scrolled 4x chart',()=>{
  assert.equal(chart.chartPointerIndex(419.2,90,{left:120,top:40,width:520,height:230},1040,460,21),11);
  assert.equal(chart.chartPointerIndex(257.2,90,{left:-900,top:40,width:2080,height:230},4160,460,21),11);
  // A phone-width SVG uses its measured viewport, with no 780px minimum or coordinate squeeze.
  assert.equal(chart.chartPointerIndex(222,100,{left:10,top:0,width:360,height:460},360,460,21),10);
});
test('axes and invalid measurements cannot silently select a boundary day; captured drags can clamp',()=>{
  const bounds={left:10,top:20,width:1040,height:460};
  for(const [x,y] of [[50,100],[1035,100],[500,30],[500,450]])assert.equal(chart.chartPointerIndex(x,y,bounds,1040,460,21),null);
  assert.equal(chart.chartPointerIndex(-10,100,bounds,1040,460,21,true),0);
  assert.equal(chart.chartPointerIndex(1200,100,bounds,1040,460,21,true),20);
  assert.equal(chart.chartPointerIndex(100,100,{...bounds,width:0},1040,460,21),null);
  assert.equal(chart.chartPointerIndex(NaN,100,bounds,1040,460,21),null);
  assert.equal(chart.chartPointerIndex(100,100,bounds,1040,460,0),null);
});
test('adjacent-day selections work in either drag direction and retain the displayed year crossing',()=>{
  const days=['12-30','12-31','01-01','01-02'].map(monthDay=>({monthDay}));
  assert.deepEqual(chart.chartSelection(days,1,2),['12-31','01-01']);
  assert.deepEqual(chart.chartSelection(days,2,1),['12-31','01-01']);
  assert.deepEqual(chart.chartSelection(days,3,0),['12-30','01-02']);
  for(const indices of [[1,1],[-1,2],[0,4],[0,1.5]])assert.equal(chart.chartSelection(days,...indices),null);
});
test('readouts disclose carried fixings, including real non-leap month ends, and round only at display',()=>{
  assert.equal(chart.fixingCaption({monthDay:'10-04',sourceDates:{2025:'2025-10-03'}},2025,false),'03.10.2025 · fortgeführt');
  assert.equal(chart.fixingCaption({monthDay:'02-29',sourceDates:{2025:'2025-02-28'}},2025,true),'28.02.2025');
  assert.equal(chart.fixingCaption({monthDay:'02-29',sourceDates:{2024:'2024-02-29'}},2024,false),'29.02.2024');
  assert.equal(chart.fixingCaption({monthDay:'01-02',sourceDates:{}},2026,false),'Kein Fixing');
  assert.equal(chart.chartPercent(101.23456),'+1.235 %');
  assert.equal(chart.chartPercent(99.999999),'0.000 %');
  assert.equal(chart.chartPercent(null),'—');assert.equal(chart.chartPercent(Infinity),'—');
});
test('compact axes retain exact endpoints without duplicate labels for short windows',()=>{
  const days=['10-03','10-04','10-05'].map(monthDay=>({monthDay}));
  assert.deepEqual(chart.chartTicks(days,240),[0,1,2]);
  assert.deepEqual(chart.chartTicks(days.slice(0,1),240),[0]);
  assert.deepEqual(chart.chartTicks([],240),[]);
});

const point={monthDay:'10-03',average:101.23456,median:101.1,current:null,lowerQuartile:99.7,upperQuartile:102,sample:5,years:{2020:99.7},sourceDates:{2020:'2020-10-02'}};
const analysis={start:'10-03',end:'10-04',monthEnd:false,currentYear:2026,curve:[point,{...point,monthDay:'10-04'}]};
const render=visible=>renderToStaticMarkup(React.createElement(ui.SeasonalChart,{analysis,visible,selectedYears:[2020],highlight:2020,view:'year',onWindow(){},onFocusWindow(){}}));
test('rendered precise readout matches visible curves and exposes the selected year actual fixing',()=>{
  const html=render({average:true,median:false,currentYear:false,band:false});
  assert.match(html,/Exakte Chartwerte am 3. Okt/);assert.match(html,/\+1\.235 %/);assert.match(html,/Index 101\.235/);
  assert.match(html,/-0\.300 %/);assert.match(html,/02\.10\.2020 · fortgeführt/);
  assert.match(html,/data-series="average"/);assert.doesNotMatch(html,/data-series="median"|data-series="currentYear"/);
  assert.match(html,/Einen Kalendertag zurück/);assert.match(html,/Als Start/);assert.match(html,/Als Ende/);assert.match(html,/Auswahl im Detail/);
  assert.doesNotMatch(html,/NaN|undefined|Infinity|season-chart-tooltip/);
  // The values are outside the horizontally scrolling SVG, so zoom cannot move them away.
  assert.ok(html.indexOf('season-chart-readout')>html.indexOf('</svg></div>'));
});
test('missing current-year data stays explicitly unavailable while historical values remain visible',()=>{
  const html=render({average:true,median:true,currentYear:true,band:true});
  assert.match(html,/Kein Fixing/);assert.match(html,/Index —/);assert.match(html,/Mittlere 50 %/);
  assert.match(html,/5 historische Jahre an diesem Tag/);assert.match(html,/Bezug: erstes Fixing des Jahres/);
});
