'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dispatchReadyOrders } = require('../ready-dispatch');

test('dispatch waits for this shop’s free rider and never assigns two active jobs', () => {
  const rider = (id, attrs) => ({id, name:id, online:true, ...attrs});
  const order = (id, attrs) => ({id, status:'ready', dispatchRequestedAt:id, ...attrs});
  const state = {riders:{a:rider('a',{online:false}), b:rider('b',{active:false}),
    c:rider('c',{storeId:'other'}), d:rider('d',{})}, orders:[
    order('02'), order('01'), order('manual',{dispatchRequestedAt:null}),
    order('other',{storeId:'other'}), order('busy',{status:'picked_up',assignedRider:'d'})]};
  dispatchReadyOrders(state,'default','03');
  assert.equal(state.orders[1].status,'ready');
  state.orders[4].status='delivered';
  dispatchReadyOrders(state,'default','04');
  dispatchReadyOrders(state,'default','05');
  assert.equal(state.orders[1].assignedRider,'d');
  assert.equal(state.orders[0].status,'ready');
  state.riders.a.online=true;
  dispatchReadyOrders(state,'default','06');
  assert.equal(state.orders[0].assignedRider,'a');
  assert.deepEqual(state.orders.slice(2,4).map(o=>o.status),['ready','ready']);
});
