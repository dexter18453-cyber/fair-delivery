'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const s=require('../order-support');
test('support requires order ownership, validates category, deduplicates and requires human decision',()=>{
 const o={id:'a',customerId:'owner'};
 assert.throws(()=>s.ownOrder([o],'a','other'),{statusCode:404});
 assert.throws(()=>s.ownOrder([{id:'a'}],'a',undefined),{statusCode:404});
 assert.equal(s.ownOrder([o],'a','owner'),o);
 assert.throws(()=>s.createTicket(o,'invalid','now'),{statusCode:400});
 const a=s.createTicket(o,'missing_item','now');o.supportTickets=[a.ticket];
 assert.equal(a.created,true);assert.equal(s.createTicket(o,'missing_item','now').created,false);
 assert.throws(()=>s.resolveTicket(a.ticket,'transfer_cash','later'),{statusCode:400});
 const b=s.resolveTicket(a.ticket,'refund_review','later');
 assert.equal(b.status,'reviewed');assert.equal(b.decision,'refund_review');assert.equal(a.ticket.status,'open');
 assert.throws(()=>s.resolveTicket(b,'reviewed','later'),{statusCode:409});
 assert.equal(o.total,undefined);
});
test('operational history records reason and only calculates observed time intervals',()=>{
 const o={};assert.equal(s.timing(o).readyToPickupMinutes,null);
 s.audit(o,'ready','shop','status_transition','2026-11-26T08:00:00Z');
 s.audit(o,'assigned','system','queue','2026-11-26T08:02:00Z');
 s.audit(o,'picked_up','rider','status_transition','2026-11-26T08:05:00Z');
 assert.deepEqual(s.timing(o),{readyToPickupMinutes:5,assignmentToPickupMinutes:3});
 assert.equal(o.operationalHistory[1].reason,'queue');
});
