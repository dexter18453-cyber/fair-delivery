'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {validateSnapshot,installSnapshot}=require('../migration-tools');
function fixture(){return {settings:{pricingVersion:3,shopDeliveryFee:0},products:[{id:'sample-product',name:'Synthetic',price:4}],orders:[{id:'sample-order',status:'delivered',items:[],storeId:'default'}],riders:{},stores:{},customers:{},courierApplications:[],shopSettlements:[]};}
function mockDb(hasRecord=false){
 let committed=hasRecord?fixture():null,pending=null,queries=[],rolledBack=false;
 return {get data(){return committed;},get queries(){return queries;},get rolledBack(){return rolledBack;},
 async connect(){return {release(){},async query(sql,params=[]){
 queries.push(sql);
 if(sql==='BEGIN'){pending=committed;return {rows:[],rowCount:0};}
 if(sql.includes('CREATE TABLE'))return {rows:[],rowCount:0};
 if(sql.startsWith('SELECT id FROM'))return {rows:pending?[{id:1}]:[],rowCount:pending?1:0};
 if(sql.startsWith('INSERT INTO')){if(pending)return {rows:[],rowCount:0};pending=JSON.parse(params[0]);return {rows:[{id:1}],rowCount:1};}
 if(sql.startsWith('SELECT body FROM')){if(!pending)return {rows:[],rowCount:0};const rec=JSON.parse(JSON.stringify(pending));return {rows:[{body:{...rec,customers:rec.customers,settings:{shopDeliveryFee:0,pricingVersion:3}}}],rowCount:1};}
 if(sql==='COMMIT'){committed=pending;return {rows:[],rowCount:0};}
 if(sql==='ROLLBACK'){rolledBack=true;pending=committed;return {rows:[],rowCount:0};}
 throw Error('Unexpected '+sql);
 }};}
 };
}
test('migration snapshot validator rejects duplicates and reports only counts and canonical digest',()=>{
 const source=fixture();const v=validateSnapshot(source);assert.equal(v.counts.orders,1);assert.equal(v.counts.stores,0);
 assert.equal(v.digest,validateSnapshot({...source,customers:{},settings:{shopDeliveryFee:0,pricingVersion:3}}).digest);
 assert.throws(()=>validateSnapshot({...source,orders:[source.orders[0],source.orders[0]]}),/Διπλά/);
 assert.throws(()=>validateSnapshot({...source,stores:null}),/Λείπουν/);
});
test('empty destination can import once, never replace a populated record',async()=>{
 const db=mockDb();const source=fixture();
 const result=await installSnapshot(db,source);
 assert.equal(result.counts.orders,1);assert.ok(db.data);
 await assert.rejects(installSnapshot(db,source),/περιέχει ήδη/);
 assert.equal(db.rolledBack,true);assert.equal(db.data.orders.length,1);
});
test('corrupt verification rolls back and never commits partial data',async()=>{
 const db={get committed(){return committed;},async connect(){let staged=null;return {release(){},async query(sql,params=[]){if(sql==='BEGIN')return {rows:[]};if(sql.includes('CREATE TABLE'))return {rows:[]};if(sql.startsWith('SELECT id'))return {rows:[]};if(sql.startsWith('INSERT INTO')){staged=JSON.parse(params[0]);return {rows:[{id:1}],rowCount:1};}if(sql.startsWith('SELECT body'))return {rows:[{body:{...staged,products:[]}}]};if(sql==='ROLLBACK')return {rows:[]};if(sql==='COMMIT')throw Error('Should not commit');throw Error('bad query');}};}};
 let committed=null;
 await assert.rejects(installSnapshot(db,fixture()),/ακεραιότητας/);assert.equal(committed,null);
});
