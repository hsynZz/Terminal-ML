import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,appType:'custom',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});after(()=>vite.close());
const agri=await vite.ssrLoadModule('/lib/agricultural-research.ts'),research=await vite.ssrLoadModule('/lib/production-research.ts'),data=await vite.ssrLoadModule('/lib/terminal-data.ts'),runtime=await vite.ssrLoadModule('/worker/production.ts'),coverage=await vite.ssrLoadModule('/lib/research-coverage.ts'),context=await vite.ssrLoadModule('/lib/hypothesis-context.ts');
const fixture=JSON.parse(readFileSync(new URL('./fixtures/agricultural-official.json',import.meta.url),'utf8'));
const now='2026-09-30T12:00:00.000Z',day=86400000,url='https://esmis.nal.usda.gov/sites/default/release-files/796082/prog3926.txt';
test('official crop tables retain reference/publication/receipt separately; missing or early releases fail closed',()=>{
 const rows=agri.parseCropProgress(fixture.progress,now,url);assert.equal(rows.length,12);
 const corn=rows.find(x=>x.metric==='alt.agri.crop.corn.condition.level.v1');assert.equal(corn.value,57);assert.equal(corn.period,'2026-09-27');assert.equal(corn.publicationDate,'2026-09-28');assert.equal(corn.receivedAt,now);assert.equal(corn.releaseDate,null);assert.equal(corn.publicationTimeKnown,false);assert.equal(corn.scheduledPublicationAt,'2026-09-28T20:00:00.000Z');
 assert.equal(agri.parseCropProgress(fixture.progress,'2026-09-28T19:59:59.000Z',url).length,0);assert.equal(agri.parseCropProgress(fixture.progress.replace('Released','Unknown release'),now,url).length,0);
 assert.equal(agri.newYorkSchedule('2026-12-14',16),'2026-12-14T21:00:00.000Z');assert.ok(rows.every(r=>r.quality==='VALID'&&r.researchExposures.length===1&&r.researchExposures[0].currency==='USD'));
 assert.equal(agri.usdaTextLinks('<a href="https://other.example/evil.txt">x</a><a href="/sites/default/release-files/796082/prog3926.txt">data</a>')[0],url);
});
test('USDA estimates and stocks use printed units, crop-year/reference dates and identified monthly revisions',()=>{
 const production=agri.parseCropProduction(fixture.production,now,'https://esmis.nal.usda.gov/sites/default/release-files/796056/crop0926.txt');
 assert.equal(production.find(x=>x.metric==='alt.agri.estimate.corn.yield.v1').value,178.5);assert.equal(production.find(x=>x.metric==='alt.agri.estimate.soy.production.v1').value,4534981);
 assert.ok(Math.abs(production.find(x=>x.metric==='alt.agri.estimate.corn.yield_revision.v1').value+2.2)<1e-9);assert.ok(Math.abs(production.find(x=>x.metric==='alt.agri.estimate.soy.yield_revision.v1').value-.1)<1e-9);
 assert.equal(production.find(x=>x.metric==='alt.agri.acreage.corn.planted.v1').period,'2026-01-01');assert.ok(production.every(x=>x.quality==='VALID'&&x.publicationDate==='2026-09-11'));
 assert.equal(agri.parseCropProduction(fixture.production.replaceAll('bushels:','tonnes:'),now,url).filter(r=>r.metric.includes('yield')).length,0);
 const stocks=agri.parseGrainStocks(fixture.stocks,now,'https://esmis.nal.usda.gov/sites/default/release-files/795959/grst0626.txt');assert.equal(stocks.length,3);assert.equal(stocks.find(x=>x.metric.includes('corn')).value,5294828);assert.ok(stocks.every(x=>x.period==='2026-06-01'&&x.publicationDate==='2026-06-30'&&x.quality==='VALID'));
 assert.equal(agri.parseGrainStocks(fixture.stocks.replaceAll('1,000 bushels','metric tonnes'),now,url).length,0);
});
test('monthly grain prices never fabricate daily changes, missing months or a historical publication time',()=>{
 const observations=Array.from({length:60},(_,i)=>({date:new Date(Date.UTC(2026,7-i,1)).toISOString().slice(0,10),value:String(200+i+4*Math.sin(i))}));
 const rows=agri.parseAgriculturalPrice({observations},agri.agriculturalPrices[0],now);assert.equal(rows.length,5);assert.ok(rows.every(r=>r.period==='2026-08-01'&&r.publicationDate===null&&r.releaseDate===null));assert.ok(rows.some(r=>r.metric.includes('seasonal_deviation')));assert.ok(!rows.some(r=>/5d|20d/.test(r.metric)));
 const missing=agri.parseAgriculturalPrice({observations:observations.filter((_,i)=>i!==1)},agri.agriculturalPrices[0],now);assert.ok(!missing.some(r=>r.metric.includes('change_1m')||r.metric.includes('volatility_12m')));
 assert.deepEqual(agri.parseAgriculturalPrice({observations:[{date:'2026-12-01',value:'900'},...observations]},agri.agriculturalPrices[0],now),rows);
 assert.deepEqual(rows[0].researchExposures.map(e=>e.currency),['USD','CAD','NZD','JPY']);
});
test('drought and weather cannot masquerade as crop-weighted, daily or implied measurements',()=>{
 const csv='MapDate,AreaOfInterest,StatisticFormatID,ValidStart,None,D0,D1,D2,D3,D4\n20260922,CONUS,1,2026-09-22,20,80,60,40,20,5\n20260915,CONUS,1,2026-09-15,25,75,55,35,15,4';
 const rows=agri.parseDrought(csv,now,agri.droughtUrl(now));assert.equal(rows.length,4);assert.equal(rows.find(r=>r.metric.includes('d2.change')).value,5);assert.ok(rows.every(r=>r.publicationDate===null&&r.period==='2026-09-22'));assert.match(rows[0].definition,/not crop-weighted/);
 assert.equal(agri.parseDrought(csv.replace('20,80,60,40','20,80,60,90'),now,url).length,0);
 const weather='# Contiguous U.S.\n# Base Period: 1991-2020\n# Units: Degrees Fahrenheit\nDate,Value,Departure from Average\n202608,75,2.7\n202610,80,8';
 const w=agri.parseWeather(weather,'tavg',now,agri.noaaUrl('tavg',now));assert.equal(w.length,1);assert.equal(w[0].period,'2026-08-01');assert.equal(w[0].value,2.7);assert.match(w[0].definition,/not daily heat stress/);assert.equal(agri.parseWeather(weather,'pcp',now,url).length,0);
});
test('ethanol and exports verify units and series; zero exports have an explicit finite transform',()=>{
 const ethanol=agri.parseEthanol(fixture.ethanol,agri.ethanolSeries[0],now);assert.equal(ethanol.length,2);assert.equal(ethanol[0].value,1028);assert.equal(ethanol[0].period,'2026-09-18');assert.equal(ethanol[0].publicationDate,'2026-09-23');assert.equal(ethanol[0].releaseDate,null);
 assert.equal(agri.parseEthanol(fixture.ethanol.replace('Thousand Barrels per Day','Million Barrels'),agri.ethanolSeries[0],now).length,0);assert.equal(agri.parseEthanol(fixture.ethanol,agri.ethanolSeries[1],now).length,0);
 const exports=agri.parseExportInspections(fixture.exports,now);assert.equal(exports.length,6);assert.equal(exports.find(r=>r.metric==='alt.agri.exports.corn.level.v1').value,1565924);assert.ok(exports.every(r=>r.period==='2026-09-24'&&r.publicationDate==='2026-09-28'));
 const zero=agri.parseExportInspections(fixture.exports.replace('1,565,924','0'),now).find(r=>r.metric==='alt.agri.exports.corn.change.v1');assert.ok(Number.isFinite(zero.value)&&zero.value<0);assert.match(zero.definition,/current tonnes \+ 1/);
});
test('agricultural inputs are exposed only where justified; future releases cannot enter features or coverage',()=>{
 const p=data.getBaselinePayload();p.asOf=now;p.sourceChecks=[];const before=structuredClone(p);
 const observation=agri.parseCropProgress(fixture.progress,now,url)[0],f=research.buildResearchFrame(p,[observation]);assert.equal(f.features.USD[observation.metric],observation.normalizedValue);assert.equal(f.features.EUR[observation.metric],undefined);assert.deepEqual(p,before);
 for(const bad of [{...observation,publicationDate:'2026-10-01'},{...observation,scheduledPublicationAt:'2026-10-01T20:00:00Z'},{...observation,receivedAt:'2026-10-01T20:00:00Z'}]){assert.equal(research.buildResearchFrame(p,[bad]).features.USD[bad.metric],undefined);assert.equal(coverage.researchCoverage([bad],[],now).freshObservations,0);}
 const r=research.discoverRecipes([],f);assert.ok(r.some(r=>r.feature.startsWith('alt.agri.')));assert.ok(r.every(r=>r.weight===0&&r.status==='DISCOVERY'));assert.match(r[0].rationale,/common third cause/);
});
test('new grammar is bounded and retrospective outcomes never select features or alter formulas',()=>{
 const p=data.getBaselinePayload();p.asOf=now;p.sourceChecks=[];const f=research.buildResearchFrame(p,agri.parseCropProgress(fixture.progress,now,url));
 let registry=[];for(let i=0;i<8;i++)registry=research.discoverRecipes(registry,f);assert.ok(registry.length<=64);assert.ok(registry.some(r=>r.operator==='season'));assert.ok(registry.some(r=>r.operator==='acceleration'));assert.ok(registry.every(r=>r.weight===0));
 const z={...registry[0],feature:'alt.test',operator:'zscore',direction:1,lag:0},history=Array.from({length:30},(_,i)=>({...f,at:new Date(Date.parse(now)-(30-i)*day).toISOString(),features:{USD:{'alt.test':Math.sin(i)}}}));f.features.USD['alt.test']=.5;
 assert.equal(research.recipeSignal({...z,operator:'season',other:'season:jja'},f,history,'USD'),null);assert.equal(research.recipeSignal({...z,operator:'regime',other:'regime:other'},f,history,'USD'),null);assert.equal(research.recipeSignal({...z,operator:'threshold'},f,history,'USD'),null);
 assert.equal(research.recipeSignal(z,f,history,'USD'),research.recipeSignal(z,f,[...history,{...f,at:'2027-01-01T00:00:00Z',features:{USD:{'alt.test':999}}}],'USD'));
});
test('agricultural common-cause redundancy blocks activation; absent variable controls do not pass',()=>{
 const recipe={id:'agri',feature:'alt.agri.test',operator:'level'},frames=Array.from({length:40},(_,i)=>({at:new Date(Date.parse(now)-(40-i)*day).toISOString(),quality:'VALID',regimeVerified:true,sourceReliability:1,hypotheses:{agri:{USD:Math.sin(i)}},features:{USD:{'factor.momentum':Math.sin(i),'factor.risk':Math.cos(i*.31),'fx.trend':Math.cos(i*.77)}}}));
 assert.equal(research.agriculturalCommonCauseCheck(recipe,frames).reason,'REDUNDANT_WITH_CORE_OR_COMMON_CAUSE');assert.equal(research.agriculturalCommonCauseCheck(recipe,frames.slice(0,15)).passed,false);
});
test('optional agricultural collection bounds requests and explicitly records missing configuration and failed sources',async(t)=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let active=0,peak=0;
 globalThis.fetch=async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;return new Response('No valid source data');};
 const checks=[];assert.deepEqual(await agri.collectAgriculturalInputs(checks,undefined),[]);assert.equal(peak,3);assert.equal(checks.filter(c=>c.status==='MISSING'&&c.cause==='NOT_CONFIGURED').length,3);assert.equal(checks.filter(c=>c.status==='FAILED').length,9);
});
test('context cannot bypass failed historical ensemble certification using later perfect predictions',()=>{
 const cert={passed:true,validationVersion:'date-cluster-hac-v1'},model={id:'fixture',status:'SHADOW',weight:0,historicalGate:cert,holdoutGate:cert,historicalIncrementalGate:{...cert,passed:false},holdoutIncrementalGate:cert};
 const result=context.advanceContextModel(model,[],[],now,1);assert.equal(result.weight,0);assert.equal(result.status,'SHADOW');assert.equal(research.incrementalCertified(model),false);
});
test('agricultural revisions preserve prior vintages; future reference periods and schedules are rejected locally',async()=>{
 const sql=new DatabaseSync(':memory:');for(const file of ['0000_hesitant_krista_starr.sql','0001_happy_mandroid.sql','0002_sudden_blazing_skull.sql'])sql.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 const db={prepare(query){const s=sql.prepare(query);let v=[];return {bind(...x){v=x;return this},async all(){return {results:s.all(...v)}},async run(){return s.run(...v)}}},async batch(rows){return Promise.all(rows.map(r=>r.run()))}};
 const r=agri.parseCropProgress(fixture.progress,now,url)[0];await runtime.archiveObservations(db,[r],now);const later='2026-10-01T12:00:00.000Z';await runtime.archiveObservations(db,[{...r,receivedAt:later}],later);assert.equal(sql.prepare('SELECT count(*) n FROM observation_vintages').get().n,1);
 await runtime.archiveObservations(db,[{...r,value:r.value+1,receivedAt:later}],later);assert.equal(sql.prepare('SELECT count(*) n FROM observation_vintages').get().n,2);
 await runtime.archiveObservations(db,[{...r,period:'2026-11-01'},{...r,scheduledPublicationAt:'2026-11-01T20:00:00Z'}],now);assert.equal(sql.prepare('SELECT count(*) n FROM observation_vintages').get().n,2);sql.close();
});
