'use strict';
// Pilot configuration. Service fee is 2.30 EUR including assumed 24% service VAT.
// Merchant commission is 8% of VAT-inclusive item subtotal, EXCLUDING VAT on
// the commission service; 24% assumed on top. Accountant approval required.
const SERVICE_FEE_GROSS_CENTS = 230;
const COMMISSION_BPS = 800;
const SERVICE_VAT_BPS = 2400;
function cents(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100000000) throw new TypeError(name + ' must be valid euro cents');
  return value;
}
function vatIncluded(grossCents, basisPoints = SERVICE_VAT_BPS) {
  cents(grossCents, 'grossCents');
  const netCents = Math.round(grossCents * 10000 / (10000 + basisPoints));
  return { netCents, vatCents: grossCents - netCents, grossCents };
}
function quote({ items, deliveryFeeCents = 0, serviceFeeCents = SERVICE_FEE_GROSS_CENTS }) {
  if (!Array.isArray(items) || !items.length || items.length > 30) throw new TypeError('invalid items');
  const lines = items.map(item => {
    const unitPriceCents = cents(item.unitPriceCents, 'unitPriceCents');
    const quantity = item.quantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 20) throw new TypeError('invalid quantity');
    return { productId: item.productId, name: item.name, quantity, unitPriceCents, lineCents: cents(unitPriceCents * quantity, 'lineCents') };
  });
  const subtotalCents = cents(lines.reduce((sum, line) => sum + line.lineCents, 0), 'subtotalCents');
  const deliveryCents = cents(deliveryFeeCents, 'deliveryFeeCents');
  const service = vatIncluded(cents(serviceFeeCents, 'serviceFeeCents'));
  const commissionNetCents = Math.round(subtotalCents * COMMISSION_BPS / 10000);
  const commissionVatCents = Math.round(commissionNetCents * SERVICE_VAT_BPS / 10000);
  const merchantCommissionCents = cents(commissionNetCents + commissionVatCents, 'merchantCommissionCents');
  const customerTotalCents = cents(subtotalCents + deliveryCents + service.grossCents, 'customerTotalCents');
  return {
    lines, currency: 'EUR', subtotalCents, deliveryFeeCents: deliveryCents,
    serviceFeeGrossCents: service.grossCents, serviceFeeNetCents: service.netCents,
    serviceFeeVatCents: service.vatCents, customerTotalCents,
    commissionBasisPoints: COMMISSION_BPS, commissionNetCents, commissionVatCents,
    merchantCommissionGrossCents: merchantCommissionCents,
    platformRevenueNetCents: service.netCents + commissionNetCents,
    platformCollectedVatCents: service.vatCents + commissionVatCents,
    // This is NOT profit: payment costs, expenses, tax, refunds and wage costs excluded.
    profitIsNotCalculated: true
  };
}
module.exports = { quote, vatIncluded, cents, SERVICE_FEE_GROSS_CENTS, COMMISSION_BPS };
