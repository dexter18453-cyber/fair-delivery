'use strict';
// Fair Delivery price policy v4 — PILOT ONLY, not an invoice or tax return.
// Service fee: 2.30 EUR GROSS, includes assumed 24% VAT on the platform service.
// Shop commission: 8% of displayed product subtotal (inclusive of PRODUCT VAT),
// PLUS assumed 24% VAT on the platform's commission service. This must be
// explicitly agreed with each merchant and confirmed by a Greek accountant.
const SERVICE_FEE_CENTS = 230;
const COMMISSION_BPS = 800;
const SERVICE_VAT_BPS = 2400;
function validateCents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100000000) {
    throw new TypeError((label || 'amount') + ' must be integer cents between 0 and 100000000');
  }
  return value;
}
function inclusiveVat(gross) {
  validateCents(gross, 'gross');
  const net = Math.round(gross * 10000 / (10000 + SERVICE_VAT_BPS));
  return { grossCents: gross, netCents: net, vatCents: gross - net };
}
function priceOrder(subtotalCents, deliveryFeeCents = 0) {
  validateCents(subtotalCents, 'subtotalCents');
  validateCents(deliveryFeeCents, 'deliveryFeeCents');
  const customerService = inclusiveVat(SERVICE_FEE_CENTS);
  const commissionNetCents = Math.round(subtotalCents * COMMISSION_BPS / 10000);
  const commissionVatCents = Math.round(commissionNetCents * SERVICE_VAT_BPS / 10000);
  const commissionGrossCents = commissionNetCents + commissionVatCents;
  const customerTotalCents = subtotalCents + deliveryFeeCents + SERVICE_FEE_CENTS;
  validateCents(customerTotalCents, 'customerTotalCents');
  return Object.freeze({
    version: 4,
    currency: 'EUR',
    subtotalCents, deliveryFeeCents, customerTotalCents,
    customerServiceFeeGrossCents: SERVICE_FEE_CENTS,
    customerServiceFeeNetCents: customerService.netCents,
    customerServiceFeeVatCents: customerService.vatCents,
    commissionRateBasisPoints: COMMISSION_BPS,
    commissionNetCents, commissionVatCents, commissionGrossCents,
    platformFeeRevenueNetCents: customerService.netCents + commissionNetCents,
    platformFeeVatCents: customerService.vatCents + commissionVatCents,
    disclaimer: 'Estimated platform service VAT only; tax classification and invoicing require accountant approval. Not net profit.'
  });
}
module.exports = { SERVICE_FEE_CENTS, COMMISSION_BPS, SERVICE_VAT_BPS, validateCents, inclusiveVat, priceOrder };
