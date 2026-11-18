'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const port = 32187 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fair-delivery-test-'));
const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, RENDER: '', DATABASE_URL: '', NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DEMO_MODE: 'true' }, stdio: ['ignore','pipe','pipe'] });
const base = `http://127.0.0.1:${port}`;
const cookies = {}; let activeRole = '';
function rememberCookie(response, role) { const raw = response.headers.get('set-cookie') || ''; const first = raw.split(';')[0]; if (first) cookies[role] = first; activeRole = role; }
async function waitServer() { for (let i = 0; i < 40; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 150)); } throw new Error('Server did not start'); }
async function api(url, opts = {}) { const headers = { 'X-FD-Role': activeRole, ...(opts.headers || {}) }; const allCookies = Object.values(cookies).join('; '); if (allCookies) headers.Cookie = allCookies; const r = await fetch(base + url, { ...opts, headers }); const data = await r.json(); if (!r.ok) throw new Error(data.error || String(r.status)); return data; }
async function login(role, extra = {}) { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, code: 'demo', ...extra }) }); const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body)); rememberCookie(r, role); return body; }
(async () => {
 try {
  await waitServer();
  const health = await api('/api/health'); assert.equal(health.ok, true); assert.equal(health.version, '1.3.0');
  const html = await fetch(base + '/'); assert.equal(html.status, 200); assert.match(await html.text(), /Fair Delivery/);
  for (const file of ['/admin.js','/customer.js','/shop.js','/rider.js','/assets/app.css','/assets/common.js','/customer-app.html','/shop-app.html','/Rider-App.html']) { const asset = await fetch(base + file); assert.equal(asset.status, 200, `static asset not served: ${file}`); }
  const manifests = [];
  for (const role of ['shop','rider','admin','customer']) {
    const root = '/app/' + role + '/';
    const document = await fetch(base + root);
    assert.equal(document.status,200,'Role page failed: '+role);
    const html = await document.text();
    assert.match(html,new RegExp('/app/'+role+'/manifest\\.webmanifest'));
    assert.ok(html.includes('/assets/pwa.js'));
    const response = await fetch(base+root+'manifest.webmanifest');
    assert.equal(response.status,200);
    assert.match(response.headers.get('content-type'),/manifest/);
    const manifest=await response.json();
    manifests.push(manifest.id);
    assert.equal(manifest.start_url,root);
    assert.equal(manifest.scope,root);
    assert.equal(manifest.display,'standalone');
    for (const size of [192,512]) {
      const icon=await fetch(base+root+'icon-'+size+'.png');
      assert.equal(icon.status,200);
      assert.ok(icon.headers.get('content-type').includes('image/png'));
      const bytes=Buffer.from(await icon.arrayBuffer());
      assert.equal(bytes.readUInt32BE(0),0x89504e47);
      assert.equal(bytes.readUInt32BE(16),size);
      assert.equal(bytes.readUInt32BE(20),size);
    }
    const worker=await fetch(base+root+'sw.js');
    assert.equal(worker.status,200);
    assert.match(await worker.text(),/navigate/);
  }
  assert.equal(new Set(manifests).size,4,'Installed apps must have distinct IDs');
  assert.equal((await fetch(base+'/app/not-a-role/')).status,404);
  for (const asset of ['/assets/v2.css','/assets/shell.js']) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 200, 'Modern UI asset missing: ' + asset);
  }
  const uiViews = {
    customer: ['discover','cart','checkout','tracking'],
    shop: ['orders','menu','riders','settings'],
    rider: ['jobs','map','profile'],
    admin: ['overview','business','access','assistant']
  };
  for (const [role, views] of Object.entries(uiViews)) {
    const response = await fetch(base + '/app/' + role + '/');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('data-app-role="' + role + '"'), 'Wrong app role: '+role);
    assert.ok(html.includes('/assets/v2.css'), 'Modern CSS missing: '+role);
    assert.ok(html.includes('/assets/shell.js'), 'Navigation missing: '+role);
    for (const view of views) assert.ok(html.includes('data-view="' + view + '"'), 'Missing '+role+' section '+view);
  }
  const customerHtml = await (await fetch(base+'/app/customer/')).text();
  assert.ok(customerHtml.includes('id="productSearch"'));
  assert.ok(customerHtml.includes('id="categoryFilters"'));
  const scopedCommon = await (await fetch(base+'/assets/common.js')).text();
  assert.ok(scopedCommon.includes("'/app/shop/': 'shop'"), 'Role detection missing scoped shop PWA');
  const courierPage=await fetch(base+'/courier-apply.html');
  assert.equal(courierPage.status,200);
  assert.match(await courierPage.text(),/Γίνε συνεργάτης|Οδήγησε με τους δικούς σου όρους/);
  assert.equal((await fetch(base+'/courier-apply.js')).status,200);
  const intakeConfig=await api('/api/courier-applications/config');
  assert.equal(intakeConfig.open,true);
  assert.equal(intakeConfig.automaticApproval,false);
  const forbidden=await fetch(base+'/api/admin/courier-applications');
  assert.equal(forbidden.status,401,'Applications must be admin-only');
  const applicationSubmission=await api('/api/courier-applications',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({
      fullName:'Test Freelancer',email:'test@example.invalid',phone:'6900000099',region:'Πειραιάς',
      vehicle:'motorcycle',licenseCategory:'B',licenseValid:false,insuranceUntil:'2020-01-01',
      businessActive:false,canInvoice:false,equipmentReady:true,independentChoice:true,
      privacyAcknowledged:true
    })
  });
  assert.equal(applicationSubmission.received,true);
  assert.equal(applicationSubmission.screening.status,'needs-information');
  assert.equal(applicationSubmission.screening.requiresHumanVerification,true);
  await login('shop');
  assert.equal((await api('/api/config')).settings.customerServiceFee, 0);
  const created = await api('/api/shop/riders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test Rider' }) });
  assert.ok(created.rider.id); assert.ok(created.accessCode);
  const riderList = await api('/api/shop/riders'); assert.equal(riderList.riders.length, 1); assert.equal(riderList.riders[0].id, created.rider.id);
  const menu = await api('/api/products'); assert.ok(menu.products.length >= 1);
  const createdProduct = await api('/api/shop/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test Souvlaki', category: 'Φαγητό', price: 4.5, description: 'Test product' }) });
  assert.equal(createdProduct.product.active, true);
  const hiddenProduct = await api(`/api/shop/products/${createdProduct.product.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: false }) });
  assert.equal(hiddenProduct.product.active, false);
  assert.equal((await api('/api/products')).products.some(p => p.id === createdProduct.product.id), false);
  await api('/api/shop/delivery-fee', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deliveryFee: 1.5 }) });
  const orderResult = await api('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ productId: menu.products[0].id, qty: 2 }], customerName: 'Test Customer', customerPhone: '6900000000', deliveryAddress: 'Test Street 10, Athens', deliveryLocation: { lat: 37.98, lng: 23.72 }, privacyConsent: true }) });
  assert.match(orderResult.trackingUrl, /^\/app\/customer\/\?order=/);
  const id = orderResult.order.id; assert.equal(orderResult.order.status, 'new'); assert.deepEqual(orderResult.order.deliveryLocation, { lat: 37.98, lng: 23.72 });
  assert.equal(orderResult.order.serviceFee, 0);
  assert.equal(orderResult.order.deliveryFee, 1.5);
  assert.equal(orderResult.order.total, 11.3);
  await api(`/api/orders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'accepted' }) });
  await api(`/api/orders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ready' }) });
  const assigned = await api(`/api/orders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'assigned', riderId: created.rider.id }) });
  assert.equal(assigned.order.status, 'assigned');
  assert.equal(assigned.order.assignedRider, created.rider.id);
  const riderLogin = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'rider', riderId: created.rider.id, code: created.accessCode }) });
  assert.equal(riderLogin.status, 200); rememberCookie(riderLogin, 'rider');
  const profile1 = await api('/api/rider/profile'); assert.equal(profile1.rider.id, created.rider.id);
  const assignedOrders = await api('/api/orders'); assert.equal(assignedOrders.orders.length, 1); assert.equal(assignedOrders.orders[0].customerPhone, '6900000000');
  await api('/api/rider/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ online: true }) });
  await api('/api/rider/location', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: 37.981, lng: 23.721 }) });
  const tracking = await api(`/api/orders/${id}`); assert.equal(tracking.order.riderLocation.lat, 37.981); assert.equal(tracking.order.customerPhone, undefined);
  await api(`/api/orders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'picked_up' }) });
  const delivered = await api(`/api/orders/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'delivered', estimatedKm: 2.8, badWeather: true }) });
  assert.equal(delivered.order.status, 'delivered'); assert.equal(delivered.order.riderPayEstimate, 6.24);
  const shopDelivery = await api('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ productId: menu.products[0].id, qty: 1 }], customerName: 'Second Customer', customerPhone: '6900000001', deliveryAddress: 'Second Street 11, Athens', deliveryLocation: { lat: 37.98, lng: 23.72 }, privacyConsent: true }) });
  activeRole = 'shop';
  for (const status of ['accepted', 'ready']) await api(`/api/orders/${shopDelivery.order.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  const managed = await api(`/api/orders/${shopDelivery.order.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'assigned', storeDelivery: true }) });
  assert.equal(managed.order.deliveryManagedByShop, true);
  const finished = await api(`/api/orders/${shopDelivery.order.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'delivered' }) });
  assert.equal(finished.order.status, 'delivered');
  await login('admin');
  const couriers=await api('/api/admin/courier-applications');
  assert.equal(couriers.applications.length,1);
  assert.equal(couriers.applications[0].fullName,'Test Freelancer');
  assert.equal(couriers.applications[0].status,'new');
  const candidateId=couriers.applications[0].id;
  const reviewed=await api('/api/admin/courier-applications/'+candidateId,{
    method:'PATCH',body:JSON.stringify({status:'needs-documents',reviewNotes:'Έλεγχος διπλώματος'})
  });
  assert.equal(reviewed.application.status,'needs-documents');
  const erased=await api('/api/admin/courier-applications/'+candidateId,{method:'DELETE'});
  assert.equal(erased.deleted,true);
  assert.equal((await api('/api/admin/courier-applications')).applications.length,0);
  const stats = await api('/api/stats'); assert.equal(stats.ordersToday, 2); assert.equal(stats.deliveredToday, 2);
  // Register a synthetic account and prove all payment choices are pilot-only.
  const register=await fetch(base+'/api/customer/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({alias:'demo-test123',password:'synthetic-test-pass-123',pilotAcknowledged:true})});
  assert.equal(register.status,200); const registered=await register.json();
  assert.ok(registered.account.alias); assert.equal(registered.account.passwordHash,undefined);
  rememberCookie(register,'customer');
  const contact={items:[{productId:menu.products[0].id,qty:1}],customerName:'Pilot Test',customerPhone:'6900000088',deliveryAddress:'Test Street 1, Athens',deliveryLocation:{lat:37.98,lng:23.72},privacyConsent:true};
  for(const paymentMethod of ['cash']){
    const response=await api('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...contact,paymentMethod,confirmPaymentSimulation:true,paymentCollected:true,paymentStatus:'paid'})});
    assert.equal(response.order.paymentMethod,paymentMethod);
    assert.equal(response.order.paymentCollected,false);
    assert.equal(response.order.paymentStatus,'pilot_not_charged');
    assert.equal((await fetch(base+'/api/orders/'+response.order.id)).status,404);
  }
  for(const paymentMethod of ['card','iris']) {
    const disabled=await fetch(base+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json','X-FD-Role':'customer',Cookie:Object.values(cookies).join('; ')},body:JSON.stringify({...contact,paymentMethod,confirmPaymentSimulation:true})});
    assert.equal(disabled.status,409,'Disabled electronic methods must not create orders');
  }
  const ownOrders=await api('/api/customer/orders');
  assert.equal(ownOrders.orders.length,1);
  assert.equal((await fetch(base+'/api/customer/orders')).status,401);
  const blocked=await fetch(base+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...contact,paymentMethod:'card',confirmPaymentSimulation:true})});
  assert.equal(blocked.status,401);
  const ownerOrder=ownOrders.orders[0];
  const privateRead=await api('/api/orders/'+ownerOrder.id);assert.equal(privateRead.order.id,ownerOrder.id);
  const deleteAccount=await api('/api/customer/account',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-test-pass-123',confirmDelete:true})});
  assert.equal(deleteAccount.deleted,true);
  assert.equal((await fetch(base+'/api/orders/'+ownerOrder.id)).status,404);
  activeRole='admin';

  assert.equal(stats.platformFeeToday, 2);
  const bill=await api('/api/shop/billing');
  assert.equal(bill.feePerOrderCents,100);
  assert.equal(bill.outstandingCents,200);
  assert.equal(bill.days[0].completed,2);
  const adminHeaders={'Content-Type':'application/json','X-FD-Role':'admin',Cookie:Object.values(cookies).join('; ')};
  const payoutBody={beneficiary:'Synthetic test account',iban:'GR1601101250000000012300695',irisPhone:'',adminCode:'demo'};
  const payout=await api('/api/admin/shop-payout',{method:'PATCH',headers:adminHeaders,body:JSON.stringify(payoutBody)});
  assert.equal(payout.payout.iban,payoutBody.iban);
  assert.equal((await fetch(base+'/api/shop/billing')).status,401);
  const publicConfig=await (await fetch(base+'/api/config')).json();
  assert.equal(publicConfig.acceptingOrders,true);assert.ok(!JSON.stringify(publicConfig).includes(payoutBody.iban));
  const shopHeaders={...adminHeaders,'X-FD-Role':'shop'};
  assert.equal((await fetch(base+'/api/admin/shop-payout',{method:'PATCH',headers:shopHeaders,body:JSON.stringify(payoutBody)})).status,401);
  const hold=await api('/api/admin/shop-hold',{method:'PATCH',headers:adminHeaders,body:JSON.stringify({suspended:true,reason:'Synthetic unpaid test invoice',noticeConfirmed:true,adminCode:'demo'})});
  assert.equal(hold.hold.suspended,true);
  const shopBill=await (await fetch(base+'/api/shop/billing',{headers:shopHeaders})).json();
  assert.equal(shopBill.hold.suspended,true);assert.equal(shopBill.payout.iban,payoutBody.iban);
  assert.equal((await (await fetch(base+'/api/config')).json()).acceptingOrders,false);
  assert.equal((await fetch(base+'/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(contact)})).status,409);
  assert.equal((await fetch(base+'/api/admin/shop-hold',{method:'PATCH',headers:adminHeaders,body:JSON.stringify({suspended:false,adminCode:'demo'})})).status,409);

  const settlement=await api('/api/admin/shop-settlements',{method:'POST',body:JSON.stringify({day:bill.days[0].day,expectedCents:200,confirmPilot:true})});
  assert.equal(settlement.outstandingCents,0);
  assert.equal(settlement.settlement.amountCents,200);
  const resume=await api('/api/admin/shop-hold',{method:'PATCH',headers:adminHeaders,body:JSON.stringify({suspended:false,adminCode:'demo'})});
  assert.equal(resume.hold.suspended,false);
  assert.equal((await (await fetch(base+'/api/config')).json()).acceptingOrders,true);
  const duplicate=await fetch(base+'/api/admin/shop-settlements',{method:'POST',headers:{'Content-Type':'application/json','X-FD-Role':'admin',Cookie:Object.values(cookies).join('; ')},body:JSON.stringify({day:bill.days[0].day,expectedCents:200,confirmPilot:true})});
  assert.equal(duplicate.status,409);
  const shopForbidden=await fetch(base+'/api/admin/shop-settlements',{method:'POST',headers:{'Content-Type':'application/json','X-FD-Role':'shop',Cookie:Object.values(cookies).join('; ')},body:JSON.stringify({day:bill.days[0].day,expectedCents:200,confirmPilot:true})});
  assert.equal(shopForbidden.status,401);
  const shopCode = await api('/api/admin/shop-code', { method: 'POST' }); assert.ok(shopCode.accessCode);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')); assert.equal(saved.orders.length, 3); assert.equal(Object.keys(saved.customers).length,0); assert.ok(saved.riders[created.rider.id].codeHash); assert.ok(saved.shopCredential.codeHash);
  console.log('PASS: health, static assets, shop login, stable rider account, individual rider credentials, checkout contact/address/map pin, shop assignment, rider-only assigned orders, GPS update, privacy-safe tracking, delivery workflow, payout estimate, admin stats and persistence.');
 } catch (e) { console.error('FAIL:', e); process.exitCode = 1; }
 finally { child.kill('SIGTERM'); setTimeout(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} }, 1000); }
})();
