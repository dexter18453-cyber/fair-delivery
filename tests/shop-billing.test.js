'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {athensDay,settlementSummary,recordSettlement}=require('../shop-billing');
const now=new Date('2026-11-18T12:00:00Z');
const completed=(id,overrides={})=>({id,status:'delivered',billingModel:'shop-fixed-v1',shopFeeCents:100,completedAt:'2026-11-17T23:30:00Z',storeId:'default',...overrides});
test('fixed fee applies only to completed new-model orders and uses Athens completion date',()=>{
 assert.equal(athensDay('2026-11-17T23:30:00Z'),'2026-11-18');
 const orders=[completed('a'),completed('old',{billingModel:undefined,shopFeeCents:undefined}),completed('cancel',{status:'cancelled'}),completed('pending',{status:'new'}),completed('other',{storeId:'other'})];
 const summary=settlementSummary(orders,[],'default',athensDay(now));
 assert.equal(summary.outstandingCents,100);assert.equal(summary.days[0].day,'2026-11-18');assert.equal(summary.days[0].completed,1);
});
test('daily recorded settlement never double counts and later deliveries remain outstanding',()=>{
 const orders=[completed('a'),completed('b')];
 assert.throws(()=>recordSettlement(orders,[],'default','2026-11-18',100,now),{statusCode:409});
 const record=recordSettlement(orders,[],'default','2026-11-18',200,now);
 assert.equal(record.amountCents,200);
 assert.equal(settlementSummary(orders,[record],'default').outstandingCents,0);
 assert.throws(()=>recordSettlement(orders,[record],'default','2026-11-18',200,now),{statusCode:409});
 orders.push(completed('c'));
 assert.equal(settlementSummary(orders,[record],'default').outstandingCents,100);
 assert.equal(recordSettlement(orders,[record],'default','2026-11-18',100,now).amountCents,100);
});
