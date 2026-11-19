'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

test('assigned deliveries survive login and restart, with separate roles and private credentials', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fair-delivery-reconnect-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const cookies = {};
  let child; let logs = '';
  async function start() {
    child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, RENDER: '', DATABASE_URL: '', NODE_ENV: 'test', DEMO_MODE: 'true', DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-3000); });
    child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-3000); });
    for (let i = 0; i < 60; i++) {
      try { if ((await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Server did not start: ' + logs);
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended;
  }
  async function request(endpoint, { role = '', method = 'GET', body, status = 200, cookie } = {}) {
    const response = await fetch(base + endpoint, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-FD-Role': role, Cookie: cookie ?? Object.values(cookies).join('; ') },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json();
    assert.equal(response.status, status, `${method} ${endpoint}: ${JSON.stringify(data)}`);
    return { response, data };
  }
  async function login(role, extra = {}) {
    const result = await request('/api/auth/login', { method: 'POST', body: { role, code: 'demo', ...extra } });
    cookies[role] = result.response.headers.get('set-cookie').split(';')[0];
    return result.data;
  }
  try {
    await start(); await login('shop');
    const a = (await request('/api/shop/riders', { role: 'shop', method: 'POST', status: 201, body: { name: 'Rider Alpha' } })).data;
    const b = (await request('/api/shop/riders', { role: 'shop', method: 'POST', status: 201, body: { name: 'Rider Beta' } })).data;
    const listed = (await request('/api/shop/riders', { role: 'shop' })).data;
    assert.equal(listed.riders.length, 2);
    assert.equal(JSON.stringify(listed).includes('codeHash'), false);
    const menu = (await request('/api/products')).data;
    const newProduct = (await request('/api/shop/products', { role: 'shop', method: 'POST', status: 201, body: { name: 'Νέο προϊόν', category: 'Φαγητό', price: 7.5, active: true } })).data.product;
    assert.ok((await request('/api/products')).data.products.some(p => p.id === newProduct.id));
    await request(`/api/shop/products/${newProduct.id}`, { role: 'shop', method: 'PATCH', body: { active: false, price: 8 } });
    assert.equal((await request('/api/products')).data.products.some(p => p.id === newProduct.id), false);
    await request('/api/shop/products', { role: 'rider', status: 401 });
    const checkout = { items: [{ productId: menu.products[0].id, qty: 2, price: 0.01 }], customerName: 'Test Customer', customerPhone: '6900000000', deliveryAddress: 'Test Street 10, Athens', deliveryLocation: { lat: 37.98, lng: 23.72 }, privacyConsent: true };
    await request('/api/orders', { method: 'POST', body: null, status: 400 });
    await request('/api/orders', { method: 'POST', body: { ...checkout, deliveryLocation: { lat: null, lng: null } }, status: 400 });
    await request('/api/orders', { method: 'POST', body: { ...checkout, items: [null] }, status: 400 });
    const order = (await request('/api/orders', { method: 'POST', body: checkout, status: 201 })).data.order;
    assert.equal(order.subtotal, 9.8); assert.equal(order.total, 9.8);
    const endpoint = `/api/orders/${order.id}`;
    await request(endpoint, { role: 'shop', method: 'PATCH', body: { status: 'delivered' }, status: 409 });
    await request(endpoint, { role: 'shop', method: 'PATCH', body: { status: 'accepted' } });
    await request(endpoint, { role: 'shop', method: 'PATCH', body: { status: 'ready' } });
    await request(endpoint, { role: 'shop', method: 'PATCH', body: { status: 'assigned', riderId: a.rider.id, estimatedKm: -1 }, status: 400 });
    const untouched = (await request('/api/orders', { role: 'shop' })).data.orders[0];
    assert.equal(untouched.status, 'ready'); assert.equal(untouched.assignedRider, null);
    const assigned = (await request(endpoint, { role: 'shop', method: 'PATCH', body: { status: 'assigned', riderId: a.rider.id } })).data.order;
    assert.equal(assigned.assignedRider, a.rider.id);
    await login('rider', { riderId: b.rider.id, code: b.accessCode });
    assert.equal((await request('/api/orders', { role: 'rider' })).data.orders.length, 0);
    await request(endpoint, { role: 'rider', method: 'PATCH', body: { status: 'picked_up' }, status: 403 });
    await login('rider', { riderId: a.rider.id, code: a.accessCode });
    assert.equal((await request('/api/orders', { role: 'rider' })).data.orders[0].id, order.id);
    const statusReply = (await request('/api/rider/status', { role: 'rider', method: 'POST', body: { online: true } })).data;
    for (const key of ['codeSalt', 'codeHash', 'accessCode']) assert.equal(statusReply.rider[key], undefined);
    await request('/api/rider/location', { role: 'rider', method: 'POST', body: { lat: null, lng: null }, status: 400 });
    await request('/api/rider/location', { role: 'rider', method: 'POST', body: { lat: 37.981, lng: 23.721 } });
    const tracking = (await request(endpoint)).data.order;
    assert.equal(tracking.customerName, undefined); assert.equal(tracking.customerPhone, undefined); assert.equal(tracking.deliveryAddress, undefined);
    assert.equal(tracking.riderLocation.lat, 37.981);
    await request('/api/auth/logout', { role: 'rider', method: 'POST', body: { role: 'rider' } });
    assert.equal((await request('/api/auth/me', { role: 'rider' })).data.authenticated, false);
    assert.equal((await request('/api/auth/me', { role: 'shop' })).data.authenticated, true);
    assert.equal((await request(endpoint)).data.order.riderLocation, null);
    await login('admin');
    await request('/api/orders', { role: 'rider', status: 401 });
    await request('/api/auth/logout', { method: 'POST', body: { role: 'rider' }, cookie: cookies.shop });
    assert.equal((await request('/api/auth/me', { role: 'shop' })).data.authenticated, true);
    await login('rider', { riderId: a.rider.id, code: a.accessCode });
    assert.equal((await request('/api/orders', { role: 'rider' })).data.orders[0].id, order.id);
    await request('/api/rider/location', { role: 'rider', method: 'POST', body: { lat: 37.981, lng: 23.721 }, status: 409 });
    await request('/api/rider/status', { role: 'rider', method: 'POST', body: { online: true } });
    await request(endpoint, { role: 'rider', method: 'PATCH', body: { status: 'picked_up' } });
    await request(endpoint, { role: 'rider', method: 'PATCH', body: { status: 'delivered', estimatedKm: 2.8, badWeather: true } });
    assert.equal((await request(endpoint)).data.order.riderLocation, null);
    await request('/api/settings', { role: 'admin', method: 'PATCH', body: { customerServiceFee: 1.25, badWeatherBonus: -1 }, status: 400 });
    assert.equal((await request('/api/config')).data.settings.customerServiceFee, 0);
    await request('/api/shop/delivery-fee', { role: 'shop', method: 'POST', body: { deliveryFee: 2 } });
    const deliveryOrder = (await request('/api/orders', { method: 'POST', status: 201, body: checkout })).data.order;
    assert.equal(deliveryOrder.total, 11.8);
    const deliveryEndpoint = `/api/orders/${deliveryOrder.id}`;
    await request(deliveryEndpoint, { role: 'shop', method: 'PATCH', body: { status: 'accepted' } });
    await request(deliveryEndpoint, { role: 'shop', method: 'PATCH', body: { status: 'ready' } });
    await request(deliveryEndpoint, { role: 'shop', method: 'PATCH', body: { status: 'assigned', storeDelivery: true } });
    const shopDelivery = (await request(deliveryEndpoint, { role: 'shop', method: 'PATCH', body: { status: 'delivered' } })).data.order;
    assert.equal(shopDelivery.deliveryManagedByShop, true);
    assert.equal(shopDelivery.riderPayEstimate, null);
    const reset = (await request(`/api/shop/riders/${a.rider.id}/reset-code`, { role: 'shop', method: 'POST', body: {}, status: 200 })).data;
    await request('/api/auth/login', { method: 'POST', status: 401, body: { role: 'rider', riderId: a.rider.id, code: a.accessCode } });
    await login('rider', { riderId: a.rider.id, code: reset.accessCode });
    const newShopCode = (await request('/api/admin/shop-code', { role: 'admin', method: 'POST', body: {} })).data.accessCode;
    await request('/api/auth/login', { method: 'POST', body: { role: 'shop', code: newShopCode } });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    assert.equal(saved.orders[0].assignedRider, a.rider.id); assert.equal(saved.orders[0].status, 'delivered');
    assert.equal(JSON.stringify(saved).includes(a.accessCode), false);
    await stop(); await start();
    await request('/api/orders', { role: 'rider', status: 401 });
    const restored = await login('rider', { riderId: a.rider.id, code: reset.accessCode });
    assert.equal(restored.userId, a.rider.id);
    assert.equal((await request(endpoint)).data.order.status, 'delivered');
    assert.equal((await request('/api/config')).data.settings.customerServiceFee, 0);
    assert.equal((await request('/api/config')).data.settings.shopDeliveryFee, 2);
    for (let i = 0; i < 19; i++) await request('/api/auth/login', { method: 'POST', body: { role: 'rider', riderId: 'missing', code: 'bad' }, status: 401 });
    await request('/api/auth/login', { method: 'POST', body: { role: 'rider', riderId: 'missing', code: 'bad' }, status: 429 });
  } finally { await stop(); fs.rmSync(dataDir, { recursive: true, force: true }); }
});
