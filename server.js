'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('./lib/store');
const { quote, cents } = require('./lib/pricing');

const HASH = value => crypto.createHash('sha256').update(value).digest('hex');
const uuid = () => crypto.randomUUID();
const BAD = (status, message) => { const e = new Error(message); e.status = status; return e; };
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const slug = value => matches(value, /^[a-z0-9][a-z0-9-]{1,39}$/);
const now = () => new Date().toISOString();
const transitions = {
  new: { accepted: ['shop', 'admin'], cancelled: ['shop', 'admin'] },
  accepted: { preparing: ['shop', 'admin'], cancelled: ['shop', 'admin'] },
  preparing: { ready: ['shop', 'admin'] },
  ready: { picked_up: ['rider', 'admin'], cancelled: ['admin'] },
  picked_up: { delivered: ['rider', 'admin'] },
  delivered: {}, cancelled: {}
};

function tokenRole(token, state, adminToken, riderToken) {
  if (!token || token.length < 20 || token.length > 256) return null;
  const hashed = HASH(token);
  const eq = expected => expected && crypto.timingSafeEqual(Buffer.from(hashed), Buffer.from(expected));
  if (eq(HASH(adminToken))) return { type: 'admin' };
  if (eq(HASH(riderToken))) return { type: 'rider' };
  const shop = state.shops.find(item => item.shopKeyHash && eq(item.shopKeyHash));
  return shop ? { type: 'shop', shopId: shop.id } : null;
}
function auth(req, state, adminToken, riderToken, allowed) {
  const match = /^Bearer ([A-Za-z0-9_-]{20,256})$/.exec(req.headers.authorization || '');
  const role = tokenRole(match && match[1], state, adminToken, riderToken);
  if (!role) throw BAD(401, 'Απαιτείται έγκυρη σύνδεση.');
  if (!allowed.includes(role.type)) throw BAD(403, 'Δεν έχεις πρόσβαση.');
  return role;
}
function shopAccess(role, shopId) {
  if (role.type !== 'admin' && !(role.type === 'shop' && role.shopId === shopId)) {
    throw BAD(403, 'Δεν έχεις πρόσβαση σε αυτό το κατάστημα.');
  }
}
async function body(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32 * 1024) throw BAD(413, 'Πολύ μεγάλο αίτημα.');
    parts.push(chunk);
  }
  let json;
  try { json = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch (_) { throw BAD(400, 'Μη έγκυρο JSON.'); }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw BAD(400, 'Μη έγκυρα δεδομένα.');
  return json;
}
function resolveBasket(state, shopId, items) {
  const shop = state.shops.find(s => s.id === shopId && s.active);
  if (!shop) throw BAD(404, 'Το κατάστημα δεν δέχεται ακόμη παραγγελίες.');
  if (!Array.isArray(items) || !items.length || items.length > 20) throw BAD(400, 'Επίλεξε προϊόντα.');
  const ids = new Set();
  const basket = items.map(item => {
    if (!item || !slug(item.productId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) throw BAD(400, 'Μη έγκυρη ποσότητα.');
    if (ids.has(item.productId)) throw BAD(400, 'Διπλό προϊόν στο καλάθι.');
    ids.add(item.productId);
    const p = shop.products.find(p => p.id === item.productId && p.active);
    if (!p) throw BAD(400, 'Κάποιο προϊόν δεν είναι διαθέσιμο.');
    return { productId: p.id, name: p.name, unitPriceCents: p.priceCents, quantity: item.quantity };
  });
  return { shop, breakdown: quote({ items: basket, deliveryFeeCents: shop.deliveryFeeCents }) };
}
function publicShop(shop) {
  return { id: shop.id, name: shop.name, area: shop.area, active: shop.active,
    deliveryFeeCents: shop.deliveryFeeCents,
    products: shop.products.filter(p => p.active).map(p => ({ id: p.id, name: p.name, priceCents: p.priceCents })) };
}
function publicTracking(order) {
  return { id: order.id, shopName: order.shopName, createdAt: order.createdAt,
    status: order.status, updatedAt: order.updatedAt, pricing: order.pricing };
}
function safeOrder(order, role) {
  const basic = { ...order };
  delete basic.trackingHash;
  delete basic.idempotencyKey;
  delete basic.fingerprint;
  if (role.type === 'rider' && !['picked_up','delivered'].includes(order.status)) {
    delete basic.customerPhone;
    delete basic.deliveryAddress;
    delete basic.customerName;
    delete basic.notes;
  }
  return basic;
}
function athensMonth(value) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Athens',
    year: 'numeric', month: '2-digit' }).formatToParts(new Date(value));
  return parts.find(p => p.type === 'year').value + '-' + parts.find(p => p.type === 'month').value;
}
function summary(state) {
  const month = athensMonth(now());
  const orders = state.orders.filter(o => athensMonth(o.createdAt) === month);
  const delivered = orders.filter(o => o.status === 'delivered');
  const totals = delivered.reduce((a, o) => {
    a.serviceFeeGrossCents += o.pricing.serviceFeeGrossCents;
    a.commissionGrossCents += o.pricing.merchantCommissionGrossCents;
    a.platformRevenueNetCents += o.pricing.platformRevenueNetCents;
    a.platformCollectedVatCents += o.pricing.platformCollectedVatCents;
    a.customerGMVCents += o.pricing.customerTotalCents;
    return a;
  }, {serviceFeeGrossCents:0,commissionGrossCents:0,platformRevenueNetCents:0,platformCollectedVatCents:0,customerGMVCents:0});
  const expensesCents = state.expenses.filter(e => athensMonth(e.date) === month)
    .reduce((sum,e) => sum + e.amountCents, 0);
  return { month, totalOrders: orders.length, deliveredOrders: delivered.length,
    cancelledOrders: orders.filter(o => o.status === 'cancelled').length,
    activeShops: state.shops.filter(s => s.active).length,
    totals, recordedExpensesCents: expensesCents,
    estimatedOperatingBalanceCents: totals.platformRevenueNetCents - expensesCents,
    disclaimer: 'Δεν είναι καθαρό κέρδος ή φορολογική δήλωση. Ελλείποντα κόστη, επιστροφές, φόροι και ασφαλιστικές εισφορές δεν υπολογίζονται.' };
}
async function createApp(options = {}) {
  const env = options.env || process.env;
  const production = env.NODE_ENV === 'production';
  const adminToken = env.ADMIN_TOKEN || (!production && crypto.randomBytes(24).toString('base64url'));
  const riderToken = env.RIDER_TOKEN || (!production && crypto.randomBytes(24).toString('base64url'));
  if (!adminToken || adminToken.length < 24 || !riderToken || riderToken.length < 24) {
    throw new Error('ADMIN_TOKEN and RIDER_TOKEN must each contain at least 24 characters');
  }
  const store = options.store || await createStore({ databaseUrl: env.DATABASE_URL,
    production, file: env.DATA_FILE });
  const allowOrders = env.ENABLE_ORDERS === 'true';
  const rate = new Map();
  const send = (res, code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const readStatic = async (name, res) => {
    const types = { '/': ['index.html', 'text/html; charset=utf-8'],
      '/index.html': ['index.html', 'text/html; charset=utf-8'],
      '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
      '/app.js': ['app.js', 'text/javascript; charset=utf-8'] };
    if (['/customer-app.html','/shop-app.html','/Rider-App.html'].includes(name)) {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    const entry = types[name];
    if (!entry) throw BAD(404, 'Η σελίδα δεν βρέθηκε.');
    const content = await fs.readFile(path.join(__dirname, entry[0]));
    res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
    res.end(content);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Permissions-Policy','geolocation=(), camera=(), microphone=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    const pathname = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && pathname === '/api/health') {
        return send(res, 200, { ok: true, version: 'pilot-v2', orderIntake: allowOrders });
      }
      if (req.method === 'GET' && pathname === '/api/shops') {
        const state = await store.read();
        return send(res, 200, { shops: state.shops.filter(s => s.active).map(publicShop), serviceFeeCents: 230,
          orderIntake: allowOrders });
      }
      if (req.method === 'POST' && pathname === '/api/quote') {
        const data = await body(req);
        const state = await store.read();
        const { shop, breakdown } = resolveBasket(state, data.shopId, data.items);
        return send(res, 200, { shopId: shop.id, pricing: breakdown });
      }
      if (req.method === 'POST' && pathname === '/api/orders') {
        if (!allowOrders) throw BAD(503, 'Οι πραγματικές παραγγελίες είναι απενεργοποιημένες για το πιλοτικό.');
        const ip = req.socket.remoteAddress || 'unknown';
        const current = Date.now();
        const attempts = (rate.get(ip) || []).filter(t => t > current - 3600000);
        if (attempts.length >= 30) throw BAD(429, 'Πολλές προσπάθειες. Δοκίμασε αργότερα.');
        attempts.push(current); rate.set(ip, attempts);
        if (rate.size > 10000) rate.clear();
        const data = await body(req);
        const name = clean(data.customerName, 80);
        const phone = clean(data.customerPhone, 25);
        const address = clean(data.deliveryAddress, 240);
        const notes = clean(data.notes, 300);
        if (name.length < 2 || !matches(phone, /^[+0-9() -]{9,25}$/) || address.length < 8) {
          throw BAD(400, 'Συμπλήρωσε όνομα, τηλέφωνο και πλήρη διεύθυνση.');
        }
        if (!matches(data.idempotencyKey, /^[a-f0-9-]{36}$/)) throw BAD(400, 'Απαιτείται έγκυρο αναγνωριστικό παραγγελίας.');
        const fingerprint = HASH(JSON.stringify({ shopId:data.shopId, items:data.items, name, phone, address, notes }));
        const result = await store.transact(state => {
          const old = state.orders.find(o => o.idempotencyKey === data.idempotencyKey);
          if (old) {
            if (old.fingerprint !== fingerprint) throw BAD(409, 'Το αναγνωριστικό παραγγελίας χρησιμοποιήθηκε ήδη.');
            return { id:old.id, trackingToken: null, duplicate: true, pricing:old.pricing };
          }
          const { shop, breakdown } = resolveBasket(state, data.shopId, data.items);
          const trackingToken = crypto.randomBytes(24).toString('base64url');
          const order = { id:uuid(), idempotencyKey:data.idempotencyKey, fingerprint,
            shopId:shop.id, shopName:shop.name, createdAt:now(), updatedAt:now(),
            status:'new', customerName:name, customerPhone:phone, deliveryAddress:address,
            notes, pricing:breakdown, trackingHash:HASH(trackingToken),
            history:[{ status:'new', at:now(), by:'customer' }] };
          state.orders.push(order);
          return { id:order.id, trackingToken, duplicate:false, pricing:breakdown };
        });
        // Client retries use the original tracking token stored in sessionStorage.
        return send(res, result.duplicate ? 200 : 201, result);
      }
      if (req.method === 'POST' && pathname === '/api/track') {
        const data = await body(req);
        if (!matches(data.orderId, /^[a-f0-9-]{36}$/) || !matches(data.trackingToken, /^[A-Za-z0-9_-]{20,}$/)) {
          throw BAD(400, 'Μη έγκυρα στοιχεία παρακολούθησης.');
        }
        const state = await store.read();
        const order = state.orders.find(o => o.id === data.orderId);
        if (!order || HASH(data.trackingToken) !== order.trackingHash) throw BAD(404, 'Η παραγγελία δεν βρέθηκε.');
        return send(res, 200, { order:publicTracking(order) });
      }
      if (pathname.startsWith('/api/ops/') || pathname.startsWith('/api/admin/')) {
        const state = await store.read();
        const allowed = pathname.startsWith('/api/admin/') ? ['admin'] : ['admin','shop','rider'];
        const role = auth(req, state, adminToken, riderToken, allowed);
        if (req.method === 'GET' && pathname === '/api/ops/orders') {
          let orders = state.orders;
          if (role.type === 'shop') orders = orders.filter(o => o.shopId === role.shopId);
          if (role.type === 'rider') orders = orders.filter(o => ['ready','picked_up'].includes(o.status));
          return send(res, 200, { role, orders:orders.slice(-100).reverse().map(o => safeOrder(o, role)) });
        }
        if (req.method === 'GET' && pathname === '/api/ops/me') {
          return send(res, 200, { role });
        }
        if (req.method === 'GET' && pathname === '/api/admin/summary') {
          return send(res, 200, summary(state));
        }
        if (req.method === 'GET' && pathname === '/api/admin/shops') {
          return send(res, 200, { shops: state.shops.map(s => ({ ...s, shopKeyHash: undefined })) });
        }
        if (req.method === 'POST' && pathname === '/api/admin/shops') {
          const data = await body(req);
          const id = clean(data.id,40);
          const name = clean(data.name,80), area = clean(data.area,60);
          if (!slug(id) || name.length < 2 || area.length < 2) throw BAD(400, 'Μη έγκυρα στοιχεία καταστήματος.');
          const shop = await store.transact(s => {
            if (s.shops.some(x => x.id === id)) throw BAD(409, 'Το κατάστημα υπάρχει ήδη.');
            const newShop = { id, name, area, active:false, deliveryFeeCents:0, products:[], shopKeyHash:null };
            s.shops.push(newShop);
            return publicShop(newShop);
          });
          return send(res, 201, { shop });
        }
        const shopMatch = /^\/api\/(?:admin|ops)\/shops\/([a-z0-9-]{2,40})\/(activate|key|products|settings)$/.exec(pathname);
        if (shopMatch && req.method === 'POST') {
          const [, shopId, action] = shopMatch;
          if (action === 'activate' || action === 'key') {
            if (role.type !== 'admin') throw BAD(403, 'Απαιτείται διαχειριστής.');
          } else shopAccess(role, shopId);
          const data = action === 'key' ? {} : await body(req);
          const result = await store.transact(s => {
            const shop = s.shops.find(x => x.id === shopId);
            if (!shop) throw BAD(404, 'Το κατάστημα δεν βρέθηκε.');
            if (action === 'key') {
              const key = crypto.randomBytes(24).toString('base64url');
              shop.shopKeyHash = HASH(key);
              return { key, message:'Εμφανίζεται μόνο μία φορά. Αποθήκευσέ το με ασφάλεια.' };
            }
            if (action === 'activate') {
              if (typeof data.active !== 'boolean') throw BAD(400,'Απαιτείται active true/false.');
              if (data.active && !shop.products.some(p => p.active)) throw BAD(400,'Πρόσθεσε ενεργά προϊόντα πρώτα.');
              shop.active = data.active;
              return { shop: publicShop(shop) };
            }
            if (action === 'settings') {
              if (!Number.isSafeInteger(data.deliveryFeeCents)) throw BAD(400,'Μη έγκυρα μεταφορικά.');
              shop.deliveryFeeCents = cents(data.deliveryFeeCents, 'deliveryFeeCents');
              return { shop:publicShop(shop) };
            }
            const name = clean(data.name,100), id = clean(data.id,40), price = data.priceCents;
            if (!slug(id) || name.length < 2 || !Number.isSafeInteger(price) || price < 1 || price > 100000) {
              throw BAD(400, 'Μη έγκυρο προϊόν ή τιμή.');
            }
            const existing = shop.products.find(p => p.id === id);
            if (existing) { existing.name = name; existing.priceCents = price; existing.active = data.active !== false; }
            else shop.products.push({ id, name, priceCents: price, active: data.active !== false });
            return { shop:publicShop(shop) };
          });
          return send(res, 200, result);
        }
        const moveMatch = /^\/api\/ops\/orders\/([a-f0-9-]{36})\/status$/.exec(pathname);
        if (req.method === 'POST' && moveMatch) {
          const data = await body(req);
          const order = await store.transact(s => {
            const o = s.orders.find(x => x.id === moveMatch[1]);
            if (!o) throw BAD(404, 'Η παραγγελία δεν βρέθηκε.');
            if (role.type === 'shop' && role.shopId !== o.shopId) throw BAD(403,'Δεν έχεις πρόσβαση.');
            if (!(transitions[o.status] || {})[data.status]?.includes(role.type)) throw BAD(409,'Μη επιτρεπτή αλλαγή κατάστασης.');
            o.status = data.status;
            o.updatedAt = now();
            o.history.push({ status:o.status, at:o.updatedAt, by:role.type });
            return safeOrder(o, role);
          });
          return send(res, 200, { order });
        }
        if (req.method === 'POST' && pathname === '/api/admin/expenses') {
          const data = await body(req);
          if (!Number.isSafeInteger(data.amountCents) || data.amountCents < 1) throw BAD(400,'Μη έγκυρο ποσό.');
          const label = clean(data.label,100);
          if (label.length < 2) throw BAD(400,'Απαιτείται περιγραφή.');
          const expense = await store.transact(s => {
            const e = { id:uuid(), label, amountCents:cents(data.amountCents,'amountCents'), date:now() };
            s.expenses.push(e); return e;
          });
          return send(res,201,{ expense });
        }
      }
      if (req.method === 'GET' && !pathname.startsWith('/api/')) return await readStatic(pathname,res);
      throw BAD(404,'Δεν βρέθηκε.');
    } catch (error) {
      if (!error.status) console.error('Request failed:', error);
      if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Εσωτερικό σφάλμα.' });
    }
  });
  return { server, store, credentials: { adminToken, riderToken } };
}
if (require.main === module) {
  createApp().then(({server,credentials,store}) => {
    const port = Number(process.env.PORT || 3000);
    server.listen(port, '0.0.0.0', () => {
      console.log('Fair Delivery pilot v2 listening on', port, 'store:', store.kind);
      if (process.env.NODE_ENV !== 'production') {
        console.log('Local ADMIN_TOKEN:', credentials.adminToken);
        console.log('Local RIDER_TOKEN:', credentials.riderToken);
      }
    });
  }).catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
}
module.exports = { createApp };
