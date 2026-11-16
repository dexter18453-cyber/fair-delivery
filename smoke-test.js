'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const port = 32187 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fair-delivery-test-'));
const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DEMO_MODE: 'true' }, stdio: ['ignore','pipe','pipe'] });
const base = `http://127.0.0.1:${port}`;
const cookies = {}; let activeRole = '';
function rememberCookie(response, role) { const raw = response.headers.get('set-cookie') || ''; const first = raw.split(';')[0]; if (first) cookies[role] = first; activeRole = role; }
async function waitServer() { for (let i = 0; i < 40; i++) { try { const r = await fetch(base + '/api/health'); if (r.ok) return; } catch {} await new Promise(r => setTimeout(r, 150)); } throw new Error('Server did not start'); }
async function api(url, opts = {}) { const headers = { 'X-FD-Role': activeRole, ...(opts.headers || {}) }; const allCookies = Object.values(cookies).join('; '); if (allCookies) headers.Cookie = allCookies; const r = await fetch(base + url, { ...opts, headers }); const data = await r.json(); if (!r.ok) throw new Error(data.error || String(r.status)); return data; }
async function login(role, extra = {}) { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, code: 'demo', ...extra }) }); const body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body)); rememberCookie(r, role); return body; }
(async () => {
 try {
  await waitServer();
  const health = await api('/api/health'); assert.equal(health.ok, true); assert.equal(health.version, '1.2.0');
  const html = await fetch(base + '/'); assert.equal(html.status, 200); assert.match(await html.text(), /Fair Delivery/);
  for (const file of ['/admin.js','/customer.js','/shop.js','/rider.js','/assets/app.css','/assets/common.js','/customer-app.html','/shop-app.html','/Rider-App.html']) { const asset = await fetch(base + file); assert.equal(asset.status, 200, `static asset not served: ${file}`); }
  await login('shop');
  const created = await api('/api/shop/riders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test Rider' }) });
  assert.ok(created.rider.id); assert.ok(created.accessCode);
  const riderList = await api('/api/shop/riders'); assert.equal(riderList.riders.length, 1); assert.equal(riderList.riders[0].id, created.rider.id);
  const menu = await api('/api/products'); assert.ok(menu.products.length >= 1);
  const orderResult = await api('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ productId: menu.products[0].id, qty: 2 }], customerName: 'Test Customer', customerPhone: '6900000000', deliveryAddress: 'Test Street 10, Athens', deliveryLocation: { lat: 37.98, lng: 23.72 }, privacyConsent: true }) });
  const id = orderResult.order.id; assert.equal(orderResult.order.status, 'new'); assert.deepEqual(orderResult.order.deliveryLocation, { lat: 37.98, lng: 23.72 });
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
  await login('admin'); const stats = await api('/api/stats'); assert.equal(stats.ordersToday, 1); assert.equal(stats.deliveredToday, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8')); assert.equal(saved.orders.length, 1); assert.ok(saved.riders[created.rider.id].codeHash);
  console.log('PASS: health, static assets, shop login, stable rider account, individual rider credentials, checkout contact/address/map pin, shop assignment, rider-only assigned orders, GPS update, privacy-safe tracking, delivery workflow, payout estimate, admin stats and persistence.');
 } catch (e) { console.error('FAIL:', e); process.exitCode = 1; }
 finally { child.kill('SIGTERM'); setTimeout(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} }, 1000); }
})();
