'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateSnapshot,installSnapshot}=require('../migration-tools');
const {encryptBackup,decryptBackup}=require('../encrypted-backup');
function sample(){return {orders:[{id:'synthetic-order-1',storeId:'default',status:'new'}],products:[{id:'synthetic-item-1',price:2}],settings:{currency:'EUR',shopOrderFee:1},riders:{},stores:{},customers:{'synthetic-id':{alias:'demo-testaccount',passwordHash:'private-hash'}},courierApplications:[],shopSettlements:[],shopHolds:{}};}
function fakeDb(existing){
 let stored=existing?structuredClone(existing):null,transaction=null;const actions=[];
 return {actions,get stored(){return stored;},async connect(){return {
  async query(sql,params=[]){
   const operation=sql.trim().split(/\s+/).slice(0,3).join(' ').toUpperCase();actions.push(operation);
   if(sql==='BEGIN'){transaction=structuredClone(stored);return {rows:[]};}
   if(sql==='COMMIT'){transaction=null;return {rows:[]};}
   if(sql==='ROLLBACK'){stored=transaction;return {rows:[]};}
   if(sql.startsWith('CREATE TABLE'))return {rows:[]};
   if(sql.startsWith('SELECT id FROM'))return {rows:stored?[{id:1}]:[]};
   if(sql.startsWith('INSERT INTO')){if(stored)return {rowCount:0,rows:[]};stored=JSON.parse(params[0]);return {rowCount:1,rows:[{id:1}]};}
   if(sql.startsWith('SELECT body FROM'))return {rows:stored?[{body:JSON.parse(JSON.stringify(stored))}]:[]};
   throw Error('unexpected SQL: '+sql);
  },release(){actions.push('RELEASE');}
 };}};
}
test('encrypted snapshot migration validates checksum and counts without plaintext leaks',async()=>{
 const state=sample(),secret='synthetic passphrase at least twenty characters';
 const e=await encryptBackup(state,secret);
 assert.ok(!JSON.stringify(e).includes('private-hash'));
 const snapshot=await decryptBackup(e,secret);
 const result=validateSnapshot(snapshot);
 assert.equal(result.counts.orders,1);assert.equal(result.counts.customers,1);
 assert.match(result.digest,/^[a-f0-9]{64}$/);
 const flipped=Object.fromEntries(Object.entries(snapshot).reverse());
 assert.equal(validateSnapshot(flipped).digest,result.digest,'JSONB key reordering must not alter hash');
 const target=fakeDb();
 const imported=await installSnapshot(target,snapshot);
 assert.equal(imported.digest,result.digest);
 assert.ok(target.actions.includes('COMMIT'));
 await assert.rejects(installSnapshot(target,snapshot),/ήδη μητρώο/);
 assert.ok(target.actions.includes('ROLLBACK'));
});
test('import refuses invalid input and does not alter a populated target',async()=>{
 const state=sample();state.orders.push({...state.orders[0]});
 assert.throws(()=>validateSnapshot(state),/Διπλά/);
 const target=fakeDb(sample());const existing=JSON.stringify(target.stored);
 await assert.rejects(installSnapshot(target,sample()),/ήδη μητρώο/);
 assert.equal(JSON.stringify(target.stored),existing);
 assert.equal(target.actions.includes('INSERT INTO'),false);
 const wrong=sample();delete wrong.stores;
 assert.throws(()=>validateSnapshot(wrong),/Λείπουν/);
});
