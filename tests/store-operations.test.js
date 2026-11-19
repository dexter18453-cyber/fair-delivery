'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {defaults,validated,inHours,checkCheckout,status,distanceKm}=require('../store-operations');
const moment=s=>new Date(s);
test('Athens schedules including overnight and disabled days',()=>{
 const ops=defaults();ops.scheduleEnabled=true;
 for(const row of Object.values(ops.hours))row.enabled=false;
 ops.hours.mon={enabled:true,open:'18:00',close:'02:00'};
 assert.equal(inHours(ops,moment('2026-11-16T15:59:00Z')),false);
 assert.equal(inHours(ops,moment('2026-11-16T16:00:00Z')),true);
 assert.equal(inHours(ops,moment('2026-11-16T23:59:00Z')),true);
 assert.equal(inHours(ops,moment('2026-11-17T00:00:00Z')),false);
 assert.equal(inHours(ops,moment('2026-11-17T16:00:00Z')),false);
 assert.equal(inHours(ops,moment('2026-07-06T15:00:00Z')),true);
});
test('reject invalid opening times, ETA and radius',()=>{
 const ops=defaults();assert.equal(validated(ops).minOrder,0);
 assert.throws(()=>validated({...ops,radiusKm:21}),{statusCode:400});
 assert.throws(()=>validated({...ops,etaMin:90,etaMax:20}),{statusCode:400});
 assert.throws(()=>validated({...ops,hours:{...ops.hours,mon:{enabled:true,open:'09:00',close:'09:00'}}}),{statusCode:400});
});
test('server checks minimum, coverage, suspension and manual pause',()=>{
 const state={shopHolds:{}};const store={id:'test',active:true,settings:{operations:{...defaults(),radiusKm:2,minOrder:5},storeLocation:{lat:37.9,lng:23.7}}};
 assert.equal(distanceKm(store.settings.storeLocation,store.settings.storeLocation),0);
 assert.equal(checkCheckout(state,store,{lat:37.91,lng:23.7},5).etaMin,25);
 assert.throws(()=>checkCheckout(state,store,{lat:38.1,lng:23.7},5),{statusCode:409});
 assert.throws(()=>checkCheckout(state,store,{lat:37.9,lng:23.7},4.99),{statusCode:409});
 store.settings.operations.paused=true;assert.equal(status(state,store).reason,'paused');
 assert.throws(()=>checkCheckout(state,store,{lat:37.9,lng:23.7},10),{statusCode:409});
 state.shopHolds.test={suspended:true};store.settings.operations.paused=false;
 assert.equal(status(state,store).reason,'suspended');
});
