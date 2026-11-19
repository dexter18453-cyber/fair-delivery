'use strict';
const DAYS=['mon','tue','wed','thu','fri','sat','sun'];
const defaults=()=>({paused:false,scheduleEnabled:false,hours:Object.fromEntries(DAYS.map(d=>[d,{open:'09:00',close:'23:00',enabled:true}])),radiusKm:null,minOrder:0,etaMin:25,etaMax:50});
function fail(message,statusCode=400){throw Object.assign(new Error(message),{statusCode});}
function mins(t){if(typeof t!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(t))fail('Χρησιμοποίησε ώρα HH:MM.');return Number(t.slice(0,2))*60+Number(t.slice(3));}
function validated(input){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Μη έγκυρες ρυθμίσεις.');
 const {paused,scheduleEnabled,hours,radiusKm,minOrder,etaMin,etaMax}=input;
 if(typeof paused!=='boolean'||typeof scheduleEnabled!=='boolean'||!hours||typeof hours!=='object')fail('Συμπλήρωσε το ωράριο και την κατάσταση.');
 const cleaned={};
 for(const day of DAYS){const row=hours[day];if(!row||typeof row.enabled!=='boolean')fail('Λείπει ημέρα ωραρίου.');const start=mins(row.open),end=mins(row.close);if(row.enabled&&start===end)fail('Το άνοιγμα και το κλείσιμο πρέπει να διαφέρουν.');cleaned[day]={enabled:row.enabled,open:row.open,close:row.close};}
 if(radiusKm!==null&&(typeof radiusKm!=='number'||!Number.isFinite(radiusKm)||radiusKm<0.2||radiusKm>20))fail('Ακτίνα: 0,2–20 χλμ. ή χωρίς περιορισμό.');
 if(typeof minOrder!=='number'||!Number.isFinite(minOrder)||minOrder<0||minOrder>200)fail('Ελάχιστη παραγγελία: 0–200€.');
 if(!Number.isInteger(etaMin)||!Number.isInteger(etaMax)||etaMin<5||etaMax>180||etaMin>etaMax)fail('Χρόνος παράδοσης: 5–180 λεπτά. Το ελάχιστο δεν μπορεί να υπερβαίνει το μέγιστο.');
 return {paused,scheduleEnabled,hours:cleaned,radiusKm,minOrder:Math.round(minOrder*100)/100,etaMin,etaMax};
}
function settings(store){return store?.settings?.operations||defaults();}
function clock(now){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Athens',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);const obj=Object.fromEntries(parts.map(p=>[p.type,p.value]));return {day:obj.weekday.toLowerCase(),minute:Number(obj.hour)*60+Number(obj.minute)};}
function inHours(ops,now=new Date()){
 if(!ops.scheduleEnabled)return true;
 const {day,minute}=clock(now),idx=DAYS.indexOf(day);
 const row=ops.hours[day],prev=ops.hours[DAYS[(idx+6)%7]];
 if(row?.enabled){const a=mins(row.open),b=mins(row.close);if(a<b&&minute>=a&&minute<b)return true;if(a>b&&minute>=a)return true;}
 if(prev?.enabled){const a=mins(prev.open),b=mins(prev.close);if(a>b&&minute<b)return true;}
 return false;
}
function status(state,store,now=new Date()){
 const ops=settings(store);let reason=null;
 if(!store?.active)reason='draft';
 else if(state.shopHolds?.[store.id]?.suspended)reason='suspended';
 else if(ops.paused)reason='paused';
 else if(!inHours(ops,now))reason='outside_hours';
 return {acceptingOrders:reason===null,reason,etaMin:ops.etaMin,etaMax:ops.etaMax,minOrder:ops.minOrder,radiusKm:ops.radiusKm};
}
function distanceKm(a,b){const rad=x=>x*Math.PI/180;const dlat=rad(b.lat-a.lat),dlon=rad(b.lng-a.lng);const h=Math.sin(dlat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dlon/2)**2;return 6371*2*Math.asin(Math.min(1,Math.sqrt(h)));}
function checkCheckout(state,store,location,subtotal,now=new Date()){
 const availability=status(state,store,now);const ops=settings(store);
 if(!availability.acceptingOrders)fail('Το κατάστημα δεν δέχεται προσωρινά νέες παραγγελίες.',409);
 if(Math.round(subtotal*100)<Math.round(ops.minOrder*100))fail('Η ελάχιστη παραγγελία προϊόντων είναι '+ops.minOrder.toFixed(2)+'€.',409);
 let distance=null;
 if(ops.radiusKm!==null){const point=store.settings.storeLocation;if(!point)fail('Δεν έχει οριστεί σημείο καταστήματος.',409);distance=distanceKm(point,location);if(distance>ops.radiusKm)fail('Η διεύθυνση βρίσκεται εκτός της ακτίνας διανομής του καταστήματος.',409);}
 return {etaMin:ops.etaMin,etaMax:ops.etaMax,deliveryDistanceKm:distance===null?null:Math.round(distance*100)/100};
}
module.exports={DAYS,defaults,validated,settings,inHours,status,distanceKm,checkCheckout};
