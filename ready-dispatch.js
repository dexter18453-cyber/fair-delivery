'use strict';
const {audit}=require('./order-support');

// Match this shop's oldest waiting orders to free riders, least recently assigned first.
function dispatchReadyOrders(state, storeId, timestamp) {
  const inStore = item => (item.storeId || 'default') === storeId;
  const orders = state.orders.filter(inStore);
  const busy = new Set(orders.filter(o => ['assigned', 'picked_up'].includes(o.status)).map(o => o.assignedRider));
  const riders = Object.values(state.riders)
    .filter(r => r.id && inStore(r) && r.active !== false && r.online && !busy.has(r.id))
    .sort((a, b) => (a.lastDispatchAt || '').localeCompare(b.lastDispatchAt || '') || a.id.localeCompare(b.id));
  const waiting = orders.filter(o => o.status === 'ready' && o.dispatchRequestedAt)
    .sort((a, b) => a.dispatchRequestedAt.localeCompare(b.dispatchRequestedAt) || a.id.localeCompare(b.id));
  for (let i = 0; i < Math.min(riders.length, waiting.length); i++) {
    const rider = riders[i];
    Object.assign(waiting[i], { status: 'assigned', assignedRider: rider.id,
      assignedRiderName: rider.name, deliveryManagedByShop: false, updatedAt: timestamp });
    audit(waiting[i],'assigned','system','oldest_waiting_order_least_recently_assigned_available_rider',timestamp);
    rider.lastDispatchAt = timestamp;
  }
}
module.exports = { dispatchReadyOrders };
