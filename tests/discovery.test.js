'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('public landing advertises the pilot truthfully and includes Google metadata', () => {
  const html = read('public/discover.html');
  assert.match(html, /<html lang="el">/);
  assert.match(html, /<title>Fair Delivery Ελλάδα/);
  assert.match(html, /name="description"/);
  assert.match(html, /rel="canonical" href="https:\/\/fair-delivery\.onrender\.com\/"/);
  assert.match(html, /Πιλοτική έκδοση/);
  assert.match(html, /δεν διατίθεται ακόμη στα App Store/);
  assert.match(html, /href="\/customer-app\.html"/);
  assert.match(html, /href="\/courier-apply\.html"/);
  assert.match(html, /href="\/index\.html"/);
});

test('robots and sitemap identify the public URLs, without private accounts', () => {
  const robots = read('public/robots.txt');
  const sitemap = read('public/sitemap.xml');
  assert.match(robots, /Sitemap: https:\/\/fair-delivery\.onrender\.com\/sitemap\.xml/);
  assert.match(sitemap, /<loc>https:\/\/fair-delivery\.onrender\.com\/<\/loc>/);
  assert.match(sitemap, /customer-app\.html/);
  assert.match(sitemap, /courier-apply\.html/);
  assert.doesNotMatch(sitemap, /index\.html|shop-app\.html|Rider-App\.html/);
});

test('web server routes the homepage to discovery without changing the admin URL', () => {
  const source = read('server.js');
  assert.match(source, /url\.pathname === '\/' \? '\/discover\.html'/);
  assert.match(source, /'sitemap\.xml'/);
  assert.match(source, /'robots\.txt'/);
  assert.match(source, /'X-Robots-Tag': 'noindex, nofollow'/);
  assert.match(source, /'index\.html'/);
});
