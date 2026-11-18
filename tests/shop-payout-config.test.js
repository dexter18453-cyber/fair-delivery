'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {initialPayout,visiblePayout,paymentDetails}=require('../shop-controls');
test('bootstrap bank details without exposing pending IRIS to stores',()=>{
 const config={FD_PAYOUT_IBAN:'GR1601101250000000012300695',FD_PAYOUT_BENEFICIARY:'Synthetic test account',FD_PAYOUT_PENDING_IRIS:'6900000000'};
 const payout=initialPayout(null,config);
 assert.equal(payout.iban,config.FD_PAYOUT_IBAN);
 assert.equal(visiblePayout(payout,'admin').pendingIrisPhone,'6900000000');
 assert.equal(visiblePayout(payout,'shop').irisPhone,'');
 assert.equal(visiblePayout(payout,'shop').pendingIrisPhone,undefined);
 assert.equal(initialPayout(null,{}),null);
 assert.equal(initialPayout({iban:'existing'},config).iban,'existing');
 assert.throws(()=>paymentDetails({iban:config.FD_PAYOUT_IBAN,beneficiary:'Synthetic test account',irisPhone:'6900000000'}),{statusCode:400});
 const verified=paymentDetails({iban:config.FD_PAYOUT_IBAN,beneficiary:'Synthetic test account',irisPhone:'6900000000',irisBusinessConfirmed:true});
 assert.equal(visiblePayout(verified,'shop').irisPhone,'6900000000');
});
