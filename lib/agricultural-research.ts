import { csvRecords } from './observed-sources';
import { dayMs, observationQuality, type Observation, type SourceCheck } from './production-data';
import { sourceAttempt, sourceFetch } from './source-health';

export const AGRICULTURAL_VERSION='agricultural-receipt-v1';
const mean=(x:number[])=>x.reduce((a,b)=>a+b,0)/Math.max(1,x.length);
const bounded=(v:number)=>Math.tanh(v);
const iso=(text:string)=>{
 const numeric=text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/),named=text.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/),standard=text.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
 const month=numeric?Number(numeric[1]):named?['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(named[1].slice(0,3).toLowerCase())+1:standard?Number(standard[2]):0,day=numeric?Number(numeric[2]):named?Number(named[2]):standard?Number(standard[3]):0,year=numeric?Number(numeric[3]):named?Number(named[3]):standard?Number(standard[1]):0;
 if(year<1900||month<1||month>12||day<1||day>31)return null;const date=new Date(Date.UTC(year,month-1,day)).toISOString().slice(0,10);return Number(date.slice(8))===day?date:null;
};
const localExposure=[{currency:'USD',reason:'US crop supply, farm income, food inflation and ethanol demand; FX sign is unproven.'}];
export const agriculturalExposures={
 corn:[...localExposure,{currency:'CAD',reason:'Grain trade competition and Canadian feed input costs.'},{currency:'NZD',reason:'Imported feed costs and livestock margins, not a dairy-price observation.'},{currency:'JPY',reason:'Food/feed import costs; control for energy and rates.'}],
 wheat:[...localExposure,{currency:'AUD',reason:'Wheat export competition and terms of trade; control for China demand.'},{currency:'CAD',reason:'Wheat export revenues and trade competition.'},{currency:'EUR',reason:'Regional wheat exports and food inflation; US prices are an indirect proxy.'},{currency:'GBP',reason:'Food import costs and inflation.'},{currency:'JPY',reason:'Grain import costs.'},{currency:'CHF',reason:'Food import inflation; indirect, weak exposure requiring independent validation.'}],
 soy:[...localExposure,{currency:'CAD',reason:'Oilseed trade competition.'},{currency:'AUD',reason:'China-linked commodity demand common-cause test; not Australian soy production.'},{currency:'NZD',reason:'Feed input costs and livestock margins.'}],
};
function receipt(metric:string,value:number,normalized:number,period:string,now:string,source:string,url:string,unit:string,frequency:string,definition:string,cause:string,rawInputs:unknown[],publicationDate:string|null=null,exposures=localExposure):Observation{
 return {currency:'USD',metric:'alt.agri.'+metric+'.v1',value,normalizedValue:bounded(normalized),period,receivedAt:now,source,sourceUrl:url,unit,frequency,releaseDate:null,publicationDate,publicationTimeKnown:false,revision:'As received; immutable content-hash vintage. Current revisions are not original historical releases.',researchExposures:exposures,featureVersion:AGRICULTURAL_VERSION,definition:definition+' Research only; no direct FX direction or Core points. Availability begins at actual receipt.',economicCause:cause,lineage:[source+':'+metric.split('.').slice(0,3).join('.')],rawInputs,quality:observationQuality('alt.agri.'+metric+'.v1',value,period,now)};
}
/** Source schedules are an earliest-availability check, never a fabricated exact publication timestamp. */
export function newYorkSchedule(date:string,hour:number,minute=0){
 const base=Date.parse(date+`T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00Z`),parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(base),localHour=Number(parts.find(x=>x.type==='hour')?.value),localMinute=Number(parts.find(x=>x.type==='minute')?.value);
 return new Date(base+(hour-localHour)*3600000+(minute-localMinute)*60000).toISOString();
}
function publication(text:string,now:string,hour:number){
 const match=text.match(/Released\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/),date=match?iso(match[1]):null;
 if(!date||date>now.slice(0,10))return null;const schedule=newYorkSchedule(date,hour);if(schedule>now)return null;
 return {date,schedule};
}
function values(line:string,count:number){const raw=line.split(':').at(-1)?.trim().split(/\s+/)??[];if(raw.length!==count)return null;const nums=raw.map(x=>x==='-'?0:/^\d[\d,]*(?:\.\d+)?$/.test(x)?Number(x.replaceAll(',','')):NaN);return nums.every(Number.isFinite)?nums:null;}
export const cropProgressUrl='https://esmis.nal.usda.gov/publication/crop-progress';
export function usdaTextLinks(html:string){return [...new Set([...html.matchAll(/href="(\/sites\/default\/release-files\/[^"\s]+\.txt)"/g)].map(x=>new URL(x[1],'https://esmis.nal.usda.gov').href))].slice(0,2);}
export function parseCropProgress(text:string,now:string,url:string):Observation[]{
 const pub=publication(text,now,16);if(!pub||!/^\s*Crop Progress\s/m.test(text))return [];
 const sections=text.replaceAll('\r','').split(/(?=^[A-Za-z][^\n]+ - Selected States)/m),result:Observation[]=[];
 for(const crop of ['Corn','Soybean','Winter Wheat','Spring Wheat']){
  const key=crop==='Corn'?'corn':crop==='Soybean'?'soy':'wheat.'+crop.split(' ')[0].toLowerCase();
  const section=sections.find(s=>s.startsWith(crop+' Condition - Selected States'));if(section){
   const ref=section.match(/Week Ending\s+([A-Za-z]+\s+\d{1,2},\s+\d{4})/),period=ref?iso(ref[1]):null;
   const current=section.split('\n').find(s=>/^\d+ States\s*\.+:/.test(s)),prior=section.split('\n').find(s=>/^Previous week\s*\.+:/.test(s)),a=current?values(current,5):null,b=prior?values(prior,5):null;
   if(period&&period<=pub.date&&a&&a.every(x=>x>=0&&x<=100)&&Math.abs(a.reduce((x,y)=>x+y,0)-100)<.01){
    const good=a[3]+a[4];result.push(receipt(`crop.${key}.condition.level`,good,good/100,period,now,'USDA NASS Crop Progress',url,'percent good + excellent','weekly; crop season',`${crop} selected-state acreage-weighted condition, good + excellent; not a global yield measure.`,'US weather → crop condition → yield expectations → grain/feed/food costs',[{categories:a,publicationDate:pub.date}],pub.date));
    if(b&&Math.abs(b.reduce((x,y)=>x+y,0)-100)<.01)result.push(receipt(`crop.${key}.condition.weekly_change`,good-b[3]-b[4],(good-b[3]-b[4])/100,period,now,'USDA NASS Crop Progress',url,'percentage points','weekly; crop season','Change versus previous week as printed in this release; corrections are known only now.','US crop-condition deterioration',[{current:a,previousWeek:b}],pub.date));
   }
  }
 }
 // Progress tables have previous year, previous week, current week and the published five-year average.
 for(const [name,key] of [['Corn Harvested','corn.harvest'],['Corn Planted','corn.planting'],['Soybeans Harvested','soy.harvest'],['Soybeans Planted','soy.planting'],['Winter Wheat Planted','wheat.winter.planting']] as const){
  const section=sections.find(s=>s.startsWith(name+' - Selected States'));if(!section)continue;
  const ref=section.match(/([A-Za-z]+\s+\d{1,2}),?\s*:\s*([A-Za-z]+\s+\d{1,2}),?\s*:\s*([A-Za-z]+\s+\d{1,2}),?/),year=Number(pub.date.slice(0,4)),period=ref?iso(ref[3]+', '+year):null,line=section.split('\n').find(s=>/^\d+ States\s*\.+:/.test(s)),v=line?values(line,4):null;
  if(!period||period>pub.date||!v||v.some(x=>x<0||x>100))continue;
  result.push(receipt(`crop.${key}.level`,v[2],v[2]/100,period,now,'USDA NASS Crop Progress',url,'percent completed','weekly; crop season',name+' selected states; reported crop progress.','US seasonal crop production',[{previousYear:v[0],previousWeek:v[1],current:v[2],fiveYearAverage:v[3]}],pub.date),receipt(`crop.${key}.seasonal_deviation`,v[2]-v[3],(v[2]-v[3])/100,period,now,'USDA NASS Crop Progress',url,'percentage points','weekly; crop season','Current progress minus published five-year seasonal average, known at this receipt.','US seasonal crop timing',[{current:v[2],fiveYearAverage:v[3]}],pub.date));
 }
 // Surveyed moisture shares are not remotely sensed soil moisture or a weather forecast.
 for(const kind of ['Topsoil','Subsoil']){const section=text.replaceAll('\r','').split(kind+' Moisture Condition - Selected States: Week Ending')[1];if(!section)continue;
  const ref=section.match(/([A-Za-z]+\s+\d{1,2},\s+\d{4})/),period=ref?iso(ref[1]):null,line=section.split('\n').find(s=>/^48 States\s*\.+:/.test(s)),v=line?values(line,4):null;
  if(period&&period<=pub.date&&v&&v.every(x=>x>=0&&x<=100)&&v.reduce((a,b)=>a+b,0)===100)result.push(receipt(`crop.moisture.${kind.toLowerCase()}.short`,v[0]+v[1],(v[0]+v[1])/100,period,now,'USDA NASS Crop Progress',url,'percent very short + short','weekly','NASS 48-state surveyed moisture shortage, provider cropland-acreage weighting; no invented local weights or remotely sensed soil-moisture values.','US moisture → crop condition → expected yield',[{categories:v}],pub.date));
 }
 return result.map(r=>({...r,scheduledPublicationAt:pub.schedule}));
}
export const agriculturalPrices=[{id:'PMAIZMTUSDM',crop:'corn'},{id:'PWHEAMTUSDM',crop:'wheat'},{id:'PSOYBUSDM',crop:'soy'}] as const;
export function parseAgriculturalPrice(body:{observations?:{date:string;value:string}[]},spec:typeof agriculturalPrices[number],now:string){
 const rows=(body.observations??[]).filter(r=>r.value?.trim()&&Number(r.value)>0&&Number.isFinite(Number(r.value))&&/^\d{4}-\d{2}-01$/.test(r.date)&&iso(r.date)===r.date&&r.date<now.slice(0,7)+'-01').sort((a,b)=>b.date.localeCompare(a.date)).filter((r,i,a)=>!i||r.date!==a[i-1].date);
 if(rows.length<13)return [];const period=rows[0].date,price=Number(rows[0].value),url='https://fred.stlouisfed.org/series/'+spec.id,result:Observation[]=[],exposures=agriculturalExposures[spec.crop];
 const make=(key:string,value:number,normalized:number,definition:string)=>receipt(`price.${spec.crop}.${key}`,value,normalized,period,now,'IMF agricultural prices via FRED',url,'USD per metric tonne / defined transform','monthly',definition+' IMF monthly benchmark spot-price proxy, not futures or a daily quote.','Global grain supply/demand → trade competition and feed/food inflation; common causes: USD, oil, China demand',rows.slice(0,60),null,exposures);
 result.push(make('level',price,price/1000,'Raw monthly USD/tonne; normalized tanh(price/1000). Fixed Research scale, no FX sign.'));
 for(const months of [1,3])if(rows[months].date===new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7))-1-months,1)).toISOString().slice(0,10)){const change=Math.log(price/Number(rows[months].value));result.push(make('change_'+months+'m',change,change,'Calendar-month log price change.'));}
 const contiguous=rows.slice(0,13).every((r,i)=>r.date===new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7))-1-i,1)).toISOString().slice(0,10));
 if(contiguous){const returns=rows.slice(0,12).map((r,i)=>Math.log(Number(r.value)/Number(rows[i+1].value))),vol=Math.sqrt(mean(returns.map(x=>(x-mean(returns))**2)));result.push(make('volatility_12m',vol,vol,'Standard deviation of twelve monthly log changes, not implied volatility.'));}
 const seasonal=rows.slice(1).filter(r=>r.date.slice(5,7)===period.slice(5,7)).map(r=>Number(r.value));if(seasonal.length>=3){const delta=price/mean(seasonal)-1;result.push(make('seasonal_deviation',delta,delta,'Relative to at least three prior same-calendar-month prices as received now; revised reference values are not backdated.'));}
 return result;
}
export function droughtUrl(now:string){const start=new Date(Date.parse(now)-60*dayMs).toISOString().slice(0,10);return `https://usdmdataservices.unl.edu/api/USStatistics/GetDroughtSeverityStatisticsByAreaPercent?aoi=us&startdate=${start}&enddate=${now.slice(0,10)}&statisticsType=1`;}
export function parseDrought(csv:string,now:string,url:string){
 const rows=csvRecords(csv).filter(r=>r.AreaOfInterest==='CONUS'&&r.StatisticFormatID==='1'&&/^\d{8}$/.test(r.MapDate)).map((r):Record<string,string>&{period:string}=>({...r,period:r.MapDate.slice(0,4)+'-'+r.MapDate.slice(4,6)+'-'+r.MapDate.slice(6,8)})).filter(r=>r.period<=now.slice(0,10)&&r.ValidStart===r.period).sort((a,b)=>b.period.localeCompare(a.period));
 const a=rows[0],b=rows[1];if(!a)return [];
 const v=['None','D0','D1','D2','D3','D4'].map(k=>a[k]?.trim()?Number(a[k]):NaN);if(v.some(x=>!Number.isFinite(x)||x<0||x>100)||Math.abs(v[0]+v[1]-100)>.1||v.slice(1).some((x,i)=>i>0&&x>v[i]))return [];
 // Map/reference Tuesday is not publication. Do not infer an exact release time from it.
 const result:Observation[]=[];for(const severity of ['D2','D4']){const value=Number(a[severity]);result.push(receipt(`drought.us.${severity.toLowerCase()}.level`,value,value/100,a.period,now,'US Drought Monitor',url,'CONUS cumulative area percent','weekly','Cumulative CONUS area at or above '+severity+'; USDM combines NOAA/USDA/NDMC information. National area is not crop-weighted.','US drought → crop condition → yield/feed costs',[a]));if(b&&Date.parse(a.period)-Date.parse(b.period)===7*dayMs&&b[severity]?.trim()&&Number.isFinite(Number(b[severity]))){const delta=value-Number(b[severity]);result.push(receipt(`drought.us.${severity.toLowerCase()}.change`,delta,delta/100,a.period,now,'US Drought Monitor',url,'percentage points','weekly','Seven-day change in the same cumulative drought area definition.','US drought change',[a,b]));}}
 return result;
}
export function noaaUrl(kind:'tavg'|'pcp',now:string){return `https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/national/time-series/110/${kind}/1/0/${Number(now.slice(0,4))-2}-${now.slice(0,4)}.csv?base_prd=true&begbaseyear=1991&endbaseyear=2020`;}
export function parseWeather(csv:string,kind:'tavg'|'pcp',now:string,url:string){
 if(!csv.includes('Contiguous U.S.')||!csv.includes('Base Period: 1991-2020')||!csv.includes(kind==='tavg'?'Units: Degrees Fahrenheit':'Units: Inches'))return [];
 const rows=csvRecords(csv.split('\n').filter(x=>!x.startsWith('#')).join('\n')).filter(r=>/^\d{6}$/.test(r.Date)&&r.Value?.trim()&&r['Departure from Average']?.trim()).sort((a,b)=>b.Date.localeCompare(a.Date)),r=rows.find(r=>r.Date<now.slice(0,7).replace('-',''));if(!r)return [];
 const period=r.Date.slice(0,4)+'-'+r.Date.slice(4,6)+'-01',value=Number(r['Departure from Average']);if(!Number.isFinite(value)||Math.abs(value)>(kind==='tavg'?40:30))return [];
 return [receipt('weather.us.'+(kind==='tavg'?'temperature':'rainfall')+'.anomaly',value,kind==='tavg'?value*5/9/3:value/3,period,now,'NOAA NCEI Climate at a Glance',url,kind==='tavg'?'degrees Fahrenheit departure':'inches departure','monthly','CONUS monthly departure from the published 1991–2020 normal; not daily heat stress, crop-region rainfall or yield prediction.','US weather → crop condition → expected yield; crop exposure must be tested',[r,{basePeriod:'1991-2020'}])];
}
export const ethanolSeries=[{id:'W_EPOOXE_YOP_NUS_MBBLD',name:'production',title:'Oxygenate Plant Production',unit:'thousand barrels per day'},{id:'W_EPOOXE_SAE_NUS_MBBL',name:'inventory',title:'Ending Stocks',unit:'thousand barrels'}] as const;
export function ethanolUrl(id:string){return `https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=pet&s=${id}&f=w`;}
export function parseEthanol(html:string,spec:typeof ethanolSeries[number],now:string){
 const plain=(s:string)=>s.replace(/<[^>]+>/g,'').replaceAll('&nbsp;',' ').trim(),title=html.match(/<title>([\s\S]*?)<\/title>/i)?.[1];if(!title?.includes(spec.title)||!title.includes('Fuel Ethanol')||!title.toLowerCase().includes('('+spec.unit+')'))return [];
 const release=html.match(/(?<!Next )Release Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/),pub=release?iso(release[1]):null;if(!pub||pub>now.slice(0,10))return [];
 const points:{date:string;value:number}[]=[];
 for(const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi)??[]){const year=plain(tr).match(/\b(\d{4})-[A-Za-z]{3}/)?.[1];if(!year)continue;const cells=[...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x=>plain(x[1]));for(let i=1;i+1<cells.length;i+=2){if(!/^\d{2}\/\d{2}$/.test(cells[i])||!/^\d[\d,]*$/.test(cells[i+1]))continue;const date=iso(cells[i]+'/'+year),value=Number(cells[i+1].replaceAll(',',''));if(date&&date<=pub&&value>0)points.push({date,value});}}
 points.sort((a,b)=>b.date.localeCompare(a.date));const a=points[0],b=points[1];if(!a||!b||Date.parse(a.date)-Date.parse(b.date)!==7*dayMs)return [];
 const source='EIA weekly fuel ethanol',url=ethanolUrl(spec.id),result=[receipt(`ethanol.${spec.name}.level`,a.value,a.value/(spec.name==='production'?2000:40000),a.date,now,source,url,spec.unit,'weekly','US '+spec.title+' of fuel ethanol; raw EIA definition.','US corn demand → ethanol → fuel substitution; control for gasoline/oil',points.slice(0,5),pub),receipt(`ethanol.${spec.name}.change`,Math.log(a.value/b.value),Math.log(a.value/b.value),a.date,now,source,url,'weekly log change','weekly','Seven-day log change in the exact EIA series.','US ethanol/corn demand and energy substitution',points.slice(0,5),pub)];return result;
}
export const exportInspectionUrl='https://www.ams.usda.gov/mnreports/wa_gr101.txt';
export function parseExportInspections(text:string,now:string){
 if(!text.startsWith('WA_GR101')||!text.includes('USDA Market News')||!text.includes('-- METRIC TONS --'))return [];
 const header=text.split(/\r?\n/)[1],pub=iso(header.match(/[A-Za-z]{3}\s+\d{1,2},\s+\d{4}/)?.[0]??''),summary=text.slice(0,text.indexOf('CROP MARKETING YEARS BEGIN')),dates=summary.match(/GRAIN\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})/),period=dates?iso(dates[1]):null;if(!pub||pub>now.slice(0,10)||!period||period>pub)return [];
 const result:Observation[]=[];for(const [name,key] of [['CORN','corn'],['SOYBEANS','soy'],['WHEAT','wheat']] as const){const line=summary.split(/\r?\n/).find(x=>new RegExp('^'+name+'\\s').test(x)),numbers=line?.trim().split(/\s+/).slice(1).map(x=>/^\d[\d,]*$/.test(x)?Number(x.replaceAll(',','')):NaN);if(!numbers||numbers.length!==5||!numbers.every(Number.isFinite))continue;
  result.push(receipt(`exports.${key}.level`,numbers[0],numbers[0]/3000000,period,now,'USDA AMS Grain Inspections',exportInspectionUrl,'metric tonnes','weekly','Inspected/weighed exports, not export sales. Corrections in current market-year totals are known at this receipt.','US grain exports → trade balance and farm income',[{current:numbers[0],previousWeek:numbers[1],previousYear:numbers[2]}],pub));
  if(numbers[1]>0)result.push(receipt(`exports.${key}.change`,Math.log((numbers[0]+1)/(numbers[1]+1)),Math.log((numbers[0]+1)/(numbers[1]+1)),period,now,'USDA AMS Grain Inspections',exportInspectionUrl,'weekly log change','weekly','Current versus previous weekly inspections printed in this release. Transform: log((current tonnes + 1)/(previous tonnes + 1)), including zero exports.', 'US grain export demand',[numbers],pub));
 }return result;
}
export const cropProductionUrl='https://esmis.nal.usda.gov/publication/crop-production',grainStocksUrl='https://esmis.nal.usda.gov/publication/grain-stocks';
export function parseCropProduction(text:string,now:string,url:string){
 const pub=publication(text,now,12);if(!pub||!/^\s*Crop Production\s/m.test(text))return [];
 const clean=text.replaceAll('\r',''),header='Crop Area Planted and Harvested, Yield, and Production in Domestic Units - United States:',sections=[...clean.matchAll(new RegExp('^'+header+'\\n(\\d{4}) and (\\d{4})[^\\n]*','gm'))];
 if(sections.length<2||sections.some(m=>Number(m[2])!==Number(pub.date.slice(0,4))))return [];
 const area=clean.slice(sections[0].index,sections[1].index),yieldSection=clean.slice(sections[1].index).split('Crop Area Planted and Harvested, Yield, and Production in Metric Units')[0];
 if(!area.includes('1,000 acres')||!yieldSection.includes('Yield per acre')||!yieldSection.includes('Production')||!yieldSection.includes('1,000'))return [];
 const result:Observation[]=[];
 for(const [title,key] of [['Corn for grain','corn'],['Soybeans for beans','soy'],['Wheat, all','wheat']] as const){
  const aLine=area.split('\n').find(l=>l.startsWith(title+' ')),yLine=yieldSection.split('\n').find(l=>l.startsWith(title+' ')&&l.includes('bushels:')),a=aLine?values(aLine,4):null,y=yLine?values(yLine,4):null;
  const ref=clean.match(new RegExp((key==='corn'?'Corn for Grain':key==='soy'?'Soybeans for Beans':'All Wheat')+' Area Harvested, Yield, and Production[\\s\\S]{0,150}?Forecasted\\s+([A-Za-z]+ 1, \\d{4})')),period=ref?iso(ref[1]):key==='wheat'?pub.date.slice(0,4)+'-01-01':null;if(!period||period>pub.date)continue;
  if(a&&a.every(v=>v>0))result.push(receipt(`acreage.${key}.planted`,a[1],Math.log(a[1]/a[0]),pub.date.slice(0,4)+'-01-01',now,'USDA NASS Crop Production',url,'thousand acres','crop-year estimate',title+' planted acreage from the domestic-unit national summary; latest available estimate, not completed future harvest.','US planted area → expected supply → grain prices',[{cropYear:pub.date.slice(0,4),priorYear:a[0],currentYear:a[1]}],pub.date));
  if(!y||y.some(v=>v<=0)||y[1]>500)continue;
  if(a&&Math.abs(y[3]/(a[3]*y[1])-1)>.1)continue;
  result.push(receipt(`estimate.${key}.yield`,y[1],Math.log(y[1]/y[0]),period,now,'USDA NASS Crop Production',url,'bushels per acre','monthly crop-year estimate',title+' published yield estimate; past-year comparator is not a market consensus.','US weather/acreage → yield expectations → grain/feed/food costs',[{previousCropYear:y[0],currentEstimate:y[1],reference:period}],pub.date),receipt(`estimate.${key}.production`,y[3],Math.log(y[3]/y[2]),period,now,'USDA NASS Crop Production',url,'thousand bushels','monthly crop-year estimate',title+' published crop-year production estimate, not a realized future outcome.','US crop supply → trade balance and food inflation',[{previousCropYear:y[2],currentEstimate:y[3]}],pub.date));
  if(key!=='wheat'){const full=clean.split(key==='corn'?'Corn for Grain Area Harvested, Yield, and Production - States and United States:':'Soybeans for Beans Area Harvested, Yield, and Production - States and United States:').findLast(s=>/^ \d{4}\s+and\s+Forecasted/.test(s)),line=full?.split('\n').find(l=>l.startsWith('United States ')),v=line?values(line,7):null,columns=full?.match(/:\s*([A-Za-z]+ 1)\s*:\s*([A-Za-z]+\s+1)\s*:/),current=columns?iso(columns[2]+', '+pub.date.slice(0,4)):null;
   if(v&&v.every(x=>x>0)&&columns&&current===period)result.push(receipt(`estimate.${key}.yield_revision`,v[4]-v[3],(v[4]-v[3])/v[3],period,now,'USDA NASS Crop Production',url,'bushels per acre revision','monthly','Current-minus-prior monthly yield estimate printed in the current report. Both column dates are explicitly identified; unsupported schemas emit no revision.','US yield-estimate revision → grain-price expectations',[{priorReference:columns[1],currentReference:columns[2],priorEstimate:v[3],currentEstimate:v[4]}],pub.date));
  }
 }
 return result.map(r=>({...r,scheduledPublicationAt:pub.schedule}));
}
export function parseGrainStocks(text:string,now:string,url:string){
 const pub=publication(text,now,12);if(!pub||!/^\s*Grain Stocks\s/m.test(text))return [];
 const clean=text.replaceAll('\r',''),match=clean.match(/^Grain Stocks by Position and Month in Domestic Units - United States: (\d{4}) and (\d{4})\s*$/m);if(!match||match[2]!==pub.date.slice(0,4))return [];
 const section=clean.slice(match.index).split('Grain Stocks by Position and Month in Metric Units')[0];if(!section.includes('1,000 bushels')||!section.includes('Total all'))return [];
 const result:Observation[]=[];for(const [title,key] of [['Corn','corn'],['Soybeans','soy'],['All wheat','wheat']] as const){
  const block=section.split(new RegExp('^'+title+' +:', 'm'))[1]?.split(/^\w[^\n]* +:/m)[0];if(!block)continue;
  const points=block.split('\n').flatMap(line=>{const date=line.match(/^([A-Za-z]+ 1) +\.+:/),period=date?iso(date[1]+', '+match[2]):null,v=date?values(line,6):null;return period&&period<=pub.date&&v&&v.every(x=>x>=0)&&Math.abs(v[3]+v[4]-v[5])<=2?[{period,v}]:[];}).sort((a,b)=>b.period.localeCompare(a.period)),point=points[0];if(!point||point.v[2]<=0||point.v[5]<=0)continue;
  result.push(receipt(`stocks.${key}.level`,point.v[5],Math.log(point.v[5]/point.v[2]),point.period,now,'USDA NASS Grain Stocks',url,'thousand bushels','quarterly, release after reference date','Total on/off-farm stocks; normalized year-on-year log change. Reference date, publication day and actual receipt remain separate.','US grain inventory → available supply → food/feed prices',[{current:point.v[5],priorYear:point.v[2],onFarm:point.v[3],offFarm:point.v[4]}],pub.date));
 }return result.map(r=>({...r,scheduledPublicationAt:pub.schedule}));
}
export async function collectAgriculturalInputs(checks:SourceCheck[],apiKey:string|undefined){
 const tasks:(()=>Promise<Observation[]|null>)[]=[];
 tasks.push(()=>sourceAttempt(checks,'USDA NASS Crop Progress',cropProgressUrl,'USD',['alt.agri.crop.'],async()=>{const html=await(await sourceFetch(cropProgressUrl,'text/html')).text(),url=usdaTextLinks(html)[0];if(!url)return null;const rows=parseCropProgress(await(await sourceFetch(url,'text/plain')).text(),new Date().toISOString(),url);return rows.length?rows:null;}));
 for(const [url,source,parse,metrics] of [[cropProductionUrl,'USDA NASS Crop Production',parseCropProduction,['alt.agri.estimate.','alt.agri.acreage.']],[grainStocksUrl,'USDA NASS Grain Stocks',parseGrainStocks,['alt.agri.stocks.']]] as const)tasks.push(()=>sourceAttempt(checks,source,url,'USD',[...metrics],async()=>{const html=await(await sourceFetch(url,'text/html')).text(),link=usdaTextLinks(html)[0];if(!link)return null;const rows=parse(await(await sourceFetch(link,'text/plain')).text(),new Date().toISOString(),link);return rows.length?rows:null;}));
 const now=new Date().toISOString(),url=droughtUrl(now);tasks.push(()=>sourceAttempt(checks,'US Drought Monitor',url,'USD',['alt.agri.drought.'],async()=>{const rows=parseDrought(await(await sourceFetch(url,'text/csv')).text(),new Date().toISOString(),url);return rows.length?rows:null;}));
 for(const kind of ['tavg','pcp'] as const){const url=noaaUrl(kind,now);tasks.push(()=>sourceAttempt(checks,'NOAA NCEI Climate at a Glance',url,'USD',['alt.agri.weather.us.'+(kind==='tavg'?'temperature':'rainfall')+'.anomaly.v1'],async()=>{const rows=parseWeather(await(await sourceFetch(url,'text/csv')).text(),kind,new Date().toISOString(),url);return rows.length?rows:null;}));}
 for(const spec of ethanolSeries){const url=ethanolUrl(spec.id);tasks.push(()=>sourceAttempt(checks,'EIA weekly fuel ethanol',url,'USD',[`alt.agri.ethanol.${spec.name}.`],async()=>{const rows=parseEthanol(await(await sourceFetch(url,'text/html')).text(),spec,new Date().toISOString());return rows.length?rows:null;}));}
 tasks.push(()=>sourceAttempt(checks,'USDA AMS Grain Inspections',exportInspectionUrl,'USD',['alt.agri.exports.'],async()=>{const rows=parseExportInspections(await(await sourceFetch(exportInspectionUrl,'text/plain')).text(),new Date().toISOString());return rows.length?rows:null;}));
 for(const spec of agriculturalPrices){const url='https://fred.stlouisfed.org/series/'+spec.id;if(!apiKey){checks.push({at:now,source:'IMF agricultural prices via FRED',url,currency:'USD',metrics:[`alt.agri.price.${spec.crop}.`],status:'MISSING',cause:'NOT_CONFIGURED',fallback:'NOT YET CONNECTED',latencyMs:0});continue;}
  tasks.push(()=>sourceAttempt(checks,'IMF agricultural prices via FRED',url,'USD',[`alt.agri.price.${spec.crop}.`],async()=>{const params=new URLSearchParams({series_id:spec.id,api_key:apiKey,file_type:'json',sort_order:'desc',limit:'60'}),body=await(await sourceFetch('https://api.stlouisfed.org/fred/series/observations?'+params)).json(),rows=parseAgriculturalPrice(body,spec,new Date().toISOString());return rows.some(r=>r.quality==='VALID')?rows:null;}));
 }
 const result:Observation[]=[];
 // Bound optional Research requests so they do not flood the Core collection.
 for(let i=0;i<tasks.length;i+=3)result.push(...(await Promise.all(tasks.slice(i,i+3).map(read=>read()))).flatMap(r=>r??[]));
 return result;
}
