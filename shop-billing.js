'use strict';
const crypto = require('crypto');
const { SERVICE_FEE_CENTS, COMMISSION_BPS } = require('./billing-pricing');
const FEE_CENTS = 100; // Historical flat-fee order snapshots; NEVER reprice them.
function athensDay(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Athens', year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date(value));
  const obj = Object.fromEntries(parts.map(p => [p.type,p.value]));
  return obj.year + '-' + obj.month + '-' + obj.day;
}
function amountForCompletedOrder(order, storeId) {
  if (!order || order.status !== 'delivered' || (order.storeId || 'default') !== storeId ||
      typeof order.completedAt !== 'string' || !Number.isFinite(Date.parse(order.completedAt))) return null;
  // v1 was one euro per delivered order. Preserve every old agreement and settlement.
  if (order.billingModel === 'shop-fixed-v1' && order.shopFeeCents === FEE_CENTS) return FEE_CENTS;
  // v2: immutable commission snapshot (8% plus separately calculated service VAT).
  if (order.billingModel === 'shop-percent-v2' && order.pricingSnapshot?.version === 4 &&
      Number.isSafeInteger(order.shopFeeCents) && order.shopFeeCents >= 0 &&
      order.shopFeeCents === order.pricingSnapshot.commissionGrossCents &&
      order.pricingSnapshot.commissionRateBasisPoints === COMMISSION_BPS) return order.shopFeeCents;
  return null;
}
function settlementSummary(orders, settlements, storeId = 'default', today = athensDay()) {
  const rows = new Map();
  const history = settlements.filter(s => s.storeId === storeId);
  const settled = new Set(history.flatMap(s => s.orderIds));
  for (const order of orders) {
    const fee = amountForCompletedOrder(order, storeId);
    if (fee === null) continue;
    const day = athensDay(order.completedAt);
    if (!rows.has(day)) rows.set(day,{ day, completed:0, feeCents:0, settledCents:0, outstandingCents:0 });
    const row = rows.get(day);
    row.completed++;
    row.feeCents += fee;
    if (settled.has(order.id)) row.settledCents += fee;
    else row.outstandingCents += fee;
  }
  const days = [...rows.values()].sort((a,b) => b.day.localeCompare(a.day));
  return {
    pilot: true, billingModel:'mixed-snapshot-v4', feePerOrderCents:null,
    customerServiceFeeCents:SERVICE_FEE_CENTS, shopCommissionPercent:COMMISSION_BPS/100,
    today, days,
    outstandingCents:days.reduce((sum,row) => sum+row.outstandingCents,0),
    history:history.slice().sort((a,b) => b.recordedAt.localeCompare(a.recordedAt))
  };
}
function recordSettlement(orders, settlements, storeId, day, expectedCents, now = new Date()) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day > athensDay(now)) {
    throw Object.assign(new Error('Μη έγκυρη ημέρα εκκαθάρισης.'), { statusCode:400 });
  }
  const paid = new Set(settlements.filter(s => s.storeId === storeId).flatMap(s => s.orderIds));
  const pending = orders.filter(o => {
    const amount = amountForCompletedOrder(o,storeId);
    return amount !== null && athensDay(o.completedAt) === day && !paid.has(o.id);
  });
  const amountCents = pending.reduce((sum,o) => sum + amountForCompletedOrder(o,storeId),0);
  if (!amountCents || expectedCents !== amountCents) {
    throw Object.assign(new Error('Η οφειλή άλλαξε ή δεν υπάρχει. Ανανέωσε πριν την εκκαθάριση.'), { statusCode:409 });
  }
  return { id:crypto.randomUUID(), storeId, day, amountCents, orderIds:pending.map(o=>o.id),
    recordedAt:now.toISOString(), mode:'pilot_manual' };
}
module.exports = { FEE_CENTS, athensDay, amountForCompletedOrder, settlementSummary, recordSettlement };
