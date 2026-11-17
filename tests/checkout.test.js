'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function makeDocument(file) {
  const html = fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    value: '', checked: false, dataset: {}, textContent: '', innerHTML: '', disabled: false, listeners: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener(name, handler) { this.listeners[name] = handler; }
  }]));
  return { nodes, getElementById: id => { assert.ok(nodes.has(id), `Missing HTML element ${id}`); return nodes.get(id); }, querySelectorAll: () => [] };
}

test('checkout shows the final fee-inclusive amount, tolerates a missing map, and submits once', async () => {
  const document = makeDocument('customer-app.html');
  const node = id => document.nodes.get(id);
  let orderRequests = 0; let completeOrder; let trackingIntervals = 0;
  const money = value => new Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' }).format(value);
  const context = vm.createContext({
    document, location: { search: '' }, URLSearchParams, window: {},
    navigator: { geolocation: { getCurrentPosition: callback => callback({ coords: { latitude: 37.98, longitude: 23.72 } }) } },
    setInterval: () => { trackingIntervals++; return 1; }, clearInterval: () => { trackingIntervals--; }, setTimeout,
    FD: {
      money, esc: value => String(value), status: value => value, notice() {},
      api: async endpoint => {
        if (endpoint === '/api/products') return { products: [{ id: 'test-product', name: 'Test', price: 4.9 }] };
        if (endpoint === '/api/config') return { settings: { customerServiceFee: 1.79, shopDeliveryFee: 2 } };
        if (endpoint === '/api/orders') { orderRequests++; return new Promise(resolve => { completeOrder = resolve; }); }
        return { order: { id: 'test-order', total: 10, status: 'delivered', createdAt: new Date().toISOString() } };
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/customer.js'), 'utf8'), context);
  await new Promise(setImmediate);
  vm.runInContext("changeQty('test-product', 2)", context);
  assert.equal(node('subtotal').textContent, money(9.8));
  assert.equal(node('serviceFee').textContent, money(1.79));
  assert.equal(node('deliveryFee').textContent, money(2));
  assert.equal(node('total').textContent, money(13.59));
  node('customerName').value = 'Test Customer'; node('customerPhone').value = '6900000000';
  node('deliveryAddress').value = 'Test Street 10'; node('privacyConsent').checked = true;
  node('useLocation').onclick();
  assert.equal(node('deliveryCoords').dataset.lat, '37.98');
  const first = node('placeOrder').listeners.click();
  assert.equal(node('placeOrder').disabled, true);
  await node('placeOrder').listeners.click();
  assert.equal(orderRequests, 1);
  completeOrder({ order: { id: 'test-order' } }); await first;
  await new Promise(setImmediate);
  assert.equal(node('total').textContent, money(0));
  assert.equal(trackingIntervals, 0);
});

test('rider reload restores availability and polling, with GPS waiting for an explicit choice', async () => {
  const document = makeDocument('Rider-App.html');
  const node = id => document.nodes.get(id);
  let polling = 0; let watched = 0; let stopped = 0;
  const context = vm.createContext({
    document, location: { reload() {} }, window: { addEventListener() {} },
    navigator: { geolocation: { watchPosition() { watched++; return 7; }, clearWatch() { stopped++; } } },
    setInterval: () => { polling++; return 1; }, clearInterval: () => { polling--; }, setTimeout,
    FD: { me: async () => ({ authenticated: true, role: 'rider' }), api: async endpoint => endpoint === '/api/rider/profile' ? { rider: { name: 'Test Rider', online: true } } : { orders: [] }, notice() {}, esc: value => String(value) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/rider.js'), 'utf8'), context);
  await new Promise(setImmediate);
  assert.equal(node('onlineBtn').textContent, 'GO OFFLINE'); assert.equal(polling, 1);
  assert.equal(watched, 0); node('gpsBtn').onclick(); assert.equal(watched, 1);
  node('gpsBtn').onclick(); assert.equal(stopped, 1);
});
