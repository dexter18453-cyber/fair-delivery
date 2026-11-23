'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {priceOrder}=require('../billing-pricing');
const {feeReport}=require('../financial-report');
test('daily financial projection separates platform revenue, service VAT and historical amounts',()=>{
  const date='2026-11-23T10:00:00Z';
  const pricingSnapshot=priceOrder(2000,0);
  const orders=[
    {id:'new',status:'delivered',billingModel:'shop-percent-v2',completedAt:date,
      shopFeeCents:pricingSnapshot.commissionGrossCents,pricingSnapshot},
    {id:'historic',status:'delivered',billingModel:'shop-fixed-v1',completedAt:date,shopFeeCents:100},
    {id:'not-done',status:'cancelled',billingModel:'shop-percent-v2',completedAt:date,pricingSnapshot},
    {id:'yesterday',status:'delivered',billingModel:'shop-percent-v2',completedAt:'2026-11-21T10:00:00Z',pricingSnapshot}
  ];
  const result=feeReport(orders,'2026-11-23');
  assert.equal(result.deliveredOrders,2);
  assert.equal(result.customerServiceGrossCents,230);
  assert.equal(result.merchantCommissionGrossCents,198);
  assert.equal(result.platformFeeRevenueNetCents,345);
  assert.equal(result.estimatedPlatformServiceVatCents,83);
  assert.equal(result.legacyFeesWithoutVatBreakdownCents,100);
  assert.match(result.disclaimer,/όχι εισπράξεις ή καθαρό κέρδος/);
});
test('price quote uses exact cents and rejects negative or unsafe pricing inputs',()=>{
  assert.equal(priceOrder(2000,130).customerTotalCents,2360);
  assert.throws(()=>priceOrder(-1));
  assert.throws(()=>priceOrder(Infinity));
});
