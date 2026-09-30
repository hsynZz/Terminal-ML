import assert from 'node:assert/strict';
import test,{after} from 'node:test';
import {createServer} from 'vite';
const vite=await createServer({configFile:false,appType:'custom',resolve:{alias:{'@':process.cwd()}},server:{middlewareMode:true,hmr:false}});after(()=>vite.close());
const temporal=await vite.ssrLoadModule('/lib/temporal-validation.ts'),legacy=await vite.ssrLoadModule('/lib/hypothesis/engine.ts'),research=await vite.ssrLoadModule('/lib/production-research.ts');
const day=86400000,date=n=>new Date(Date.parse('2020-01-01')+n*day).toISOString().slice(0,10);
const rows=(n,h=10)=>Array.from({length:n},(_,i)=>({asOf:date(i)+'T15:00:00Z',entryDate:date(i+1),labelEnd:date(i+h+1),resolvedAt:date(i+h+2)+'T15:00:00Z',pair:'USD',pointInTimeVerified:true,label:i%2,probability:.5,baseline:.5,candidate:.5,regime:i%2?'risk-on':'risk-off',effect:Math.sin(i*1.731)+.01}));
test('old double horizon spacing is proved; all overlapping date clusters now remain',()=>{
 const r=rows(220),old=legacy.independentBlocks(r,10),current=temporal.dateClusters(r);
 assert.equal(old[1].asOf,date(22));assert.equal(current.clusters.length,220);assert.ok(old.length<12);
 const d=temporal.dependence(r,x=>x.effect);assert.ok(d.overlappingLabelRatio>0);assert.equal(d.rawObservations,220);assert.ok(d.effectiveSampleSize<=220);assert.ok(d.bandwidth>=10);
});
test('eight currencies count as one forecast-date cluster; repeated same-date entities do not inflate information',()=>{
 const r=rows(150,3),all=r.flatMap(x=>['USD','EUR','GBP','CHF','CAD','AUD','NZD','JPY'].map(pair=>({...x,pair})));
 const a=temporal.dependence(r,x=>x.effect),b=temporal.dependence(all,x=>x.effect);assert.equal(b.rawObservations,1200);assert.equal(b.uniqueForecastDates,150);assert.ok(Math.abs(a.effectiveSampleSize-b.effectiveSampleSize)<1e-10);
 assert.equal(temporal.dependence([...all,...all],x=>x.effect).uniqueForecastDates,150);assert.equal(temporal.dateClusters([...all,...all]).removed.length,1200);
});
test('purging uses exact entry/end intervals and actual label availability; each exclusion is audited',()=>{
 const testRows=[{asOf:date(20)+'T15:00:00Z',entryDate:date(22),labelEnd:date(32),pair:'USD'}];
 const train=[{asOf:date(1)+'T15:00:00Z',entryDate:date(2),labelEnd:date(18),resolvedAt:date(19)+'T15:00:00Z',pair:'safe'}, {asOf:date(10)+'T15:00:00Z',entryDate:date(11),labelEnd:date(23),pair:'overlap'}, {asOf:date(2)+'T15:00:00Z',entryDate:date(3),labelEnd:date(18),resolvedAt:date(21)+'T15:00:00Z',pair:'unavailable'}];
 const r=temporal.purgeFold(train,testRows);assert.deepEqual(r.kept.map(x=>x.pair),['safe']);assert.deepEqual(r.removed.map(x=>x.reason),['LABEL_OVERLAP','LABEL_NOT_AVAILABLE']);assert.equal(r.removed[0].labelEnd,date(23));assert.equal(r.removed[0].testStart,testRows[0].asOf);
});
test('embargo occurs only after the previous fold, ending at its real last label; earlier dates are retained',()=>{
 const prior=[{asOf:date(10)+'T15:00:00Z',entryDate:date(11),labelEnd:date(20)}],train=rows(25,1),testRows=rows(1,1).map(x=>({...x,asOf:date(30)+'T15:00:00Z',entryDate:date(31),labelEnd:date(32)}));
 const r=temporal.purgeFold(train,testRows,prior);assert.equal(r.removed.filter(x=>x.reason==='FOLD_EMBARGO').length,10);assert.ok(r.kept.some(x=>x.asOf.startsWith(date(9))));assert.ok(r.kept.some(x=>x.asOf.startsWith(date(21))));assert.equal(r.embargoEnd,date(20));
});
test('strong serial dependence decreases ESS and increases uncertainty; degenerate effects cannot fabricate confidence',()=>{
 const r=rows(1000,30).map((x,i)=>({...x,effect:Math.sin(i/80)+.005*Math.cos(i*1.7)}));const d=temporal.dependence(r,x=>x.effect),iid=temporal.dependence(rows(1000,30),x=>x.effect);
 assert.ok(d.effectiveSampleSize<30);assert.ok(d.effectiveSampleSize<iid.effectiveSampleSize/10);assert.ok(d.standardError>.05);assert.equal(temporal.dependence(r,()=>.03).pValue,1);assert.equal(temporal.dependence(r,()=>.03).effectiveSampleSize,0);
});
test('Student tail numerical references and family/repeated-look correction remain intact',()=>{
 assert.ok(Math.abs(temporal.studentUpperTail(2,10)-.0366940173853702)<1e-12);assert.ok(Math.abs(temporal.studentUpperTail(5,10)-.000268666801378226)<1e-12);
 const r=rows(180,1).map((x,i)=>({...x,label:1,probability:.52+.008*Math.sin(i*1.7)}));const g=research.validationGate(r,1,4096,3);
 assert.equal(g.adjustedP,Math.min(1,g.diagnostics.pValue*4096*3*4));assert.equal(g.validationVersion,temporal.VALIDATION_VERSION);assert.ok(g.blocks<=g.diagnostics.uniqueForecastDates);
});
test('frozen historical epochs depend only on forecast dates, never outcomes or future features',()=>{
 const r=rows(147);assert.deepEqual(temporal.historicalEpoch(r).holdout.map(x=>x.asOf),temporal.historicalEpoch(r.map(x=>({...x,label:1-x.label}))).holdout.map(x=>x.asOf));assert.equal(temporal.historicalEpoch(r).count,140);assert.equal(temporal.historicalEpoch(r).nextDateCount,150);assert.equal(temporal.historicalEpoch(rows(119)),null);
});
test('a forged prospective pass without current historical and holdout certification has zero influence',()=>{
 const r={id:'fixture',status:'ACTIVE',weight:.025,gate:{passed:true,validationVersion:temporal.VALIDATION_VERSION},lastChangedAt:'2025-01-01T00:00:00Z'};assert.equal(research.effectiveRecipeWeight(r,'2025-01-02T00:00:00Z'),0);assert.equal(research.certified(r),false);
});

test('invalid calendar intervals and labels resolved before the outcome fail closed without throwing',()=>{
 for(const invalid of [{...rows(1)[0],entryDate:'2020-99-01'},{...rows(1)[0],labelEnd:'2020-02-30'},{...rows(1)[0],resolvedAt:'2020-01-02T15:00:00Z'}]){assert.equal(temporal.labelInterval(invalid),null);assert.equal(temporal.dateClusters([invalid]).removed[0].reason,'INVALID_INTERVAL');}
});

test("unverified point-in-time rows never qualify",()=>{assert.equal(research.validationGate(rows(180).map(r=>({...r,pointInTimeVerified:false})),10,1,1).samples,0);});
