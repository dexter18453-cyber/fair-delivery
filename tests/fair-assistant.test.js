'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {configured,localReport,unsafeText,askGroq,MODEL}=require('../fair-assistant');
test('AI configuration is opt-in and private values never reach external service',async()=>{
 assert.equal(configured({}),false);
 assert.equal(configured({GROQ_API_KEY:'test'}),false);
 const env={GROQ_API_KEY:'synthetic-key',FD_GROQ_FREE_CONFIRMED:'true'};
 let calls=0;
 const fetcher=async(url,request)=>{calls++;assert.equal(url,'https://api.groq.com/openai/v1/chat/completions');const body=JSON.parse(request.body);assert.equal(body.model,MODEL);assert.equal(body.messages.length,2);assert.equal(body.max_completion_tokens,3200);assert.match(body.messages[0].content,/κόστος του καταστήματος/);return {ok:true,json:async()=>({choices:[{message:{content:'Synthetic response'}}]})};};
 assert.equal((await askGroq('Πώς προσεγγίζω καταστήματα;', {env,fetcher})).answer,'Synthetic response');
 assert.equal((await askGroq('candidate@example.test',{env,fetcher})).status,'private');assert.equal(calls,1);
 assert.equal(unsafeText('Τηλέφωνο 6900000000'),true);
 assert.equal((await askGroq('question',{env:{},fetcher})).status,'not_configured');assert.equal(calls,1);
 assert.equal((await askGroq('question',{env,fetcher:async()=>({ok:false,status:429})})).status,'quota');
});
test('local reports use stored records and do not expose contact or bank details',()=>{
 const now=new Date('2026-11-18T12:00:00Z');
 const state={orders:[{id:'a',status:'delivered',billingModel:'shop-fixed-v1',shopFeeCents:100,completedAt:now.toISOString(),createdAt:now.toISOString(),customerPhone:'6900000000'}],stores:{},shopSettlements:[],shopHolds:{},courierApplications:[{kind:'interest',email:'candidate@example.test'}],shopPayout:{iban:'private bank data'}};
 const report=localReport(state,'billing',now);assert.match(report,/1,00/);assert.ok(!report.includes('private bank data'));assert.ok(!report.includes('6900000000'));
 assert.match(localReport(state,'recruitment',now),/μητρώο: 1/);assert.ok(!localReport(state,'recruitment',now).includes('candidate@example.test'));
 assert.equal(localReport(state,'unknown',now),null);
});

test('provider length finish reason is explicitly surfaced',async()=>{const result=await askGroq('Πλάνο',{env:{GROQ_API_KEY:'synthetic',FD_GROQ_FREE_CONFIRMED:'true'},fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'Partial answer'}}]})})});assert.equal(result.truncated,true);});
