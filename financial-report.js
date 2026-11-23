'use strict';
// Projections ONLY: no bank/payment settlement or tax return is implied.
const { athensDay }=require('./shop-billing');
function feeReport(orders,day=athensDay()){
  const delivered=orders.filter(o=>o.status==='delivered' && o.completedAt && athensDay(o.completedAt)===day);
  const result={day,deliveredOrders:delivered.length,
    customerServiceGrossCents:0,merchantCommissionGrossCents:0,
    platformFeeRevenueNetCents:0,estimatedPlatformServiceVatCents:0,
    legacyFeesWithoutVatBreakdownCents:0};
  for(const order of delivered){
    const s=order.pricingSnapshot;
    if(order.billingModel==='shop-percent-v2' && s?.version===4){
      result.customerServiceGrossCents+=s.customerServiceFeeGrossCents;
      result.merchantCommissionGrossCents+=s.commissionGrossCents;
      result.platformFeeRevenueNetCents+=s.platformFeeRevenueNetCents;
      result.estimatedPlatformServiceVatCents+=s.platformFeeVatCents;
    } else if(order.billingModel==='shop-fixed-v1'){
      result.legacyFeesWithoutVatBreakdownCents+=order.shopFeeCents||0;
    }
  }
  result.projectedGrossNewModelFeesCents=result.customerServiceGrossCents+result.merchantCommissionGrossCents;
  result.disclaimer='Προβολή πιλοτικών χρεώσεων, όχι εισπράξεις ή καθαρό κέρδος. Δεν έχουν αφαιρεθεί δαπάνες, μισθοί, εισφορές και φόρος εισοδήματος. Η φορολογική αντιμετώπιση ελέγχεται από λογιστή.';
  return result;
}
module.exports={feeReport};
