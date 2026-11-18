'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const {config,validateInterest,screening}=require('../courier-interest');
test('real interest intake requires public privacy settings',()=>{
 assert.equal(config({}).open,false);
 assert.equal(config({COURIER_INTEREST_OPEN:'true'}).open,false);
 const env={COURIER_INTEREST_OPEN:'true',COURIER_INTEREST_CONTROLLER:'Test business',COURIER_INTEREST_CONTACT:'privacy@example.test',COURIER_INTEREST_NOTICE:'Synthetic privacy test. '.repeat(12)};
 const cfg=config(env);assert.equal(cfg.open,true);
 const input={email:'candidate@example.test',region:'Test region',noticeVersion:cfg.version,consent:true};
 const item=validateInterest(input,cfg);
 assert.equal(item.kind,'interest');assert.equal(item.consentVersion,cfg.version);
 assert.equal(item.email,input.email);assert.equal(item.phone,undefined);
 assert.equal(screening(item,()=>{throw Error('Must not evaluate eligibility');}).status,'interest');
 assert.throws(()=>validateInterest({...input,consent:false},cfg));
 assert.throws(()=>validateInterest({...input,noticeVersion:'old'},cfg));
 assert.throws(()=>validateInterest({...input,licenseCategory:'A'},cfg));
});
test('candidate and admin browser scripts parse and form defaults closed',()=>{
 for(const file of ['admin.js','courier-interest.js'])new vm.Script(fs.readFileSync(path.join(__dirname,'../public',file),'utf8'));
 const html=fs.readFileSync(path.join(__dirname,'../public/courier-apply.html'),'utf8');
 assert.match(html,/id="interestForm" hidden/);
 assert.match(html,/id="interestFields" disabled/);
});
