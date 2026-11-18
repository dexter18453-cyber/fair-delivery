'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {targetConnection,destinationState,copyIntoNewDatabase}=require('../migration-target');
const {validateSnapshot}=require('../migration-tools');
const sample=()=>({settings:{shopDeliveryFee:0,pricingVersion:3},products:[{id:'item-1',price:3}],orders:[{id:'order-1',storeId:'default'}],riders:{},stores:{},customers:{},courierApplications:[],shopSettlements:[]});
test('migration rejects source and insecure database URLs',()=>{
 const good='postgresql://test:synthetic@ep-test.aws-eu-central-1.aws.neon.tech/fair_delivery?sslmode=require';
 assert.equal(targetConnection(good),good);
 assert.throws(()=>targetConnection('postgresql://test:secret@dpg-example.render.com/fair_delivery?sslmode=require'));
 assert.throws(()=>targetConnection('postgresql://test:secret@ep-test.aws.neon.tech/other?sslmode=require'));
 assert.throws(()=>targetConnection('postgresql://test:secret@ep-test.aws.neon.tech/fair_delivery?sslmode=disable'));
 assert.throws(()=>targetConnection('postgresql://test@ep-test.aws.neon.tech/fair_delivery?sslmode=require'));
});
test('migration preflight detects missing, empty and populated destination',async()=>{
 const bare={query:async()=>({rows:[{exists:false}]})};
 assert.deepEqual(await destinationState(bare),{tableExists:false,recordCount:0});
 const empty={query:async(q)=>({rows:q.includes('to_regclass')?[{exists:true}]:[{count:0}]})};
 assert.deepEqual(await destinationState(empty),{tableExists:true,recordCount:0});
 const active={query:async(q)=>({rows:q.includes('to_regclass')?[{exists:true}]:[{count:1}]})};
 assert.deepEqual(await destinationState(active),{tableExists:true,recordCount:1});
 await assert.rejects(copyIntoNewDatabase(active,sample()),/περιέχει ήδη/);
});
test('copy verifies digest and does not mutate the source state',async()=>{
 const src=sample();const before=JSON.stringify(src);let row=null;
 const fake={async connect(){return {release(){},async query(q,params=[]){
  if(q==='BEGIN'||q==='COMMIT'||q==='ROLLBACK')return {rows:[]};
  if(q.startsWith('CREATE TABLE'))return {rows:[]};
  if(q.startsWith('SELECT id FROM'))return {rows:row?[{id:1}]:[]};
  if(q.startsWith('INSERT INTO')){row=JSON.parse(params[0]);return {rowCount:1,rows:[{id:1}]};}
  if(q.startsWith('SELECT body FROM'))return {rows:[{body:JSON.parse(JSON.stringify(row))}]};
  throw Error('Unexpected '+q);
 }};},async query(q){if(q.includes('to_regclass'))return {rows:[{exists:true}]};if(q.includes('count(*)'))return {rows:[{count:row?1:0}]};if(q.includes('SELECT body FROM'))return {rows:[{body:JSON.parse(JSON.stringify(row))}]};throw Error('Unexpected SQL');}};
 const result=await copyIntoNewDatabase(fake,src);
 assert.equal(result.digest,validateSnapshot(src).digest);assert.equal(JSON.stringify(src),before);
 await assert.rejects(copyIntoNewDatabase(fake,src),/περιέχει ήδη/);
});
