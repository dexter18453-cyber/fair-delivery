'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/assets/common.js'), 'utf8');

test('each page sends its own role when several account cookies share a browser', async () => {
  for (const [pathname, expected] of [['/', 'admin'], ['/index.html', 'admin'], ['/shop-app.html', 'shop'], ['/Rider-App.html', 'rider'], ['/customer-app.html', 'customer'], ['/app/admin/', 'admin'], ['/app/shop/', 'shop'], ['/app/rider/', 'rider'], ['/app/customer/', 'customer']]) {
    const requests = [];
    const context = vm.createContext({
      location: { pathname },
      sessionStorage: { getItem: () => 'rider', setItem() {}, removeItem() {} },
      fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({}) }; }
    });
    vm.runInContext(source + '\nglobalThis.client = FD;', context);
    await context.client.api('/api/orders');
    assert.equal(requests[0].options.headers['X-FD-Role'], expected, pathname);
    assert.equal(requests[0].options.credentials, 'same-origin');
    await context.client.me('shop');
    assert.equal(requests[1].options.headers['X-FD-Role'], 'shop');
  }
});
