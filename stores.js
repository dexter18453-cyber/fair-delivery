'use strict';
const crypto=require('crypto');
function storeId(value){return typeof value==='string'&&/^(default|[0-9a-f-]{36})$/.test(value)?value:null;}
function allStores(state){return [{id:'default',name:state.defaultStoreName||'Πρώτο κατάστημα',active:true},...Object.values(state.stores||{}).map(s=>({id:s.id,name:s.name,active:s.active===true}))];}
function getStore(state,id){if(id==='default')return {id,name:state.defaultStoreName||'Πρώτο κατάστημα',active:true,products:state.products,settings:state.settings};return Object.hasOwn(state.stores||{},id)?state.stores[id]:null;}
function publicStore(state,s){return {id:s.id,name:s.name,acceptingOrders:s.active===true&&!state.shopHolds[s.id]?.suspended};}
function newStore(name,codeSalt,codeHash){
 if(typeof name!=='string'||name.trim().length<2||name.trim().length>100)throw Object.assign(Error('Συμπλήρωσε όνομα 2–100 χαρακτήρων.'),{statusCode:400});
 return {id:crypto.randomUUID(),name:name.trim(),active:false,products:[],settings:{shopDeliveryFee:0,storeLocation:null},codeSalt,codeHash,createdAt:new Date().toISOString()};
}
module.exports={storeId,allStores,getStore,publicStore,newStore};
