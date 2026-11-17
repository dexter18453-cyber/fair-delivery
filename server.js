'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Tiny .env reader: no dependency needed. Real environment variables win.
function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.RENDER ? '0.0.0.0' : '127.0.0.1');
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || './data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const DEMO_MODE = process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
const requestWindows = new Map();
const aiWindows = new Map();
const authWindows = new Map();

const DEFAULT_SETTINGS = {
  currency: 'EUR',
  customerServiceFee: 1.79,
  shopDeliveryFee: 0,
  shopCommissionPercent: 0,
  riderBaseAmount: 2.50,
  riderPerKm: 0.80,
  badWeatherBonus: 1.50,
  storeLocation: null
};

const DEFAULT_PRODUCTS = [
  { id: 'demo-souvlaki', name: 'Πίτα κοτόπουλο', description: 'Δοκιμαστικό προϊόν — άλλαξέ το με το πραγματικό μενού.', price: 4.90, category: 'Φαγητό', active: true },
  { id: 'demo-pizza', name: 'Πίτσα μαργαρίτα', description: 'Δοκιμαστικό προϊόν.', price: 6.50, category: 'Φαγητό', active: true },
  { id: 'demo-coffee', name: 'Καφές φίλτρου', description: 'Δοκιμαστικό προϊόν.', price: 2.50, category: 'Καφές', active: true }
];

let state;
let writeQueue = Promise.resolve();
let postgresPool = null;

function normalizeState(parsed = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) };
  // This is a one-time pricing migration. Later admin edits must not be overridden.
  if (settings.pricingVersion !== 2) {
    settings.customerServiceFee = 1.79;
    settings.shopCommissionPercent = 0;
    settings.pricingVersion = 2;
  }
  return {
    settings,
    products: Array.isArray(parsed.products) ? parsed.products : DEFAULT_PRODUCTS,
    orders: Array.isArray(parsed.orders) ? parsed.orders : [],
    riders: parsed.riders && typeof parsed.riders === 'object' ? parsed.riders : {},
    shopCredential: parsed.shopCredential || null
  };
}

function round2(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function nowIso() { return new Date().toISOString(); }
function publicOrder(order) {
  if (!order) return null;
  return {
    id: order.id, items: order.items, subtotal: order.subtotal, serviceFee: order.serviceFee,
    deliveryFee: order.deliveryFee || 0,
    total: order.total, status: order.status, createdAt: order.createdAt, updatedAt: order.updatedAt,
    estimatedKm: order.estimatedKm ?? null, badWeather: Boolean(order.badWeather),
    riderPayEstimate: order.riderPayEstimate ?? null,
    deliveryLocation: order.deliveryLocation || null,
    riderLocation: ['assigned', 'picked_up'].includes(order.status) && state.riders[order.assignedRider]?.online ? order.riderLocation || null : null
  };
}

// Private delivery data is returned only to authenticated shop/rider/admin sessions.
function privateOrder(order) {
  const rider = order.assignedRider ? state.riders[order.assignedRider] : null;
  return {
    ...publicOrder(order),
    customerName: order.customerName || '',
    customerPhone: order.customerPhone || '',
    deliveryAddress: order.deliveryAddress || '',
    deliveryManagedByShop: Boolean(order.deliveryManagedByShop),
    assignedRider: order.assignedRider || null,
    assignedRiderName: rider?.name || order.assignedRiderName || null
  };
}

function riderCodeHash(code, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(String(code), salt, 64, (error, hash) => error ? reject(error) : resolve(hash.toString('hex'))));
}

function riderProfile(rider) {
  return { id: rider.id, name: rider.name, online: Boolean(rider.online), storeId: rider.storeId || 'default' };
}

function validPoint(point) {
  return point && typeof point.lat === 'number' && typeof point.lng === 'number' &&
    Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;
}

function hideRiderLocation(riderId) {
  for (const order of state.orders) if (order.assignedRider === riderId) order.riderLocation = null;
}

async function initState() {
  if (process.env.RENDER && !DATABASE_URL) {
    throw new Error('Ασφαλής εκκίνηση: απαιτείται DATABASE_URL σε Render. Χωρίς μόνιμη βάση η νέα έκδοση θα έχανε λογαριασμούς και παραγγελίες.');
  }
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    postgresPool = new Pool({ connectionString: DATABASE_URL, max: 3, connectionTimeoutMillis: 7000 });
    await postgresPool.query('CREATE TABLE IF NOT EXISTS fair_delivery_state (id INTEGER PRIMARY KEY CHECK (id = 1), body JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    // If a persistent record exists, it is always authoritative over ephemeral files.
    const existing = await postgresPool.query('SELECT body FROM fair_delivery_state WHERE id = 1');
    if (existing.rows.length) {
      state = normalizeState(existing.rows[0].body);
    } else {
      let legacy = {};
      try { legacy = JSON.parse(await fs.promises.readFile(STATE_FILE, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (process.env.RENDER && !Object.keys(legacy).length && process.env.ALLOW_EMPTY_PRODUCTION_STATE !== 'true') {
        throw new Error('Ασφαλής εκκίνηση: η PostgreSQL δεν περιέχει δεδομένα. Πρώτα μετέφερε το παλιό state ή όρισε συνειδητά ALLOW_EMPTY_PRODUCTION_STATE=true για εντελώς νέο πιλοτικό περιβάλλον.');
      }
      state = normalizeState(legacy);
    }
    // Remove only synthetic orders that were accidentally written by an earlier
    // build-time smoke test inheriting DATABASE_URL. Preserve all other orders.
    if (process.env.RENDER && state.settings.pilotSmokeCleanupVersion !== 1) {
      const fake = order => (
        (order.customerName === 'Test Customer' && order.customerPhone === '6900000000') ||
        (order.customerName === 'Second Customer' && order.customerPhone === '6900000001')
      );
      if (state.orders.some(fake)) {
        state.orders = state.orders.filter(order => !fake(order));
        for (const [id, rider] of Object.entries(state.riders)) {
          if (rider.name === 'Test Rider') delete state.riders[id];
        }
        state.products = state.products.filter(p => p.name !== 'Test Souvlaki');
        state.settings.shopDeliveryFee = 0;
        state.shopCredential = null;
        state.settings.pilotSmokeCleanupVersion = 1;
        console.log('[FairDelivery] Removed synthetic build-test data from pilot PostgreSQL');
      }
    }
    await persistState();
    return;
  }
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.promises.readFile(STATE_FILE, 'utf8'));
    state = normalizeState(parsed);
    await persistState();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = normalizeState();
    await persistState();
  }
}

function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(async () => {
    if (postgresPool) {
      await postgresPool.query('INSERT INTO fair_delivery_state (id, body) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()', [snapshot]);
      return;
    }
    const temp = `${STATE_FILE}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, snapshot, { mode: 0o600 });
    await fs.promises.rename(temp, STATE_FILE);
  });
  return writeQueue;
}

function sendJson(res, status, data, extraHeaders = {}) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(payload);
}

function readJson(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk.toString('utf8');
      if (Buffer.byteLength(raw) > maxBytes) {
        reject(Object.assign(new Error('Το αίτημα είναι πολύ μεγάλο.'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const body = raw ? JSON.parse(raw) : {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected JSON object');
        resolve(body);
      }
      catch { reject(Object.assign(new Error('Μη έγκυρο JSON.'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function getSession(req, roleHint) {
  const cookies = parseCookies(req.headers.cookie || '');
  const roles = ['admin', 'shop', 'rider'];
  const ordered = roles.includes(roleHint) ? [roleHint] : roles;
  for (const role of ordered) {
    const token = cookies[`fd_${role}_session`];
    if (!token) continue;
    const session = sessions.get(token);
    if (!session || session.expiresAt < Date.now()) { sessions.delete(token); continue; }
    if (session.role === role) return { ...session, token };
  }
  return null;
}

function requireRole(req, res, allowedRoles) {
  const roleHint = String(req.headers['x-fd-role'] || '');
  if (roleHint && !allowedRoles.includes(roleHint)) {
    sendJson(res, 401, { error: 'Χρειάζεται σύνδεση με κατάλληλο λογαριασμό.' });
    return null;
  }
  const session = getSession(req, roleHint || undefined);
  if (!session || !allowedRoles.includes(session.role)) {
    sendJson(res, 401, { error: 'Χρειάζεται σύνδεση με κατάλληλο λογαριασμό.' });
    return null;
  }
  return session;
}

function rateLimit(map, key, max, windowMs) {
  const now = Date.now();
  let entry = map.get(key);
  if (!entry || now - entry.startedAt > windowMs) entry = { startedAt: now, count: 0 };
  entry.count += 1; map.set(key, entry);
  return entry.count <= max;
}

function clientIp(req) {
  // Do not trust arbitrary X-Forwarded-For values unless running behind Render.
  return process.env.RENDER ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown' : req.socket.remoteAddress || 'local';
}

function roleCode(role) {
  if (DEMO_MODE) return 'demo';
  const envName = { shop: 'SHOP_ACCESS_CODE', rider: 'RIDER_ACCESS_CODE', admin: 'ADMIN_ACCESS_CODE' }[role];
  return envName ? process.env[envName] : '';
}

async function shopCodeMatches(input) {
  if (DEMO_MODE && input === 'demo') return true;
  if (state.shopCredential?.codeSalt && state.shopCredential?.codeHash) {
    const hash = await riderCodeHash(input, state.shopCredential.codeSalt);
    return safeEqual(hash, state.shopCredential.codeHash);
  }
  return safeEqual(input, roleCode('shop'));
}

function validateMoney(value, name, max = 5000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw Object.assign(new Error(`${name}: ποσό εκτός ορίων.`), { statusCode: 400 });
  return round2(n);
}

function offlineHelp(question) {
  const q = question.toLocaleLowerCase('el-GR');
  const fee = `${state.settings.customerServiceFee.toFixed(2).replace('.', ',')} ευρώ`;
  if (/κωδικ|συνδε|λογαριασ|διανομ|rider/.test(q)) {
    return `Σύνδεση: ο διαχειριστής μπαίνει στο Control Center. Από εκεί εκδίδει νέο κωδικό καταστήματος. Το κατάστημα δημιουργεί κάθε διανομέα και του δίνει προσωπικό ID και κωδικό. Οι διανομείς δεν έχουν κοινό κωδικό. ${postgresPool ? 'Η βάση PostgreSQL είναι ενεργή.' : 'ΠΡΟΣΟΧΗ: η βάση είναι προσωρινή· οι λογαριασμοί μπορεί να χαθούν μετά από restart.'}`;
  }
  if (/κοστο|χρεω|κερδ|φορο|φπα|τιμ|price|fee/.test(q)) {
    return `Η δοκιμαστική χρέωση Fair Delivery είναι ${fee} ανά παραγγελία, με προμήθεια καταστήματος 0%. Η διανομή του καταστήματος είναι ${state.settings.shopDeliveryFee.toFixed(2).replace('.', ',')} ευρώ. Αυτά είναι μικτά ποσά, όχι καθαρό κέρδος. Για πραγματικούς φόρους, ΦΠΑ, παραστατικά και πληρωμές χρειάζεται λογιστική έγκριση πριν από εμπορική λειτουργία.`;
  }
  if (/παραγγελ|ακυρω|καταστημ|πελατ/.test(q)) {
    return 'Η δοκιμαστική παραγγελία πηγαίνει από τον πελάτη στο κατάστημα: νέα → αποδοχή → ετοιμασία → ανάθεση στον διανομέα του καταστήματος → παραλαβή → παράδοση. Σε ακύρωση απαιτείται καταγραφή της αιτίας και, πριν από πραγματικές πληρωμές, ξεκάθαρη πολιτική επιστροφών.';
  }
  if (/ai|τεχνητ|openai|api/.test(q)) {
    return 'Ο πραγματικός AI βοηθός ενεργοποιείται μόνο με OPENAI_API_KEY και OPENAI_MODEL στο Render. Η συνδρομή ChatGPT δεν αρκεί για το API και υπάρχει ξεχωριστή χρέωση. Μέχρι τότε λειτουργώ ως περιορισμένος οδηγός της εφαρμογής, χωρίς δημιουργία απαντήσεων από μοντέλο AI.';
  }
  return 'Αυτή τη στιγμή λειτουργώ ως βασικός οδηγός, όχι ως μοντέλο AI. Μπορώ να εξηγήσω: (1) σύνδεση καταστήματος και διανομέων, (2) ροή παραγγελίας, (3) χρεώσεις και φόρους, (4) σύνδεση OpenAI. Για ελεύθερες ερωτήσεις χρειάζεται ενεργή σύνδεση API.';
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'Fair Delivery', version: '1.3.0', mode: DEMO_MODE ? 'local-demo' : 'pilot', aiConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL), storage: postgresPool ? 'postgres' : 'temporary-file' });
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    if (!rateLimit(authWindows, clientIp(req), 20, 15 * 60_000)) return sendJson(res, 429, { error: 'Πολλές προσπάθειες σύνδεσης. Δοκίμασε ξανά αργότερα.' });
    const body = await readJson(req, 4096);
    const role = ['shop', 'rider', 'admin'].includes(body.role) ? body.role : '';
    if (!role) return sendJson(res, 400, { error: 'Μη έγκυρος ρόλος.' });

    let userId = `${role}-${crypto.randomUUID()}`;
    let storeId = 'default';
    let riderName = null;

    if (role === 'rider') {
      const riderId = String(body.riderId || '');
      const rider = state.riders[riderId];
      if (!rider || rider.active === false || !rider.codeSalt || !rider.codeHash) {
        return sendJson(res, 401, { error: 'Αυτό το ID δεν ανήκει σε ενεργό διανομέα. Το κατάστημα πρέπει να δημιουργήσει νέο λογαριασμό ή να ελέγξει το ID. Οι παλιοί κωδικοί πριν από την έκδοση 1.2 δεν ισχύουν.' });
      }
      const suppliedHash = await riderCodeHash(String(body.code || ''), rider.codeSalt);
      if (!safeEqual(suppliedHash, rider.codeHash)) return sendJson(res, 401, { error: 'Λάθος κωδικός διανομέα.' });
      userId = rider.id;
      storeId = rider.storeId || 'default';
      riderName = rider.name;
    } else {
      const expected = roleCode(role);
      if (role === 'shop') {
        if (!state.shopCredential && !expected) return sendJson(res, 503, { error: 'Δεν υπάρχει κωδικός καταστήματος. Ο διαχειριστής μπορεί να δημιουργήσει νέο από το Control Center.' });
        if (!(await shopCodeMatches(String(body.code || '')))) return sendJson(res, 401, { error: 'Λάθος κωδικός καταστήματος. Μπορείς να εκδώσεις νέο από το Control Center.' });
      } else {
        if (!expected) return sendJson(res, 503, { error: 'Δεν έχει οριστεί κωδικός διαχειριστή στον server.' });
        if (!safeEqual(String(body.code || ''), expected)) return sendJson(res, 401, { error: 'Λάθος κωδικός διαχειριστή.' });
      }
    }

    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { role, userId, storeId, expiresAt: Date.now() + SESSION_TTL_MS });
    const secure = process.env.NODE_ENV === 'production' || process.env.RENDER ? '; Secure' : '';
    return sendJson(res, 200, { ok: true, role, userId, riderName, expiresInSeconds: SESSION_TTL_MS / 1000 }, { 'Set-Cookie': `fd_${role}_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}` });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const body = await readJson(req, 1024);
    const role = ['shop', 'rider', 'admin'].includes(body.role) ? body.role : '';
    const session = role ? getSession(req, role) : null;
    if (session) {
      sessions.delete(session.token);
      if (session.role === 'rider' && state.riders[session.userId]) {
        state.riders[session.userId].online = false;
        hideRiderLocation(session.userId);
        await persistState();
      }
    }
    const cookieName = role ? `fd_${role}_session` : 'fd_admin_session';
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    const roleHint = String(req.headers['x-fd-role'] || '');
    const session = getSession(req, roleHint);
    return sendJson(res, 200, { authenticated: Boolean(session), role: session?.role || null });
  }

  if (method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, { settings: state.settings, storeLocation: state.settings.storeLocation || null, demoMode: DEMO_MODE });
  }

  if (method === 'GET' && pathname === '/api/products') {
    return sendJson(res, 200, { products: state.products.filter(p => p.active) });
  }

  if (pathname === '/api/shop/products' && ['GET', 'POST'].includes(method)) {
    const session = requireRole(req, res, ['shop', 'admin']); if (!session) return;
    if (method === 'GET') return sendJson(res, 200, { products: state.products });
    const body = await readJson(req, 4096);
    if (state.products.length >= 200) return sendJson(res, 409, { error: 'Το πιλοτικό δέχεται έως 200 προϊόντα.' });
    const name = String(body.name || '').trim();
    const category = String(body.category || 'Μενού').trim();
    const description = String(body.description || '').trim();
    if (name.length < 2 || name.length > 100 || !category || category.length > 60 || description.length > 500) return sendJson(res, 400, { error: 'Έλεγξε όνομα, κατηγορία και περιγραφή προϊόντος.' });
    if (typeof body.price !== 'number') return sendJson(res, 400, { error: 'Δώσε έγκυρη τιμή προϊόντος.' });
    const product = { id: crypto.randomUUID(), name, category, description, price: validateMoney(body.price, 'Τιμή προϊόντος'), active: body.active !== false };
    state.products.push(product);
    await persistState();
    return sendJson(res, 201, { product });
  }

  const productMutation = pathname.match(/^\/api\/shop\/products\/([a-zA-Z0-9-]+)$/);
  if (method === 'PATCH' && productMutation) {
    const session = requireRole(req, res, ['shop', 'admin']); if (!session) return;
    const product = state.products.find(p => p.id === productMutation[1]);
    if (!product) return sendJson(res, 404, { error: 'Το προϊόν δεν βρέθηκε.' });
    const body = await readJson(req, 4096);
    const updated = { ...product };
    for (const key of ['name', 'category', 'description']) if (body[key] !== undefined) {
      if (typeof body[key] !== 'string') return sendJson(res, 400, { error: 'Μη έγκυρο κείμενο προϊόντος.' });
      const v = body[key].trim();
      if ((key === 'name' && (v.length < 2 || v.length > 100)) || (key === 'category' && (!v || v.length > 60)) || (key === 'description' && v.length > 500)) return sendJson(res, 400, { error: 'Μη έγκυρο όνομα, κατηγορία ή περιγραφή.' });
      updated[key] = v;
    }
    if (body.price !== undefined) {
      if (typeof body.price !== 'number') return sendJson(res, 400, { error: 'Μη έγκυρη τιμή.' });
      updated.price = validateMoney(body.price, 'Τιμή προϊόντος');
    }
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') return sendJson(res, 400, { error: 'Η διαθεσιμότητα πρέπει να είναι ναι ή όχι.' });
      updated.active = body.active;
    }
    Object.assign(product, updated);
    await persistState();
    return sendJson(res, 200, { product });
  }

  if (method === 'POST' && pathname === '/api/orders') {
    const ip = clientIp(req);
    if (!rateLimit(requestWindows, `orders:${ip}`, 10, 60_000)) return sendJson(res, 429, { error: 'Πολλές δοκιμαστικές παραγγελίες. Περίμενε ένα λεπτό.' });
    const body = await readJson(req, 12 * 1024);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) return sendJson(res, 400, { error: 'Το καλάθι δεν είναι έγκυρο.' });

    const customerName = String(body.customerName || '').trim();
    const customerPhone = String(body.customerPhone || '').trim();
    const deliveryAddress = String(body.deliveryAddress || '').trim();
    const location = body.deliveryLocation || {};
    const deliveryLat = Number(location.lat);
    const deliveryLng = Number(location.lng);
    if (customerName.length < 2 || customerName.length > 80) return sendJson(res, 400, { error: 'Συμπλήρωσε έγκυρο όνομα πελάτη.' });
    if (customerPhone.length < 6 || customerPhone.length > 30) return sendJson(res, 400, { error: 'Συμπλήρωσε έγκυρο τηλέφωνο επικοινωνίας.' });
    if (deliveryAddress.length < 5 || deliveryAddress.length > 240) return sendJson(res, 400, { error: 'Συμπλήρωσε τη διεύθυνση παράδοσης.' });
    if (body.privacyConsent !== true) return sendJson(res, 400, { error: 'Χρειάζεται συγκατάθεση για τη χρήση των στοιχείων παράδοσης στην πιλοτική παραγγελία.' });
    if (!validPoint(location)) {
      return sendJson(res, 400, { error: 'Επίλεξε σημείο παράδοσης στον χάρτη.' });
    }

    const lines = [];
    for (const row of body.items) {
      if (!row || typeof row !== 'object') return sendJson(res, 400, { error: 'Μη έγκυρο προϊόν ή ποσότητα.' });
      const product = state.products.find(p => p.id === String(row.productId) && p.active);
      const qty = Number(row.qty);
      if (!product || !Number.isInteger(qty) || qty < 1 || qty > 20) return sendJson(res, 400, { error: 'Μη έγκυρο προϊόν ή ποσότητα.' });
      lines.push({ productId: product.id, name: product.name, unitPrice: product.price, qty, lineTotal: round2(product.price * qty) });
    }
    const subtotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
    const order = {
      id: crypto.randomUUID(), storeId: 'default', items: lines, subtotal,
      customerName, customerPhone, deliveryAddress,
      deliveryLocation: { lat: deliveryLat, lng: deliveryLng },
      serviceFee: round2(state.settings.customerServiceFee), deliveryFee: round2(state.settings.shopDeliveryFee),
      total: round2(subtotal + state.settings.customerServiceFee + state.settings.shopDeliveryFee),
      status: 'new', createdAt: nowIso(), updatedAt: nowIso(),
      estimatedKm: null, badWeather: false, riderPayEstimate: null,
      assignedRider: null, assignedRiderName: null, riderLocation: null, deliveryManagedByShop: false
    };
    state.orders.push(order); await persistState();
    return sendJson(res, 201, { order: publicOrder(order), trackingUrl: `/app/customer/?order=${encodeURIComponent(order.id)}` });
  }

  const publicTracking = pathname.match(/^\/api\/orders\/([0-9a-f-]+)$/i);
  if (method === 'GET' && publicTracking) {
    const order = state.orders.find(item => item.id === publicTracking[1]);
    return order ? sendJson(res, 200, { order: publicOrder(order) }) : sendJson(res, 404, { error: 'Η παραγγελία δεν βρέθηκε.' });
  }

  if (method === 'GET' && pathname === '/api/orders') {
    const session = requireRole(req, res, ['shop', 'rider', 'admin']); if (!session) return;
    let orders = state.orders.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (session.role === 'rider') orders = orders.filter(o => ['assigned', 'picked_up'].includes(o.status) && o.assignedRider === session.userId);
    if (session.role === 'shop') orders = orders.filter(o => (o.storeId || 'default') === (session.storeId || 'default'));
    return sendJson(res, 200, { orders: orders.map(privateOrder) });
  }

  const orderMutation = pathname.match(/^\/api\/orders\/([0-9a-f-]+)$/i);
  if (method === 'PATCH' && orderMutation) {
    const session = requireRole(req, res, ['shop', 'rider', 'admin']); if (!session) return;
    const body = await readJson(req, 4096);
    const order = state.orders.find(item => item.id === orderMutation[1]);
    if (!order) return sendJson(res, 404, { error: 'Η παραγγελία δεν βρέθηκε.' });
    if (session.role === 'shop' && (order.storeId || 'default') !== session.storeId) return sendJson(res, 403, { error: 'Η παραγγελία ανήκει σε άλλο κατάστημα.' });
    const status = String(body.status || '');
    const transitions = {
      shop: { new: ['accepted', 'cancelled'], accepted: ['ready', 'cancelled'], ready: ['assigned', 'cancelled'], assigned: ['delivered'] },
      rider: { assigned: ['picked_up'], picked_up: ['delivered'] },
      admin: { new: ['accepted', 'cancelled'], accepted: ['ready', 'cancelled'], ready: ['assigned', 'cancelled'], assigned: ['picked_up', 'cancelled'], picked_up: ['delivered', 'cancelled'] }
    };
    if (!(transitions[session.role]?.[order.status] || []).includes(status)) return sendJson(res, 409, { error: `Δεν επιτρέπεται η μετάβαση ${order.status} → ${status} για τον ρόλο ${session.role}.` });
    if (session.role === 'rider' && order.assignedRider !== session.userId) return sendJson(res, 403, { error: 'Η παραγγελία δεν έχει ανατεθεί στον δικό σου λογαριασμό.' });
    if (session.role === 'shop' && status === 'delivered' && !order.deliveryManagedByShop) return sendJson(res, 403, { error: 'Την παράδοση αυτή πρέπει να ολοκληρώσει ο συνδεδεμένος διανομέας.' });
    let assignedRider = null;
    const shopManagedDelivery = status === 'assigned' && body.storeDelivery === true;
    if (status === 'assigned') {
      if (!['shop', 'admin'].includes(session.role)) return sendJson(res, 403, { error: 'Η ανάθεση γίνεται από το κατάστημα.' });
      if (!shopManagedDelivery) {
        const riderId = String(body.riderId || '');
        const rider = state.riders[riderId];
        if (!rider || rider.active === false || rider.storeId !== (session.storeId || 'default')) return sendJson(res, 400, { error: 'Επίλεξε ενεργό διανομέα του καταστήματος.' });
        assignedRider = rider;
      }
    }
    let estimatedKm = order.estimatedKm;
    if (body.estimatedKm !== undefined) {
      const km = Number(body.estimatedKm);
      if (typeof body.estimatedKm !== 'number' || !Number.isFinite(km) || km < 0 || km > 100) return sendJson(res, 400, { error: 'Τα χιλιόμετρα πρέπει να είναι από 0 έως 100.' });
      estimatedKm = round2(km);
    }
    if (body.badWeather !== undefined && typeof body.badWeather !== 'boolean') return sendJson(res, 400, { error: 'Η ένδειξη κακοκαιρίας πρέπει να είναι true ή false.' });
    order.estimatedKm = estimatedKm;
    if (assignedRider) { order.assignedRider = assignedRider.id; order.assignedRiderName = assignedRider.name; }
    if (status === 'assigned') order.deliveryManagedByShop = shopManagedDelivery;
    if (body.badWeather !== undefined) order.badWeather = body.badWeather;
    if (status === 'delivered' && !order.deliveryManagedByShop && Number.isFinite(order.estimatedKm)) {
      order.riderPayEstimate = round2(state.settings.riderBaseAmount + order.estimatedKm * state.settings.riderPerKm + (order.badWeather ? state.settings.badWeatherBonus : 0));
    }
    order.status = status; order.updatedAt = nowIso();
    if (['delivered', 'cancelled'].includes(status)) order.riderLocation = null;
    await persistState();
    return sendJson(res, 200, { order: privateOrder(order) });
  }

  if (method === 'GET' && pathname === '/api/stats') {
    const session = requireRole(req, res, ['admin']); if (!session) return;
    const today = new Date().toISOString().slice(0, 10);
    const todayOrders = state.orders.filter(o => o.createdAt.startsWith(today));
    return sendJson(res, 200, {
      activeOrders: state.orders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
      ordersToday: todayOrders.length,
      deliveredToday: todayOrders.filter(o => o.status === 'delivered').length,
      grossValueToday: round2(todayOrders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.subtotal, 0)),
      shopsCommissionToday: round2(todayOrders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.subtotal * state.settings.shopCommissionPercent / 100, 0)),
      riderCountOnline: Object.values(state.riders).filter(r => r.online).length,
      platformFeeToday: round2(todayOrders.filter(o => o.status === 'delivered').reduce((s, o) => s + o.serviceFee, 0))
    });
  }

  if (method === 'PATCH' && pathname === '/api/settings') {
    const session = requireRole(req, res, ['admin']); if (!session) return;
    const body = await readJson(req, 4096);
    const allowed = ['customerServiceFee', 'shopDeliveryFee', 'shopCommissionPercent', 'riderBaseAmount', 'riderPerKm', 'badWeatherBonus'];
    const settings = { ...state.settings };
    for (const key of allowed) {
      if (body[key] !== undefined) {
        const value = Number(body[key]);
        const max = key === 'shopCommissionPercent' ? 100 : 1000;
        if (!Number.isFinite(value) || value < 0 || value > max) return sendJson(res, 400, { error: `Μη έγκυρη τιμή για ${key}.` });
        if (key === 'shopCommissionPercent' && value !== 0) return sendJson(res, 400, { error: 'Στο πιλοτικό Fair Delivery η προμήθεια καταστήματος παραμένει 0%.' });
        settings[key] = round2(value);
      }
    }
    state.settings = settings;
    await persistState();
    return sendJson(res, 200, { settings: state.settings });
  }

  if (method === 'POST' && pathname === '/api/admin/shop-code') {
    const session = requireRole(req, res, ['admin']); if (!session) return;
    const accessCode = crypto.randomBytes(18).toString('base64url');
    const codeSalt = crypto.randomBytes(16).toString('hex');
    state.shopCredential = { codeSalt, codeHash: await riderCodeHash(accessCode, codeSalt), updatedAt: nowIso() };
    await persistState();
    return sendJson(res, 200, { accessCode, warning: postgresPool ? null : 'Προσοχή: χωρίς μόνιμη βάση ο κωδικός χάνεται σε νέο deployment.' });
  }

  if ((method === 'GET' || method === 'POST') && pathname === '/api/shop/riders') {
    const session = requireRole(req, res, ['shop', 'admin']); if (!session) return;
    const storeId = session.storeId || 'default';
    if (method === 'GET') {
      const riders = Object.values(state.riders)
        .filter(r => r.id && (r.storeId || 'default') === storeId)
        .map(r => ({ id: r.id, name: r.name, active: r.active !== false, online: Boolean(r.online), lat: r.lat ?? null, lng: r.lng ?? null, updatedAt: r.updatedAt || null }));
      return sendJson(res, 200, { riders });
    }
    const body = await readJson(req, 4096);
    const name = String(body.name || '').trim();
    if (name.length < 2 || name.length > 80) return sendJson(res, 400, { error: 'Το όνομα οδηγού πρέπει να έχει 2 έως 80 χαρακτήρες.' });
    const id = crypto.randomUUID();
    const accessCode = crypto.randomBytes(9).toString('base64url');
    const salt = crypto.randomBytes(16).toString('hex');
    state.riders[id] = { id, name, storeId, codeSalt: salt, codeHash: await riderCodeHash(accessCode, salt), active: true, online: false, createdAt: nowIso(), updatedAt: nowIso() };
    await persistState();
    return sendJson(res, 201, { rider: { id, name, active: true, online: false }, accessCode });
  }

  const resetRiderCode = pathname.match(/^\/api\/shop\/riders\/([0-9a-f-]+)\/reset-code$/i);
  if (method === 'POST' && resetRiderCode) {
    const session = requireRole(req, res, ['shop', 'admin']); if (!session) return;
    const rider = state.riders[resetRiderCode[1]];
    if (!rider || (rider.storeId || 'default') !== session.storeId) return sendJson(res, 404, { error: 'Ο διανομέας δεν βρέθηκε στο κατάστημα.' });
    const accessCode = crypto.randomBytes(12).toString('base64url');
    const codeSalt = crypto.randomBytes(16).toString('hex');
    rider.codeSalt = codeSalt;
    rider.codeHash = await riderCodeHash(accessCode, codeSalt);
    rider.updatedAt = nowIso();
    for (const [token, oldSession] of sessions) if (oldSession.role === 'rider' && oldSession.userId === rider.id) sessions.delete(token);
    await persistState();
    return sendJson(res, 200, { riderId: rider.id, accessCode, warning: postgresPool ? null : 'Χωρίς μόνιμη βάση ο κωδικός μπορεί να χαθεί σε νέο deployment.' });
  }

  if (method === 'POST' && pathname === '/api/shop/location') {
    const session = requireRole(req, res, ['shop', 'admin']); if (!session) return;
    const body = await readJson(req, 4096);
    const lat = Number(body.lat); const lng = Number(body.lng);
    if (!validPoint(body)) return sendJson(res, 400, { error: 'Μη έγκυρες συντεταγμένες καταστήματος.' });
    state.settings.storeLocation = { lat, lng, updatedAt: nowIso() };
    await persistState();
    return sendJson(res, 200, { storeLocation: state.settings.storeLocation });
  }

  if (method === 'POST' && pathname === '/api/shop/delivery-fee') {
    const session = requireRole(req, res, ['shop', 'admin']); if (!session) return;
    const body = await readJson(req, 4096);
    if (typeof body.deliveryFee !== 'number') return sendJson(res, 400, { error: 'Δώσε το κόστος διανομής σε ευρώ.' });
    state.settings.shopDeliveryFee = validateMoney(body.deliveryFee, 'Κόστος διανομής', 50);
    await persistState();
    return sendJson(res, 200, { deliveryFee: state.settings.shopDeliveryFee });
  }

  if (method === 'GET' && pathname === '/api/rider/profile') {
    const session = requireRole(req, res, ['rider']); if (!session) return;
    const rider = state.riders[session.userId];
    if (!rider) return sendJson(res, 404, { error: 'Δεν βρέθηκε το προφίλ διανομέα.' });
    return sendJson(res, 200, { rider: riderProfile(rider) });
  }

  if (method === 'POST' && pathname === '/api/rider/status') {
    const session = requireRole(req, res, ['rider']); if (!session) return;
    const body = await readJson(req, 4096);
    if (typeof body.online !== 'boolean') return sendJson(res, 400, { error: 'Η κατάσταση online πρέπει να είναι true ή false.' });
    state.riders[session.userId] = { ...(state.riders[session.userId] || {}), online: body.online, updatedAt: nowIso() };
    if (!body.online) hideRiderLocation(session.userId);
    await persistState();
    return sendJson(res, 200, { rider: riderProfile(state.riders[session.userId]) });
  }

  if (method === 'POST' && pathname === '/api/rider/location') {
    const session = requireRole(req, res, ['rider']); if (!session) return;
    const body = await readJson(req, 4096); const lat = Number(body.lat); const lng = Number(body.lng);
    if (!validPoint(body)) return sendJson(res, 400, { error: 'Μη έγκυρες συντεταγμένες.' });
    if (!state.riders[session.userId]?.online) return sendJson(res, 409, { error: 'Ενεργοποίησε πρώτα τη διαθεσιμότητά σου.' });
    state.riders[session.userId] = { ...state.riders[session.userId], lat, lng, updatedAt: nowIso() };
    for (const order of state.orders) if (order.assignedRider === session.userId && !['delivered', 'cancelled'].includes(order.status)) order.riderLocation = { lat, lng, updatedAt: nowIso() };
    await persistState();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/assistant') {
    const session = requireRole(req, res, ['admin']); if (!session) return;
    if (!rateLimit(aiWindows, session.userId, Number(process.env.AI_MAX_REQUESTS_PER_10_MIN || 10), 10 * 60 * 1000)) return sendJson(res, 429, { error: 'Έφτασες το όριο ερωτήσεων. Δοκίμασε ξανά σε λίγο.' });
    const body = await readJson(req, 12 * 1024);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 2000) return sendJson(res, 400, { error: 'Γράψε ερώτηση έως 2.000 χαρακτήρες.' });
    if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) return sendJson(res, 200, { answer: offlineHelp(message), mode: 'guide' });
    const history = Array.isArray(body.history) ? body.history.slice(-8).map(m => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content || '').slice(0, 1000) })).filter(m => m.content) : [];
    const instructions = [
      'Είσαι ο τεχνικός βοηθός του ανεξάρτητου project Fair Delivery. Απαντάς στα ελληνικά, με πρακτικά μικρά βήματα.',
      'Το project είναι σε πιλοτικό στάδιο. Ξεχώριζε δοκιμαστικά δεδομένα από πραγματικά δεδομένα. Μην παρουσιάζεις τις ενδεικτικές χρεώσεις ως επίσημους κανόνες άλλης πλατφόρμας.',
      'Αρχιτεκτονική: Node.js built-in HTTP server, JSON persistence σε DATA_DIR/state.json, σελίδες public/index.html (admin), customer-app.html, shop-app.html, Rider-App.html, κοινά assets/app.css και assets/common.js. Ροή παραγγελίας: new → accepted → ready → assigned → picked_up → delivered. Ρόλοι: shop, rider, admin. API: /api/orders, /api/products, /api/stats, /api/settings, /api/rider/status, /api/rider/location, /api/assistant.',
      'Το JSON store είναι για ένα instance/πιλοτικό περιβάλλον, όχι για οριζόντια κλιμάκωση. Για πραγματική παραγωγή πρότεινε PostgreSQL, managed backups, πραγματική ταυτοποίηση χρηστών, tenant isolation ανά κατάστημα, payment provider και security/privacy review.',
      'Μην βοηθάς σε αντιγραφή ιδιόκτητου κώδικα, ιδιωτικά endpoints, παράκαμψη ελέγχων, αυτοματοποιημένη αποδοχή παραγγελιών τρίτης εφαρμογής ή αλλοίωση πληρωμών. Πρότεινε δική μας υλοποίηση και εξουσιοδοτημένες διασυνδέσεις.',
      'Μη ζητάς κωδικούς, API keys, ονόματα/τηλέφωνα πελατών ή ακριβείς διευθύνσεις.'
    ].join('\n');
    try {
      const apiResponse = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.OPENAI_MODEL, instructions, input: [...history, { role: 'user', content: message }], max_output_tokens: 700 })
      });
      const result = await apiResponse.json().catch(() => ({}));
      if (!apiResponse.ok) return sendJson(res, 502, { error: result?.error?.message || `AI provider HTTP ${apiResponse.status}` });
      const answer = result.output_text || (result.output || []).flatMap(item => item.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n').trim();
      return answer ? sendJson(res, 200, { answer, mode: 'ai' }) : sendJson(res, 502, { error: 'Ο AI πάροχος δεν επέστρεψε απάντηση.' });
    } catch (error) {
      return sendJson(res, 502, { error: 'Δεν ήταν δυνατή η σύνδεση με τον AI πάροχο.' });
    }
  }

  return sendJson(res, 404, { error: 'API endpoint δεν βρέθηκε.' });
}


// Each role has its own installable PWA scope and identity, while APIs and PostgreSQL remain shared.
const ROLE_PWAS = {
  shop: { name: 'Fair Delivery Store', short: 'FD Store', label: 'Κατάστημα', color: '#ee3c52', page: '/shop-app.html' },
  rider: { name: 'Fair Delivery Rider', short: 'FD Rider', label: 'Διανομέας', color: '#ff5949', page: '/Rider-App.html' },
  admin: { name: 'Fair Delivery Admin', short: 'FD Admin', label: 'Διαχείριση', color: '#da385e', page: '/index.html' },
  customer: { name: 'Fair Delivery Customer', short: 'FD Customer', label: 'Πελάτης', color: '#ef3c5c', page: '/customer-app.html' }
};
const pwaIconCache = new Map();
function pngCrc(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, bytes) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
  const code = Buffer.alloc(4); code.writeUInt32BE(pngCrc(Buffer.concat([name, bytes])));
  return Buffer.concat([size, name, bytes, code]);
}
function roleIconPng(role, size) {
  const cacheKey = role + ':' + size;
  if (pwaIconCache.has(cacheKey)) return pwaIconCache.get(cacheKey);
  const { deflateSync } = require('node:zlib');
  const pixels = Buffer.alloc(size * (1 + 4 * size));
  const inside = (x, y, left, top, right, bottom) => x >= left && x <= right && y >= top && y <= bottom;
  const circle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2;
  for (let y = 0; y < size; y++) {
    const scan = y * (1 + size * 4);
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size, v = (y + 0.5) / size, idx = scan + 1 + x * 4;
      const glow = Math.max(0, 1 - Math.hypot(u - 0.8, v - 0.15) * 1.45);
      let r = Math.round(11 + glow * 36), g = Math.round(15 + glow * 7), b = Math.round(25 + glow * 15);
      // Rounded app tile and soft interior highlight.
      if (inside(u, v, .06, .06, .94, .94) && circle(u < .2 ? .2 : u > .8 ? .8 : u, v < .2 ? .2 : v > .8 ? .8 : v, .5, .5, .46)) {
        r += 7; g += 5; b += 8;
      }
      let accent = false, white = false;
      const ring = circle(u,v,.5,.5,.35) && !circle(u,v,.5,.5,.332);
      accent = ring;
      if (role === 'customer') {
        // Distinct customer shopping bag icon, independent of shop/rider/admin.
        accent ||= inside(u,v,.27,.43,.73,.76) && !inside(u,v,.31,.48,.69,.71);
        accent ||= inside(u,v,.26,.42,.74,.48) || inside(u,v,.27,.72,.73,.76);
        accent ||= inside(u,v,.27,.48,.31,.72) || inside(u,v,.69,.48,.73,.72);
        accent ||= circle(u,v,.50,.45,.15) && !circle(u,v,.50,.45,.095) && v <= .45;
        white ||= inside(u,v,.39,.54,.61,.59) || inside(u,v,.48,.51,.52,.66);
      } else if (role === 'shop') {
        accent ||= inside(u,v,.235,.37,.765,.49) || inside(u,v,.25,.53,.30,.76) || inside(u,v,.70,.53,.75,.76) || inside(u,v,.25,.72,.75,.77);
        white ||= inside(u,v,.31,.53,.44,.68) || inside(u,v,.49,.53,.66,.71) && !inside(u,v,.55,.62,.60,.71);
        // Storefront awning stripes.
        white ||= inside(u,v,.33,.38,.38,.48) || inside(u,v,.46,.38,.51,.48) || inside(u,v,.59,.38,.64,.48);
      } else if (role === 'rider') {
        accent ||= circle(u,v,.33,.69,.095) || circle(u,v,.68,.69,.095);
        if (circle(u,v,.33,.69,.052) || circle(u,v,.68,.69,.052)) {accent=false;white=true;}
        accent ||= inside(u,v,.34,.55,.67,.60) || inside(u,v,.50,.49,.62,.56) || inside(u,v,.59,.43,.64,.51) || inside(u,v,.45,.41,.57,.46);
        white ||= inside(u,v,.35,.50,.49,.54);
      } else {
        accent ||= inside(u,v,.29,.58,.38,.73) || inside(u,v,.44,.48,.53,.73) || inside(u,v,.59,.36,.68,.73);
        accent ||= inside(u,v,.25,.75,.74,.79);
        white ||= circle(u,v,.65,.32,.055);
      }
      if (accent) { r = role === 'rider' ? 255 : role === 'admin' ? 230 : 239; g = role === 'rider' ? 89 : 57; b = role === 'rider' ? 73 : role === 'shop' ? 82 : 105; }
      if (white) {r=245;g=246;b=250;}
      pixels[idx] = r; pixels[idx+1] = g; pixels[idx+2] = b; pixels[idx+3] = 255;
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',deflateSync(pixels,{level:9})),pngChunk('IEND',Buffer.alloc(0))]);
  pwaIconCache.set(cacheKey,png);
  return png;
}
async function serveRoleApp(req, res, url) {
  const match = /^\/app\/(shop|rider|admin|customer)\/(manifest\.webmanifest|sw\.js|icon-(192|512)\.png|offline\.html)?$/.exec(url.pathname);
  if (!match) return false;
  if (!['GET','HEAD'].includes(req.method)) { sendJson(res,405,{ error:'Μη επιτρεπτή μέθοδος.' }); return true; }
  const role = match[1], asset = match[2] || '', config = ROLE_PWAS[role], scope = '/app/' + role + '/';
  if (!asset) {
    await serveStatic(req,res,{pathname:config.page}); return true;
  }
  let content, mime, cacheControl = 'no-store';
  if (asset === 'manifest.webmanifest') {
    content = JSON.stringify({
      id: scope, name: config.name, short_name: config.short, description: 'Fair Delivery — ' + config.label,
      lang: 'el', start_url: scope, scope, display: 'standalone', background_color: '#0a0d15',
      theme_color: config.color, orientation: 'any',
      icons: [192,512].map(size => ({ src:scope+'icon-'+size+'.png', sizes:size+'x'+size, type:'image/png', purpose:'any maskable' }))
    });
    mime='application/manifest+json; charset=utf-8';
  } else if (/^icon-(192|512)\.png$/.test(asset)) {
    content=roleIconPng(role,Number(asset.match(/\d+/)[0]));
    mime='image/png';cacheControl='public, max-age=604800, immutable';
  } else if (asset === 'sw.js') {
    content = `'use strict';const OFFLINE='${scope}offline.html';const CACHE='fd-pwa-${role}-offline-v1';self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.add(OFFLINE)).then(()=>self.skipWaiting()));});self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim());});self.addEventListener('fetch',event=>{const url=new URL(event.request.url);if(event.request.mode!=='navigate'||url.origin!==self.location.origin||!url.pathname.startsWith('${scope}'))return;event.respondWith(fetch(event.request).catch(()=>caches.match(OFFLINE)));});`;
    mime='application/javascript; charset=utf-8';
  } else {
    content = `<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fair Delivery — Χωρίς σύνδεση</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0a0d15;color:#fff;font:16px system-ui;text-align:center;padding:24px}section{max-width:400px}a{color:#ff6b76}</style></head><body><section><h1>Fair Delivery ${config.label}</h1><p>Δεν υπάρχει σύνδεση στο διαδίκτυο. Για τις ζωντανές παραγγελίες χρειάζεται πρόσβαση στο δίκτυο.</p><a href="${scope}">Δοκίμασε ξανά</a></section></body></html>`;
    mime='text/html; charset=utf-8';
  }
  res.writeHead(200, {'Content-Type':mime,'Cache-Control':cacheControl,'X-Content-Type-Options':'nosniff'});
  res.end(req.method==='HEAD'?undefined:content);
  return true;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLIC_FILES = new Set(['index.html', 'customer-app.html', 'shop-app.html', 'Rider-App.html', 'admin.js', 'customer.js', 'shop.js', 'rider.js', 'assets/app.css', 'assets/common.js', 'assets/pwa.js']);
async function serveStatic(req, res, url) {
  let requested = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
  if (!PUBLIC_FILES.has(requested)) return sendJson(res, 404, { error: 'Η σελίδα δεν βρέθηκε.' });
  const file = path.join(__dirname, 'public', requested);
  try {
    const content = await fs.promises.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Cache-Control': requested.endsWith('.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(content);
  } catch { sendJson(res, 404, { error: 'Το αρχείο δεν βρέθηκε.' }); }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: blob: https://unpkg.com https://*.tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  try {
    await stateReady;
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (await serveRoleApp(req,res,url)) { /* role-specific installable app */ }
    else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, url);
    else sendJson(res, 405, { error: 'Μη επιτρεπτή μέθοδος.' });
  } catch (error) {
    if (!res.headersSent) sendJson(res, error.statusCode || 500, { error: error.message || 'Εσωτερικό σφάλμα server.' });
    else res.destroy();
    console.error('[FairDelivery]', error);
  }
});

const stateReady = initState();
if (require.main === module) {
  stateReady.then(() => server.listen(PORT, HOST, () => {
    console.log(`Fair Delivery 1.3.0 listening on http://${HOST}:${PORT}`);
    console.log(`Mode: ${DEMO_MODE ? 'LOCAL DEMO (access code: demo)' : 'PILOT (role access codes required)'}`);
    console.log(`Storage: ${postgresPool ? 'PostgreSQL' : STATE_FILE}`);
  })).catch(error => { console.error('Could not initialize database:', error); process.exit(1); });
}

module.exports = { server, initState, getState: () => state, persistState };
