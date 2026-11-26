'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateApplication,evaluateApplication,pruneApplications}=require('../courier-onboarding');

const example={fullName:'Test Freelancer',email:'demo@example.invalid',phone:'6900000012',region:'Νίκαια',
  vehicle:'motorcycle',licenseCategory:'A',licenseValid:true,insuranceUntil:'2099-12-31',
  businessActive:true,canInvoice:true,equipmentReady:true,independentChoice:true,privacyAcknowledged:true};

test('complete declarations go to human review, never automatic approval',()=>{
  const app=validateApplication(example);
  const review=evaluateApplication(app,new Date('2026-11-17T12:00:00Z'));
  assert.equal(review.status,'ready-for-review');
  assert.equal(review.requiresHumanVerification,true);
  assert.equal(review.issues.length,0);
});
test('missing licences, expired insurance, and business readiness are marked without rejecting a person',()=>{
  const app=validateApplication({...example,licenseCategory:'B',licenseValid:false,insuranceUntil:'2020-01-01',businessActive:false,canInvoice:false});
  const review=evaluateApplication(app,new Date('2026-11-17T12:00:00Z'));
  assert.equal(review.status,'needs-information');
  assert.ok(review.issues.length>=4);
  assert.equal(review.requiresHumanVerification,true);
});
test('bicycle does not automatically require a driving licence or motor insurance',()=>{
  const app=validateApplication({...example,vehicle:'bicycle',licenseCategory:'none',licenseValid:false,insuranceUntil:null});
  const review=evaluateApplication(app,new Date('2026-11-17T12:00:00Z'));
  assert.equal(review.status,'ready-for-review');
});
test('invalid contacts, hidden identifiers and absent information acknowledgement are rejected',()=>{
  assert.throws(()=>validateApplication({...example,email:'bad'}));
  assert.throws(()=>validateApplication({...example,privacyAcknowledged:false}));
  assert.throws(()=>validateApplication({...example,website:'spam'}));
  assert.throws(()=>validateApplication({...example,insuranceUntil:'2026-02-30'}));
});
test('application retention purges data after 90 days',()=>{
  const list=[{createdAt:'2026-01-01T00:00:00Z'},{createdAt:'2026-11-01T00:00:00Z'}];
  assert.equal(pruneApplications(list,new Date('2026-11-17T00:00:00Z').getTime()).length,1);
});
