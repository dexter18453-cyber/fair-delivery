'use strict';
// Pilot pricing foundation. This module does NOT process payments or determine tax liability.
// All amounts are integer euro cents; tax treatment must be approved by an accountant.
function assertCents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(name + ' must be non-negative integer cents');
  return value;
}
function quote({items, deliveryFeeCents = 0, serviceFeeCents = 149, discountCents = 0}) {
  if (!Array.isArray(items) || !items.length) throw new TypeError('items required');
  const subtotalCents = items.reduce((sum, item) => {
    const unit = assertCents(item.unitPriceCents, 'unitPriceCents');
    const qty = item.quantity;
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > 100) throw new TypeError('invalid quantity');
    const next = sum + unit * qty;
    if (!Number.isSafeInteger(next)) throw new RangeError('subtotal overflow');
    return next;
  }, 0);
  const delivery = assertCents(deliveryFeeCents, 'deliveryFeeCents');
  const service = assertCents(serviceFeeCents, 'serviceFeeCents');
  const discount = assertCents(discountCents, 'discountCents');
  if (discount > subtotalCents + delivery + service) throw new RangeError('discount exceeds total');
  const totalCents = subtotalCents + delivery + service - discount;
  if (!Number.isSafeInteger(totalCents)) throw new RangeError('total overflow');
  return Object.freeze({subtotalCents, deliveryFeeCents:delivery, serviceFeeCents:service, discountCents:discount, totalCents, currency:'EUR'});
}
module.exports = {quote};

/**
 * Commercial pilot: 8% merchant commission, computed on the supplied
 * eligible base in cents. The caller must determine the legally correct
 * base (including VAT treatment) with its accountant.
 * This is a quote only; it does not issue invoices or settle payments.
 */
function merchantCommission({eligibleBaseCents, rateBasisPoints = 800}) {
  assertCents(eligibleBaseCents, 'eligibleBaseCents');
  if (!Number.isSafeInteger(rateBasisPoints) || rateBasisPoints < 0 || rateBasisPoints > 10000) {
    throw new TypeError('invalid commission rate');
  }
  const commissionCents = Math.round(eligibleBaseCents * rateBasisPoints / 10000);
  if (!Number.isSafeInteger(commissionCents)) throw new RangeError('commission overflow');
  return Object.freeze({eligibleBaseCents, rateBasisPoints, commissionCents, currency:'EUR'});
}
module.exports.merchantCommission = merchantCommission;
