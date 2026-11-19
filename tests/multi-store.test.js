'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const vm=require('node:vm');
const {getStore,allStores,newStore,publicStore}=require('../stores');
test('store records start invisible and expose no credentials',()=>{
 const store=newStore('Synthetic store','salt','hash');
 const state={stores:{[store.id]:store},settings:{},products:[],shopHolds:{}};
 assert.equal(store.active,false);assert.equal(getStore(state,'default').products,state.products);
 assert.equal(getStore(state,store.id),store);
 assert.equal(getStore(state,'__proto__'),null);
 assert.equal(allStores(state).length,2);
 assert.equal(publicStore(state,store).acceptingOrders,false);
 assert.equal(publicStore(state,store).codeHash,undefined);
});
test('store UI scripts are syntactically valid',()=>{
 for(const file of ['customer.js','shop.js','admin.js'])new vm.Script(fs.readFileSync(path.join(__dirname,'../public',file),'utf8'));
});
test('multi-store API isolates menus and credentials, order routing and billing', {timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fd-stores-'));
 const port=34000+Math.floor(Math.random()*2000),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,RENDER:'',DATABASE_URL:'',NODE_ENV:'test',DEMO_MODE:'true',PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir},stdio:'ignore'});
 async function call(url,role='',cookie='',method='GET',body,expected=200){
  const r=await fetch(base+url,{method,headers:{'X-FD-Role':role,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await r.json();assert.equal(r.status,expected,method+' '+url+' '+JSON.stringify(data));return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]||''};
 }
 try{
  for(let i=0;i<50;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const admin=(await call('/api/auth/login','','','POST',{role:'admin',code:'demo'})).cookie;
  const a=(await call('/api/admin/stores','admin',admin,'POST',{name:'Synthetic store A'},201)).data;
  const b=(await call('/api/admin/stores','admin',admin,'POST',{name:'Synthetic store B'},201)).data;
  const storeA=a.store.id,storeB=b.store.id;
  const login=async (id,code,expected=200)=>call('/api/auth/login','','','POST',{role:'shop',storeId:id,code},expected);
  const sa=(await login(storeA,a.accessCode)).cookie,sb=(await login(storeB,b.accessCode)).cookie;
  await login(storeB,a.accessCode,401);
  const pa=(await call('/api/shop/products','shop',sa,'POST',{name:'Synthetic product A',price:3},201)).data.product;
  const pb=(await call('/api/shop/products','shop',sb,'POST',{name:'Synthetic product B',price:5},201)).data.product;
  await call('/api/shop/products/'+pb.id,'shop',sa,'PATCH',{price:1},404);
  assert.deepEqual((await call('/api/shop/products','shop',sa)).data.products.map(p=>p.id),[pa.id]);
  await call('/api/products?storeId='+storeA,'','','GET',undefined,404);
  await call('/api/admin/stores','admin',admin,'PATCH',{storeId:storeA,active:true},409);
  for(const [id,cookie,fee] of [[storeA,sa,1],[storeB,sb,2]]){
   await call('/api/shop/location','shop',cookie,'POST',{lat:37.9,lng:23.7});
   await call('/api/shop/delivery-fee','shop',cookie,'POST',{deliveryFee:fee});
   await call('/api/admin/stores','admin',admin,'PATCH',{storeId:id,active:true});
  }
  assert.equal((await call('/api/config','shop',sa)).data.settings.shopDeliveryFee,1);
  assert.equal((await call('/api/config','shop',sb)).data.settings.shopDeliveryFee,2);
  assert.deepEqual((await call('/api/products?storeId='+storeB)).data.products.map(p=>p.id),[pb.id]);
  const customer=(await call('/api/customer/register','','','POST',{alias:'demo-storetest',password:'synthetic-only-1234',pilotAcknowledged:true})).cookie;
  const contact={customerName:'Synthetic customer',customerPhone:'0000000000',deliveryAddress:'Synthetic address',deliveryLocation:{lat:37.9,lng:23.7},privacyConsent:true,paymentMethod:'cash'};
  await call('/api/orders','customer',customer,'POST',{...contact,storeId:storeA,items:[{productId:pb.id,qty:1}]},400);
  const requestId='2be07789-a53a-4bbb-ae11-3d66cc568bc1';
  const attempt={...contact,storeId:storeA,items:[{productId:pa.id,qty:1}],requestId,quote:{deliveryCents:100,items:[{productId:pa.id,unitCents:300}]}};
  await call('/api/orders','customer',customer,'POST',{...attempt,quote:{...attempt.quote,deliveryCents:200}},409);
  await call('/api/orders','customer',customer,'POST',{...attempt,quote:{...attempt.quote,items:[{productId:pa.id,unitCents:200}]}},409);
  const order=(await call('/api/orders','customer',customer,'POST',attempt,201)).data.order;
  const replay=(await call('/api/orders','customer',customer,'POST',attempt,200)).data;
  assert.equal(replay.order.id,order.id);assert.equal(replay.replayed,true);
  assert.equal(replay.order.checkoutRequestId,undefined);assert.equal(replay.order.checkoutDigest,undefined);
  await call('/api/orders','customer',customer,'POST',{...attempt,customerName:'Different synthetic customer'},409);
  assert.equal((await call('/api/orders','shop',sa)).data.orders.length,1);
  assert.equal(order.total,4);assert.equal(order.storeId,storeA);
  assert.equal(order.etaMin,25);assert.equal(order.etaMax,50);
  const operationSettings=(await call('/api/shop/operations','shop',sa)).data.operations;
  await call('/api/shop/operations','shop',sa,'PATCH',{...operationSettings,minOrder:6,radiusKm:2,etaMin:15,etaMax:35});
  assert.equal((await call('/api/config?storeId='+storeA)).data.store.minOrder,6);
  assert.equal((await call('/api/config?storeId='+storeB)).data.store.minOrder,0);
  await call('/api/shop/operations','shop',sa,'PATCH',{paused:true});
  assert.equal((await call('/api/config?storeId='+storeA)).data.store.reason,'paused');
  assert.equal((await call('/api/config?storeId='+storeB)).data.acceptingOrders,true);
  await call('/api/shop/operations','shop',sa,'PATCH',{paused:false});
  assert.equal((await call('/api/config?storeId='+storeA)).data.store.etaMax,35);
  await call('/api/orders','customer',customer,'POST',{...contact,storeId:storeA,items:[{productId:pa.id,qty:1}]},409);
  await call('/api/orders','customer',customer,'POST',{...contact,deliveryLocation:{lat:38.1,lng:23.7},storeId:storeA,items:[{productId:pa.id,qty:2}]},409);
  await call('/api/shop/operations','customer',customer,'PATCH',{paused:true},401);
  assert.equal((await call('/api/orders','shop',sb)).data.orders.length,0);
  await call('/api/orders/'+order.id,'shop',sb,'PATCH',{status:'accepted'},403);
  await call('/api/orders/'+order.id,'shop',sb,'GET',undefined,404);
  for(const status of ['accepted','ready','assigned','delivered'])await call('/api/orders/'+order.id,'shop',sa,'PATCH',{status,...(status==='assigned'?{storeDelivery:true}:{})});
  assert.equal((await call('/api/shop/billing','shop',sa)).data.outstandingCents,100);
  assert.equal((await call('/api/shop/billing?storeId='+storeA,'shop',sb)).data.outstandingCents,0);
  assert.equal((await call('/api/shop/billing?storeId='+storeA,'admin',admin)).data.outstandingCents,100);
  await call('/api/admin/shop-hold','admin',admin,'PATCH',{storeId:storeA,suspended:true,reason:'Synthetic overdue settlement',noticeConfirmed:true,adminCode:'demo'});
  assert.equal((await call('/api/config?storeId='+storeA)).data.acceptingOrders,false);
  assert.equal((await call('/api/config?storeId='+storeB)).data.acceptingOrders,true);
  await call('/api/orders','customer',customer,'POST',{...contact,storeId:storeA,items:[{productId:pa.id,qty:1}]},409);
  const reset=(await call('/api/admin/shop-code','admin',admin,'POST',{storeId:storeA})).data;
  await call('/api/shop/products','shop',sa,'GET',undefined,401);
  await login(storeA,a.accessCode,401);await login(storeA,reset.accessCode);
  assert.equal((await call('/api/shop/products','shop',sb)).data.products.length,1);
 }finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,150));fs.rmSync(dir,{recursive:true,force:true});}
});
