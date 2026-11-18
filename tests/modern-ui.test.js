'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const read = relative => fs.readFileSync(path.join(publicDir, relative), 'utf8');

test('new mobile-first theme is wired to all four app roles', () => {
  const pages = ['index.html', 'customer-app.html', 'shop-app.html', 'Rider-App.html'];
  for (const page of pages) {
    const html = read(page);
    assert.match(html, /\/assets\/modern\.css\?v=20261119-1/, page + ' missing theme');
    assert.match(html, /\/assets\/modern-ui\.js\?v=20261119-1/, page + ' missing UX script');
    assert.ok(html.indexOf('/assets/modern.css') > html.indexOf('/assets/v2.css'),
      page + ' must load new stylesheet after legacy stylesheet');
  }
});

test('cart count is read from existing cart without changing checkout', () => {
  const js = read('assets/modern-ui.js');
  assert.doesNotThrow(() => new Function(js));
  assert.match(js, /MutationObserver/);
  assert.match(js, /\.qty > b/);
  assert.doesNotMatch(js, /\/api\/|localStorage|fetch\(/);
});

test('modern stylesheet has responsive and accessible states', () => {
  const css = read('assets/modern.css');
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /max-width:600px/);
  assert.match(css, /\.cart-count\[hidden\]/);
});
