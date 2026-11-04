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
const DEMO_MODE = process.env.DEMO_MODE === 'true' && process.env.NODE_ENV !== 'production';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
const requestWindows = new Map();
const aiWindows = new Map();

const DEFAULT_SETTINGS = {
  currency: 'EUR',
  customerServiceFee: 0.20,
  shopCommissionPercent: 0,
  riderBaseAmount: 2.50,
  riderPerKm: 0.80,
  badWeatherBonus: 1.50
};

const DEFAULT_PRODUCTS = [
  { id: 'demo-souvlaki', name: 'Πίτα κοτόπουλο', description: 'Δοκιμαστικό προϊόν — άλλαξέ το με το πραγματικό μενού.', price: 4.90, category: 'Φαγητό', active: true },
  { id: 'demo-pizza', name: 'Πίτσα μαργαρίτα', description: 'Δοκιμαστικό προϊόν.', price: 6.50, category: 'Φαγητό', active: true },
  { id: 'demo-coffee', name: 'Καφές φίλτρου', description: 'Δοκιμαστικό προϊόν.', price: 2.50, category: 'Καφές', active: true }
];

let state;
let writeQueue = Promise.resolve();

function round2(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function nowIso() { return new Date().toISOString(); }
function publicOrder(order) {
  if (!order) return null;
  return {
    id: order.id, items: order.items, subtotal: order.subtotal, serviceFee: order.serviceFee,
    total: order.total, status: order.status, createdAt: order.createdAt, updatedAt: order.updatedAt,
    estimatedKm: order.estimatedKm ?? null, badWeather: Boolean(order.badWeather),
    riderPayEstimate: order.riderPayEstimate ?? null, riderLocation: order.riderLocation || null
  };
}

async function initState() {
  await fs.promises.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.promises.readFile(STATE_FILE, 'utf8'));
    state = {
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      products: Array.isArray(parsed.products) ? parsed.products : DEFAULT_PRODUCTS,
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      riders: parsed.riders && typeof parsed.riders === 'object' ? parsed.riders : {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { settings: { ...DEFAULT_SETTINGS }, products: DEFAULT_PRODUCTS, orders: [], riders: {} };
    await persistState();
  }
}

function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.then(async () => {
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
      try { resolve(raw ? JSON.parse(raw) : {}); }
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
  const ordered = roles.includes(roleHint) ? [roleHint, ...roles.filter(role => role !== roleHint)] : roles;
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
  const session = getSession(req, allowedRoles.includes(roleHint) ? roleHint : allowedRoles[0]);
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

function validateMoney(value, name, max = 5000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw Object.assign(new Error(`${name}: ποσό εκτός ορίων.`), { statusCode: 400 });
  return round2(n);
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'Fair Delivery', version: '1.1.0', mode: DEMO_MODE ? 'local-demo' : 'pilot', aiConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL) });
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(req, 4096);
    const role = ['shop', 'rider', 'admin'].includes(body.role) ? body.role : '';
    if (!role) return sendJson(res, 400, { error: 'Μη έγκυρος ρόλος.' });
    const expected = roleCode(role);
    if (!expected) return sendJson(res, 503, { error: `Δεν έχει οριστεί κωδικός πρόσβασης για τον ρόλο ${role}.` });
    if (!safeEqual(String(body.code || ''), expected)) return sendJson(res, 401, { error: 'Λάθος κωδικός πρόσβασης.' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { role, userId: `${role}-${crypto.randomUUID()}`, expiresAt: Date.now() + SESSION_TTL_MS });
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return sendJson(res, 200, { ok: true, role, expiresInSeconds: SESSION_TTL_MS / 1000 }, { 'Set-Cookie': `fd_${role}_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}` });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const body = await readJson(req, 1024);
    const role = ['shop', 'rider', 'admin'].includes(body.role) ? body.role : '';
    const session = role ? getSession(req, role) : null;
    if (session) sessions.delete(session.token);
    const cookieName = role ? `fd_${role}_session` : 'fd_admin_session';
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    const roleHint = String(req.headers['x-fd-role'] || '');
    const session = getSession(req, roleHint);
    return sendJson(res, 200, { authenticated: Boolean(session), role: session?.role || null });
  }

  if (method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, { settings: state.settings, demoMode: DEMO_MODE });
  }

  if (method === 'GET' && pathname === '/api/products') {
    return sendJson(res, 200, { products: state.products.filter(p => p.active) });
  }

  if (method === 'POST' && pathname === '/api/orders') {
    const ip = clientIp(req);
    if (!rateLimit(requestWindows, `orders:${ip}`, 10, 60_000)) return sendJson(res, 429, { error: 'Πολλές δοκιμαστικές παραγγελίες. Περίμενε ένα λεπτό.' });
    const body = await readJson(req, 12 * 1024);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) return sendJson(res, 400, { error: 'Το καλάθι δεν είναι έγκυρο.' });
    const lines = [];
    for (const row of body.items) {
      const product = state.products.find(p => p.id === String(row.productId) && p.active);
      const qty = Number(row.qty);
      if (!product || !Number.isInteger(qty) || qty < 1 || qty > 20) return sendJson(res, 400, { error: 'Μη έγκυρο προϊόν ή ποσότητα.' });
      lines.push({ productId: product.id, name: product.name, unitPrice: product.price, qty, lineTotal: round2(product.price * qty) });
    }
    const subtotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
    const order = {
      id: crypto.randomUUID(), items: lines, subtotal,
      serviceFee: round2(state.settings.customerServiceFee), total: round2(subtotal + state.settings.customerServiceFee),
      status: 'new', createdAt: nowIso(), updatedAt: nowIso(),
      estimatedKm: null, badWeather: false, riderPayEstimate: null, assignedRider: null, riderLocation: null
    };
    state.orders.push(order); await persistState();
    return sendJson(res, 201, { order: publicOrder(order), trackingUrl: `/customer-app.html?order=${encodeURIComponent(order.id)}` });
  }

  const publicTracking = pathname.match(/^\/api\/orders\/([0-9a-f-]+)$/i);
  if (method === 'GET' && publicTracking) {
    const order = state.orders.find(item => item.id === publicTracking[1]);
    return order ? sendJson(res, 200, { order: publicOrder(order) }) : sendJson(res, 404, { error: 'Η παραγγελία δεν βρέθηκε.' });
  }

  if (method === 'GET' && pathname === '/api/orders') {
    const session = requireRole(req, res, ['shop', 'rider', 'admin']); if (!session) return;
    let orders = state.orders.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (session.role === 'rider') orders = orders.filter(o => ['ready', 'assigned', 'picked_up'].includes(o.status) && (!o.assignedRider || o.assignedRider === session.userId));
    return sendJson(res, 200, { orders: orders.map(publicOrder) });
  }

  const orderMutation = pathname.match(/^\/api\/orders\/([0-9a-f-]+)$/i);
  if (method === 'PATCH' && orderMutation) {
    const session = requireRole(req, res, ['shop', 'rider', 'admin']); if (!session) return;
    const body = await readJson(req, 4096);
    const order = state.orders.find(item => item.id === orderMutation[1]);
    if (!order) return sendJson(res, 404, { error: 'Η παραγγελία δεν βρέθηκε.' });
    const status = String(body.status || '');
    const transitions = {
      shop: { new: ['accepted', 'cancelled'], accepted: ['ready'] },
      rider: { ready: ['assigned'], assigned: ['picked_up'], picked_up: ['delivered'] },
      admin: { new: ['accepted', 'cancelled'], accepted: ['ready', 'cancelled'], ready: ['assigned', 'cancelled'], assigned: ['picked_up', 'cancelled'], picked_up: ['delivered', 'cancelled'] }
    };
    if (!(transitions[session.role]?.[order.status] || []).includes(status)) return sendJson(res, 409, { error: `Δεν επιτρέπεται η μετάβαση ${order.status} → ${status} για τον ρόλο ${session.role}.` });
    if (session.role === 'rider' && order.assignedRider && order.assignedRider !== session.userId) return sendJson(res, 403, { error: 'Η παραγγελία έχει ανατεθεί σε άλλον διανομέα.' });
    if (body.estimatedKm !== undefined) {
      const km = Number(body.estimatedKm);
      if (!Number.isFinite(km) || km < 0 || km > 100) return sendJson(res, 400, { error: 'Τα χιλιόμετρα πρέπει να είναι από 0 έως 100.' });
      order.estimatedKm = round2(km);
    }
    if (body.badWeather !== undefined) order.badWeather = Boolean(body.badWeather);
    if (status === 'assigned') order.assignedRider = session.userId;
    if (status === 'delivered' && Number.isFinite(order.estimatedKm)) {
      order.riderPayEstimate = round2(state.settings.riderBaseAmount + order.estimatedKm * state.settings.riderPerKm + (order.badWeather ? state.settings.badWeatherBonus : 0));
    }
    order.status = status; order.updatedAt = nowIso();
    await persistState();
    return sendJson(res, 200, { order: publicOrder(order) });
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
      riderCountOnline: Object.values(state.riders).filter(r => r.online).length
    });
  }

  if (method === 'PATCH' && pathname === '/api/settings') {
    const session = requireRole(req, res, ['admin']); if (!session) return;
    const body = await readJson(req, 4096);
    const allowed = ['customerServiceFee', 'shopCommissionPercent', 'riderBaseAmount', 'riderPerKm', 'badWeatherBonus'];
    for (const key of allowed) {
      if (body[key] !== undefined) {
        const value = Number(body[key]);
        const max = key === 'shopCommissionPercent' ? 100 : 1000;
        if (!Number.isFinite(value) || value < 0 || value > max) return sendJson(res, 400, { error: `Μη έγκυρη τιμή για ${key}.` });
        state.settings[key] = round2(value);
      }
    }
    await persistState();
    return sendJson(res, 200, { settings: state.settings });
  }

  if (method === 'POST' && pathname === '/api/rider/status') {
    const session = requireRole(req, res, ['rider']); if (!session) return;
    const body = await readJson(req, 4096);
    if (typeof body.online !== 'boolean') return sendJson(res, 400, { error: 'Η κατάσταση online πρέπει να είναι true ή false.' });
    state.riders[session.userId] = { ...(state.riders[session.userId] || {}), online: body.online, updatedAt: nowIso() };
    await persistState();
    return sendJson(res, 200, { rider: state.riders[session.userId] });
  }

  if (method === 'POST' && pathname === '/api/rider/location') {
    const session = requireRole(req, res, ['rider']); if (!session) return;
    const body = await readJson(req, 4096); const lat = Number(body.lat); const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return sendJson(res, 400, { error: 'Μη έγκυρες συντεταγμένες.' });
    state.riders[session.userId] = { ...(state.riders[session.userId] || {}), online: true, lat, lng, updatedAt: nowIso() };
    for (const order of state.orders) if (order.assignedRider === session.userId && !['delivered', 'cancelled'].includes(order.status)) order.riderLocation = { lat, lng, updatedAt: nowIso() };
    await persistState();
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/assistant') {
    const session = requireRole(req, res, ['admin']); if (!session) return;
    if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) return sendJson(res, 503, { error: 'Ο AI βοηθός δεν έχει ρυθμιστεί στον server. Πρόσθεσε OPENAI_API_KEY και OPENAI_MODEL στα server environment variables.' });
    if (!rateLimit(aiWindows, session.userId, Number(process.env.AI_MAX_REQUESTS_PER_10_MIN || 10), 10 * 60 * 1000)) return sendJson(res, 429, { error: 'Έφτασες το όριο ερωτήσεων. Δοκίμασε ξανά σε λίγο.' });
    const body = await readJson(req, 12 * 1024);
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 2000) return sendJson(res, 400, { error: 'Γράψε ερώτηση έως 2.000 χαρακτήρες.' });
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
      return answer ? sendJson(res, 200, { answer }) : sendJson(res, 502, { error: 'Ο AI πάροχος δεν επέστρεψε απάντηση.' });
    } catch (error) {
      return sendJson(res, 502, { error: 'Δεν ήταν δυνατή η σύνδεση με τον AI πάροχο.' });
    }
  }

  return sendJson(res, 404, { error: 'API endpoint δεν βρέθηκε.' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLIC_FILES = new Set(['index.html', 'customer-app.html', 'shop-app.html', 'Rider-App.html', 'admin.js', 'customer.js', 'shop.js', 'rider.js', 'assets/app.css', 'assets/common.js']);
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
    console.log(`Fair Delivery 1.1.0 listening on http://${HOST}:${PORT}`);
    console.log(`Mode: ${DEMO_MODE ? 'LOCAL DEMO (access code: demo)' : 'PILOT (role access codes required)'}`);
    console.log(`Data: ${STATE_FILE}`);
  })).catch(error => { console.error('Could not initialize database:', error); process.exit(1); });
}

module.exports = { server, initState, getState: () => state, persistState };
