'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createApp } = require('../server');
const { quote } = require('../lib/pricing');

const ADMIN = 'A'.repeat(32), RIDER = 'R'.repeat(32);
const created = [];
async function fixture(enabled = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fair-delivery-test-'));
  const app = await createApp({ env:{
    ADMIN_TOKEN: ADMIN, RIDER_TOKEN: RIDER, ENABLE_ORDERS: enabled ? 'true' : 'false',
    DATA_FILE: path.join(dir,'state.json')
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + app.server.address().port;
  const request = async (url, { method='GET', body, token } = {}) => {
    const res = await fetch(root+url,{
      method, headers:{ ...(body ? {'Content-Type':'application/json'}:{}), ...(token ? {Authorization:'Bearer '+token}:{}) },
      body: body ? JSON.stringify(body):undefined
    });
    const json = await res.json().catch(()=>({}));
    return {status:res.status, data:json};
  };
  created.push(async()=>{
    await new Promise(resolve=>app.server.close(resolve));
    await app.store.close();
    await fs.rm(dir,{recursive:true,force:true});
  });
  return {request,app,root};
}
test.after(async()=>{for (const close of created.reverse()) await close();});
test('fixed EUR 2.30 incl VAT, and 8% commission plus its service VAT',()=>{
  const result = quote({items:[{productId:'a1',name:'Product',unitPriceCents:2000,quantity:1}]});
  assert.equal(result.serviceFeeGrossCents,230);
  assert.equal(result.serviceFeeNetCents,185);
  assert.equal(result.serviceFeeVatCents,45);
  assert.equal(result.commissionNetCents,160);
  assert.equal(result.commissionVatCents,38);
  assert.equal(result.merchantCommissionGrossCents,198);
  assert.equal(result.customerTotalCents,2230);
  assert.equal(result.platformRevenueNetCents,345);
  assert.throws(()=>quote({items:[{unitPriceCents:-3,quantity:1}]}));
});
test('auth protects operations; real orders are opt-in; no arbitrary files exposed',async()=>{
  const {request,root}=await fixture(false);
  assert.equal((await request('/api/admin/summary')).status,401);
  assert.equal((await request('/api/admin/summary',{token:'x'.repeat(32)})).status,401);
  const r=await fetch(root+'/server.js');
  assert.equal(r.status,404);
  assert.equal((await request('/api/orders',{method:'POST',body:{}})).status,503);
  const shops=await request('/api/shops');
  assert.equal(shops.data.shops.length,0);
  assert.equal(shops.data.serviceFeeCents,230);
});
test('admin can onboard, customer can quote/order/track, status and monthly reports work',async()=>{
  const {request}=await fixture(true);
  const input={id:'test-shop',name:'Test Store',area:'Κερατσίνι'};
  assert.equal((await request('/api/admin/shops',{method:'POST',token:ADMIN,body:input})).status,201);
  const add=await request('/api/admin/shops/test-shop/products',{method:'POST',token:ADMIN,
    body:{id:'item1',name:'Είδος δοκιμής',priceCents:2000}});
  assert.equal(add.status,200);
  assert.equal((await request('/api/admin/shops/test-shop/activate',{method:'POST',token:ADMIN,
    body:{active:true}})).status,200);
  const issued=await request('/api/admin/shops/test-shop/key',{method:'POST',token:ADMIN});
  const SHOP=issued.data.key;
  assert.equal(SHOP.length>=24,true);
  assert.equal((await request('/api/ops/me',{token:SHOP})).data.role.shopId,'test-shop');
  assert.equal((await request('/api/admin/summary',{token:SHOP})).status,403);
  const quoteResult=await request('/api/quote',{method:'POST',
    body:{shopId:'test-shop',items:[{productId:'item1',quantity:1}]}});
  assert.equal(quoteResult.data.pricing.customerTotalCents,2230);
  const idempotencyKey='11111111-1111-4111-8111-111111111111';
  const orderBody={shopId:'test-shop',items:[{productId:'item1',quantity:1}],
    customerName:'Δοκιμαστικός Πελάτης',customerPhone:'6900000000',
    deliveryAddress:'Οδός Δοκιμής 14 Κερατσίνι',idempotencyKey};
  const placed=await request('/api/orders',{method:'POST',body:orderBody});
  assert.equal(placed.status,201);
  assert.ok(placed.data.trackingToken);
  const again=await request('/api/orders',{method:'POST',body:orderBody});
  assert.equal(again.status,200);
  assert.equal(again.data.trackingToken,placed.data.trackingToken);
  assert.equal(again.data.id,placed.data.id);
  const track=await request('/api/track',{method:'POST',
    body:{orderId:placed.data.id,trackingToken:placed.data.trackingToken}});
  assert.equal(track.status,200);
  assert.equal(track.data.order.status,'new');
  assert.equal(JSON.stringify(track.data).includes('6900000000'),false);
  assert.equal((await request('/api/track',{method:'POST',
    body:{orderId:placed.data.id,trackingToken:'x'.repeat(32)}})).status,404);
  assert.equal((await request('/api/ops/orders/'+placed.data.id+'/status',
    {method:'POST',token:RIDER,body:{status:'delivered'}})).status,409);
  for (const [status,token] of [['accepted',SHOP],['preparing',SHOP],['ready',SHOP],
    ['picked_up',RIDER],['delivered',RIDER]]) {
    const move=await request('/api/ops/orders/'+placed.data.id+'/status',
      {method:'POST',token,body:{status}});
    assert.equal(move.status,200,status);
  }
  const summary=await request('/api/admin/summary',{token:ADMIN});
  assert.equal(summary.data.totalOrders,1);
  assert.equal(summary.data.deliveredOrders,1);
  assert.equal(summary.data.totals.platformRevenueNetCents,345);
  assert.equal(summary.data.totals.platformCollectedVatCents,83);
  assert.equal((await request('/api/admin/expenses',{method:'POST',token:ADMIN,
    body:{label:'Δοκιμή κόστους',amountCents:100}})).status,201);
  const after=await request('/api/admin/summary',{token:ADMIN});
  assert.equal(after.data.estimatedOperatingBalanceCents,245);
});
test('shop interest appears in private in-app inbox',async()=>{
  const {request}=await fixture();
  const interest={businessName:'Δοκιμαστική Επιχείρηση',contactName:'Υπεύθυνος Δοκιμή',
    phone:'6900000000',area:'Νίκαια'};
  assert.equal((await request('/api/interest',{method:'POST',body:interest})).status,201);
  assert.equal((await request('/api/admin/interests')).status,401);
  const result=await request('/api/admin/interests',{token:ADMIN});
  assert.equal(result.data.interests.length,1);
  assert.equal(result.data.interests[0].area,'Νίκαια');
});
