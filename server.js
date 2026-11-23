'use strict';

const { dispatchReadyOrders } = require('./ready-dispatch');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const adminAuth = require('./admin-auth');
const adminPush = require('./admin-push');
let adminPasswordChanging=false;
const courierInterest=require('./courier-interest');
const fairAssistant=require('./fair-assistant');
const { storeId:validStoreId, allStores, getStore, publicStore, newStore }=require('./stores');
const storeOperations=require('./store-operations');
const checkoutReliability=require('./checkout-reliability');
const checkoutPending=new Map();
const accountRecovery=require('./account-recovery');
const verifiedCustomers=require('./verified-customers');
const emailOperations=new Set();
const encryptedBackup=require('./encrypted-backup');
const migrationTools=require('./migration-tools');
const migrationTarget=require('./migration-target');
let migrationCopyBusy=false;
const credentialChanges=new Set();
let backupBusy=false;
const { FEE_CENTS, athensDay, settlementSummary, recordSettlement }=require('./shop-billing');
const { SERVICE_FEE_CENTS, COMMISSION_BPS, priceOrder } = require('./billing-pricing');
const {paymentDetails,shopHold,initialPayout,visiblePayout}=require('./shop-controls');
const { credentials: customerCredentials, publicAccount, newAccount, checkoutPayment } = require('./customer-accounts');
const { validateApplication, evaluateApplication, pruneApplications } = require('./courier-onboarding');

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
  customerServiceFee: SERVICE_FEE_CENTS / 100,
  shopOrderFee: 0,
  shopDeliveryFee: 0,
  shopCommissionPercent: COMMISSION_BPS / 100,
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
  // Version 4 pricing only affects NEW orders; prior order snapshots remain unchanged.
  settings.customerServiceFee = SERVICE_FEE_CENTS / 100;
  settings.shopCommissionPercent = COMMISSION_BPS / 100;
  settings.shopOrderFee = 0;
  settings.pricingVersion = 4;
  return {
    settings,
    products: Array.isArray(parsed.products) ? parsed.products : DEFAULT_PRODUCTS,
    orders: Array.isArray(parsed.orders) ? parsed.orders : [],
    riders: parsed.riders && typeof parsed.riders === 'object' ? parsed.riders : {},
    shopCredential: parsed.shopCredential || null,
    adminCredential:parsed.adminCredential||null,
    adminSessions:adminAuth.prune(parsed.adminSessions),
    adminPushSubscriptions:adminPush.prune(parsed.adminPushSubscriptions),
    stores: parsed.stores && typeof parsed.stores==='object' && !Array.isArray(parsed.stores)?parsed.stores:{},
    defaultStoreName: parsed.defaultStoreName || 'Πρώτο κατάστημα',
    courierApplications: pruneApplications(parsed.courierApplications),
    customers: parsed.customers && typeof parsed.customers === 'object' && !Array.isArray(parsed.customers) ? parsed.customers : {},
    emailChallenges:verifiedCustomers.prune(parsed.emailChallenges),
    emailSendWindow:parsed.emailSendWindow||{day:'',count:0},
    shopSettlements: Array.isArray(parsed.shopSettlements) ? parsed.shopSettlements : [],
    shopPayout: initialPayout(parsed.shopPayout,process.env.NODE_ENV==='production'?process.env:{}),
    shopHolds: parsed.shopHolds || {},
    shopHoldHistory: Array.isArray(parsed.shopHoldHistory)?parsed.shopHoldHistory:[]
  };
}

function round2(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function nowIso() { return new Date().toISOString(); }
function publicOrder(order) {
  if (!order) return null;
  return {
    id: order.id, storeId: order.storeId||'default', storeName: getStore(state,order.storeId||'default')?.name||'Κατάστημα', items: order.items, subtotal: order.subtotal, serviceFee: order.serviceFee,
    deliveryFee: order.deliveryFee || 0,
    etaMin:order.etaMin??null,etaMax:order.etaMax??null,deliveryDistanceKm:order.deliveryDistanceKm??null,
    total: order.total, status: order.status, createdAt: order.createdAt, updatedAt: order.updatedAt,
    paymentMethod: order.paymentMethod || 'cash', paymentStatus: order.paymentStatus || 'pilot_not_charged', paymentMode: 'simulation', paymentCollected: false,
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
    shopFeeCents: ['shop-fixed-v1','shop-percent-v2'].includes(order.billingModel) ? order.shopFeeCents : 0,
    pricingSnapshot: order.pricingSnapshot || null,
    completedAt: order.completedAt || null,
    customerName: order.customerName || '',
    customerPhone: order.customerPhone || '',
    deliveryAddress: order.deliveryAddress || '',
    deliveryManagedByShop: Boolean(order.deliveryManagedByShop),
    waitingForRider: order.status === 'ready' && Boolean(order.dispatchRequestedAt),
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

function clearExpiredCourierApplications() {
  if(process.env.FD_MAINTENANCE_MODE==='true')return;
  if (!state || !Array.isArray(state.courierApplications)) return;
  const remaining = pruneApplications(state.courierApplications);
  const challenges=verifiedCustomers.prune(state.emailChallenges);
  if (remaining.length !== state.courierApplications.length || challenges.length!==state.emailChallenges.length) {
    state.courierApplications = remaining;state.emailChallenges=challenges;
    persistState().catch(()=>console.error('[FairDelivery] retention cleanup failed'));
  }
}
// An hourly purge runs even if no applicant or administrator opens the site.
const courierRetentionTimer = setInterval(clearExpiredCourierApplications, 60 * 60 * 1000);
courierRetentionTimer.unref();

function persistState() {
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.catch(()=>{}).then(async () => {
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
  const roles = ['admin', 'shop', 'rider', 'customer'];
  const ordered = roles.includes(roleHint) ? [roleHint] : roles;
  for (const role of ordered) {
    const token = cookies[`fd_${role}_session`];
    if (!token) continue;
    if(role==='admin'){
      const persistent=adminAuth.lookup(state?.adminSessions,token);
      if(persistent)return persistent;
      continue;
    }
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

async function adminPasswordMatches(code){
  if(typeof code!=='string'||!code)return false;
  const credential=state.adminCredential;
  if(credential?.salt&&credential?.hash){
    const digest=await riderCodeHash(code,credential.salt);
    return safeEqual(digest,credential.hash);
  }
  return safeEqual(code,roleCode('admin'));
}

function validateMoney(value, name, max = 5000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw Object.assign(new Error(`${name}: ποσό εκτός ορίων.`), { statusCode: 400 });
  return round2(n);
}

function offlineHelp(question) {
  const q = question.toLocaleLowerCase('el-GR');
  const fee = '1 ευρώ ανά ολοκληρωμένη παραγγελία από το κατάστημα';
  if (/κωδικ|συνδε|λογαριασ|διανομ|rider/.test(q)) {
    return `Σύνδεση: ο διαχειριστής μπαίνει στο Control Center. Από εκεί εκδίδει νέο κωδικό καταστήματος. Το κατάστημα δημιουργεί κάθε διανομέα και του δίνει προσωπικό ID και κωδικό. Οι διανομείς δεν έχουν κοινό κωδικό. ${postgresPool ? 'Η βάση PostgreSQL είναι ενεργή.' : 'ΠΡΟΣΟΧΗ: η βάση είναι προσωρινή· οι λογαριασμοί μπορεί να χαθούν μετά από restart.'}`;
  }
  if (/κοστο|χρεω|κερδ|φορο|φπα|τιμ|price|fee/.test(q)) {
    return `Η δοκιμαστική χρέωση Fair Delivery είναι ${fee}, με μηδενική χρέωση υπηρεσίας στον πελάτη και 0% ποσοστιαία προμήθεια. Η διανομή του καταστήματος είναι ${state.settings.shopDeliveryFee.toFixed(2).replace('.', ',')} ευρώ. Αυτά είναι μικτά ποσά, όχι καθαρό κέρδος. Για πραγματικούς φόρους, ΦΠΑ, παραστατικά και πληρωμές χρειάζεται λογιστική έγκριση πριν από εμπορική λειτουργία.`;
  }
  if (/παραγγελ|ακυρω|καταστημ|πελατ/.test(q)) {
    return 'Η δοκιμαστική παραγγελία πηγαίνει από τον πελάτη στο κατάστημα: νέα → αποδοχή → ετοιμασία → ανάθεση στον διανομέα του καταστήματος → παραλαβή → παράδοση. Σε ακύρωση απαιτείται καταγραφή της αιτίας και, πριν από πραγματικές πληρωμές, ξεκάθαρη πολιτική επιστροφών.';
  }
  if (/ai|τεχνητ|openai|api/.test(q)) {
    return 'Ο βοηθός Groq υποστηρίζει το GPT-OSS 120B μέσω ξεχωριστού λογαριασμού Free plan. Χρειάζεται ιδιωτικό GROQ_API_KEY στο Render και επιβεβαίωση δωρεάν πλάνου. Οι τοπικές αναφορές λειτουργούν χωρίς εξωτερικό AI.';
  }
  return 'Αυτή τη στιγμή λειτουργώ ως βασικός οδηγός, όχι ως μοντέλο AI. Μπορώ να εξηγήσω: (1) σύνδεση καταστήματος και διανομέων, (2) ροή παραγγελίας, (3) χρεώσεις και φόρους, (4) σύνδεση OpenAI. Για ελεύθερες ερωτήσεις χρειάζεται ενεργή σύνδεση API.';
}

async function alertAdminOfApplication(entry){
 if(!adminPush.config().available)return;
 const subscriptions=adminPush.prune(state.adminPushSubscriptions);
 if(!subscriptions.length)return;
 const payload={type:'new-application',id:entry.id,kind:entry.kind==='interest'?'interest':'application',url:'/app/admin/#applications'};
 const results=await Promise.allSettled(subscriptions.map(subscription=>adminPush.send(subscription,payload)));
 const expired=new Set();
 for(let i=0;i<results.length;i++){
  const result=results[i];
  if(result.status==='fulfilled'&&[404,410].includes(result.value.status))expired.add(subscriptions[i].endpoint);
 }
 if(expired.size){
  state.adminPushSubscriptions=adminPush.prune(state.adminPushSubscriptions).filter(x=>!expired.has(x.endpoint));
  await persistState().catch(()=>{});
 }
}
function announceNewApplication(entry){alertAdminOfApplication(entry).catch(()=>{});}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const method = req.method;
  const maintenance=process.env.FD_MAINTENANCE_MODE==='true';
  // Manual freeze for a final consistent export. No order/account/shop writes
  // while this mode is enabled, including legacy guest APIs.
  if(maintenance&&!['GET','HEAD'].includes(method)&&!(method==='POST'&&['/api/auth/login','/api/admin/backup','/api/admin/migration/copy'].includes(pathname))){
    return sendJson(res,503,{error:'Το Fair Delivery βρίσκεται σε προγραμματισμένη συντήρηση. Οι νέες καταχωρίσεις είναι προσωρινά απενεργοποιημένες.'},{'Retry-After':'600'});
  }

  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'Fair Delivery', version: '1.3.0', mode: DEMO_MODE ? 'local-demo' : 'pilot', aiConfigured: fairAssistant.configured(), aiModel: fairAssistant.configured()?fairAssistant.MODEL:null, storage: postgresPool ? 'postgres' : 'temporary-file', maintenance });
  }


  // Freelancer onboarding remains separate from shop-employed riders and dispatch accounts.
  // Live intake is gated until the operator has published a complete privacy notice,
  // secured a lawful basis, and reviewed operating/legal obligations.
  if(method==='GET'&&pathname==='/api/courier-interest/config'){
    return sendJson(res,200,courierInterest.config(process.env,DEMO_MODE));
  }
  if(method==='POST'&&pathname==='/api/courier-interest'){
    const config=courierInterest.config(process.env,DEMO_MODE);
    if(!config.open)return sendJson(res,503,{error:'Οι εκδηλώσεις ενδιαφέροντος ανοίγουν σύντομα.'});
    const origin=req.headers.origin;
    if(origin&&origin!=='http://'+req.headers.host&&origin!=='https://'+req.headers.host)return sendJson(res,403,{error:'Μη επιτρεπόμενη προέλευση.'});
    if(!rateLimit(requestWindows,'courier-interest:'+clientIp(req),5,60*60_000))return sendJson(res,429,{error:'Δοκίμασε ξανά αργότερα.'});
    const body=await readJson(req,2048);
    let interest;try{interest=courierInterest.validateInterest(body,config);}catch(e){return sendJson(res,400,{error:e.message});}
    state.courierApplications=pruneApplications(state.courierApplications);
    const response={received:true,message:'Ευχαριστούμε! Η εκδήλωση ενδιαφέροντος καταχωρίστηκε. Θα επικοινωνήσουμε μαζί σου όταν υπάρχουν επόμενα βήματα. Δεν δημιουργήθηκε λογαριασμός.'};
    if(state.courierApplications.some(a=>a.email===interest.email&&a.kind==='interest'))return sendJson(res,202,response);
    if(state.courierApplications.length>=300)return sendJson(res,503,{error:'Οι θέσεις ενδιαφέροντος συμπληρώθηκαν προσωρινά.'});
    const entry={...interest,id:crypto.randomUUID(),createdAt:nowIso(),updatedAt:nowIso(),status:'new',reviewNotes:'',reviewedAt:null};
    state.courierApplications.push(entry);
    try{await persistState();}catch(e){state.courierApplications=state.courierApplications.filter(a=>a.id!==entry.id);throw e;}
    announceNewApplication(entry);
    return sendJson(res,202,response);
  }

  if(method==='POST'&&pathname==='/api/courier-interest/privacy-request'){
    const settings=courierInterest.config(process.env,DEMO_MODE);
    if(!settings.open)return sendJson(res,503,{error:'Η υποβολή αιτημάτων δεν είναι διαθέσιμη. Χρησιμοποίησε τα δημοσιευμένα στοιχεία επικοινωνίας.'});
    const origin=req.headers.origin;
    if(origin&&origin!=='http://'+req.headers.host&&origin!=='https://'+req.headers.host)return sendJson(res,403,{error:'Μη επιτρεπόμενη προέλευση.'});
    if(!rateLimit(requestWindows,'interest-privacy:'+clientIp(req),3,60*60_000))return sendJson(res,429,{error:'Πολλά αιτήματα. Προσπάθησε αργότερα.'});
    const body=await readJson(req,2048);
    let request;
    try{request=courierInterest.validatePrivacyRequest(body,settings);}catch(e){return sendJson(res,400,{error:e.message});}
    state.courierApplications=pruneApplications(state.courierApplications);
    const response={received:true,message:'Το αίτημά σου καταχωρίστηκε για έλεγχο. Θα χρειαστεί να επιβεβαιωθεί ότι η διεύθυνση email σου ανήκει πριν γίνει πρόσβαση, αλλαγή ή διαγραφή. Δεν πραγματοποιήθηκε αυτόματη ενέργεια.'};
    if(state.courierApplications.some(a=>a.kind==='privacy-request'&&a.email===request.email&&a.requestType===request.requestType&&Date.now()-Date.parse(a.createdAt)<24*60*60_000))return sendJson(res,202,response);
    if(state.courierApplications.length>=300)return sendJson(res,503,{error:'Δεν μπορούν να υποβληθούν νέα αιτήματα προσωρινά.'});
    const entry={...request,id:crypto.randomUUID(),createdAt:nowIso(),updatedAt:nowIso(),status:'new',reviewNotes:'',reviewedAt:null};
    state.courierApplications.push(entry);
    try{await persistState();}catch(e){state.courierApplications=state.courierApplications.filter(a=>a.id!==entry.id);throw e;}
    announceNewApplication(entry);
    return sendJson(res,202,response);
  }

  if (method === 'GET' && pathname === '/api/courier-applications/config') {
    return sendJson(res, 200, {
      open: DEMO_MODE || process.env.COURIER_APPLICATIONS_OPEN === 'true',
      mode: DEMO_MODE ? 'local-demo' : 'pilot',
      retentionDays: 90,
      automaticApproval: false,
      registryVerification: false
    });
  }

  if (method === 'POST' && pathname === '/api/courier-applications') {
    if (!DEMO_MODE && process.env.COURIER_APPLICATIONS_OPEN !== 'true')
      return sendJson(res, 503, { error: 'Οι αιτήσεις συνεργασίας δεν δέχονται ακόμη πραγματικά στοιχεία. Ο υπεύθυνος ολοκληρώνει την πολιτική απορρήτου και τους όρους συνεργασίας.' });
    const origin = req.headers.origin;
    if (origin && origin !== 'http://' + req.headers.host && origin !== 'https://' + req.headers.host)
      return sendJson(res, 403, { error: 'Η αίτηση πρέπει να υποβληθεί από την επίσημη ιστοσελίδα.' });
    if (!rateLimit(requestWindows, 'courier-intake:' + clientIp(req), 3, 60 * 60_000))
      return sendJson(res, 429, { error: 'Πάρα πολλές αιτήσεις. Δοκίμασε ξανά αργότερα.' });
    const body = await readJson(req, 4096);
    let candidate;
    try { candidate = validateApplication(body); }
    catch (error) { return sendJson(res, 400, { error: error.message }); }
    state.courierApplications = pruneApplications(state.courierApplications);
    if (state.courierApplications.length >= 300)
      return sendJson(res, 503, { error: 'Οι θέσεις του πιλοτικού μητρώου αιτήσεων έχουν συμπληρωθεί προσωρινά.' });
    const duplicate = state.courierApplications.some(app => app.kind !== 'interest' && app.email === candidate.email &&
       Date.now() - Date.parse(app.createdAt) < 24 * 60 * 60_000);
    if (duplicate) return sendJson(res, 202, { received: true, screening: evaluateApplication(candidate),
       message: 'Η αίτηση παραλήφθηκε. Θα επικοινωνήσουμε μαζί σου για τυχόν επόμενα βήματα.' });
    const screening = evaluateApplication(candidate);
    const application = { id: crypto.randomUUID(), ...candidate,
      createdAt: nowIso(), updatedAt: nowIso(),
      status: 'new', reviewNotes: '', reviewedAt: null };
    state.courierApplications.push(application);
    await persistState();
    announceNewApplication(application);
    return sendJson(res, 202, { received: true, screening, 
      message: 'Η αίτηση καταχωρίστηκε για ανθρώπινο έλεγχο. Δεν δημιουργήθηκε λογαριασμός διανομέα.' });
  }

  if(method==='GET'&&pathname==='/api/admin/courier-applications/summary'){
    if(!requireRole(req,res,['admin']))return;
    clearExpiredCourierApplications();
    const list=[...state.courierApplications].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return sendJson(res,200,{total:list.length,newCount:list.filter(a=>a.status==='new').length,recentIds:list.slice(0,50).map(a=>a.id)});
  }
  if(pathname==='/api/admin/push/config'&&method==='GET'){
    if(!requireRole(req,res,['admin']))return;
    const info=adminPush.config();
    return sendJson(res,200,{enabled:info.available,publicKey:info.publicKey,subscribedDevices:adminPush.prune(state.adminPushSubscriptions).length,requiresInstalledApp:true});
  }
  if(pathname==='/api/admin/push/test'&&method==='POST'){
    if(!requireRole(req,res,['admin']))return;
    if(!rateLimit(authWindows,'push-test:'+clientIp(req),3,15*60*1000))return sendJson(res,429,{error:'Μπορείς να στείλεις άλλη δοκιμή αργότερα.'});
    const subscriptions=adminPush.prune(state.adminPushSubscriptions);
    if(!adminPush.config().available||!subscriptions.length)return sendJson(res,409,{error:'Πρώτα ενεργοποίησε τις ειδοποιήσεις σε τουλάχιστον μία συσκευή.'});
    const tests=await Promise.allSettled(subscriptions.map(sub=>adminPush.send(sub,{type:'test-notification',id:crypto.randomUUID(),url:'/app/admin/#applications'})));
    const accepted=tests.filter(x=>x.status==='fulfilled'&&x.value.ok).length;
    return sendJson(res,200,{attempted:subscriptions.length,accepted});
  }
  if(pathname==='/api/admin/push/subscription'&&['POST','DELETE'].includes(method)){
    if(!requireRole(req,res,['admin']))return;
    const origin=req.headers.origin;
    if(origin&&origin!=='https://'+req.headers.host&&origin!=='http://'+req.headers.host)return sendJson(res,403,{error:'Μη επιτρεπόμενη προέλευση.'});
    if(!rateLimit(authWindows,'admin-push:'+clientIp(req),12,15*60*1000))return sendJson(res,429,{error:'Πάρα πολλές αλλαγές ειδοποιήσεων.'});
    if(!adminPush.config().available)return sendJson(res,503,{error:'Οι ειδοποιήσεις δεν έχουν ρυθμιστεί.'});
    const body=await readJson(req,4096);
    let next;
    try{
      if(method==='POST')next=adminPush.add(state.adminPushSubscriptions,body.subscription);
      else{
        if(!adminPush.isEndpoint(body.endpoint))return sendJson(res,400,{error:'Μη έγκυρη συσκευή.'});
        next=adminPush.remove(state.adminPushSubscriptions,body.endpoint);
      }
    }catch(e){return sendJson(res,e.statusCode||400,{error:e.message});}
    const previous=state.adminPushSubscriptions;
    state.adminPushSubscriptions=next;
    try{await persistState();}catch(e){state.adminPushSubscriptions=previous;throw e;}
    return sendJson(res,200,{saved:true,subscribedDevices:next.length});
  }

  if (method === 'GET' && pathname === '/api/admin/courier-applications') {
    if (!requireRole(req, res, ['admin'])) return;
    clearExpiredCourierApplications();
    return sendJson(res, 200, {
      applications: state.courierApplications.map(app => ({
        ...app, screening: courierInterest.screening(app,evaluateApplication)
      })).sort((a,b) => b.createdAt.localeCompare(a.createdAt)),
      policies: { automaticApproval: false, retentionDays: 90, includesSensitiveDocuments: false }
    });
  }

  const courierReview = pathname.match(/^\/api\/admin\/courier-applications\/([0-9a-f-]{36})$/i);
  if (courierReview && ['PATCH', 'DELETE'].includes(method)) {
    if (!requireRole(req, res, ['admin'])) return;
    const app = state.courierApplications.find(item => item.id === courierReview[1]);
    if (!app) return sendJson(res, 404, { error: 'Η αίτηση δεν βρέθηκε.' });
    if (method === 'DELETE') {
      state.courierApplications = state.courierApplications.filter(item => item.id !== app.id);
      await persistState();
      return sendJson(res, 200, { deleted: true });
    }
    const body = await readJson(req, 2048);
    const statuses = ['new', 'contacted', 'needs-documents', 'reviewing', 'not-suitable', 'resolved'];
    if (!statuses.includes(body.status)) return sendJson(res, 400, { error: 'Μη έγκυρη κατάσταση.' });
    if (body.reviewNotes !== undefined && (typeof body.reviewNotes !== 'string' || body.reviewNotes.length > 500))
      return sendJson(res, 400, { error: 'Οι σημειώσεις επιτρέπονται έως 500 χαρακτήρες.' });
    app.status = body.status;
    if (body.reviewNotes !== undefined) app.reviewNotes = body.reviewNotes.trim();
    app.reviewedAt = nowIso();
    app.updatedAt = nowIso();
    await persistState();
    return sendJson(res, 200, { application: { ...app, screening: courierInterest.screening(app,evaluateApplication) } });
  }


  // Pilot customer accounts use an alias and a test password; no actual bank data
  // or email is collected. Commercial signup requires a separate verified flow.
  if (pathname === '/api/customer/account' && method === 'GET') {
    const session = getSession(req, 'customer');
    return sendJson(res, 200, { account: publicAccount(session ? state.customers[session.userId] : null), pilot: true, realPaymentsEnabled: false });
  }
  if (method === 'GET' && pathname === '/api/customer/orders') {
    const session = requireRole(req, res, ['customer']); if (!session) return;
    if (!state.customers[session.userId]) return sendJson(res, 401, { error: 'Ο λογαριασμός δεν είναι ενεργός.' });
    return sendJson(res, 200, { orders: state.orders.filter(o => o.customerId === session.userId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(publicOrder) });
  }
  if(method==='GET'&&pathname==='/api/customer/email/config'){
    return sendJson(res,200,{...verifiedCustomers.config(process.env,Boolean(postgresPool)&&!DEMO_MODE),realOrdersEnabled:false});
  }
  if(method==='POST'&&['/api/customer/email/start','/api/customer/email/finish','/api/customer/email/login'].includes(pathname)){
    const config=verifiedCustomers.config(process.env,Boolean(postgresPool)&&!DEMO_MODE);
    if(!config.open)return sendJson(res,503,{error:'Η επιβεβαιωμένη εγγραφή πελατών δεν έχει ανοίξει ακόμη.'});
    const origin=req.headers.origin;
    if(origin&&origin!=='https://'+req.headers.host&&origin!=='http://'+req.headers.host)return sendJson(res,403,{error:'Μη επιτρεπόμενη προέλευση.'});
    if(!rateLimit(authWindows,'verified-email:'+clientIp(req),12,15*60_000))return sendJson(res,429,{error:'Πολλές προσπάθειες. Δοκίμασε αργότερα.'});
    const body=await readJson(req,4096);let email,password;
    try{email=verifiedCustomers.email(body.email);if(!pathname.endsWith('/start'))password=verifiedCustomers.password(body.password);}catch(e){return sendJson(res,e.statusCode||400,{error:e.message});}
    const key=verifiedCustomers.emailKey(email);
    if(!rateLimit(authWindows,'verified-email-key:'+key,8,15*60_000))return sendJson(res,429,{error:'Πολλές προσπάθειες. Δοκίμασε αργότερα.'});
    if(emailOperations.has(key))return sendJson(res,409,{error:'Εκκρεμεί άλλη ενέργεια. Δοκίμασε σε λίγο.'});
    emailOperations.add(key);
    try{
      let account=Object.values(state.customers).find(a=>a.credentialKind==='email'&&a.email===email);
      if(pathname.endsWith('/login')){
        const hash=await riderCodeHash(password,account?.salt||'fd-verified-dummy-salt');
        if(!account||state.customers[account.id]!==account||credentialChanges.has(account.id)||!safeEqual(hash,account.passwordHash))return sendJson(res,401,{error:'Λάθος email ή κωδικός.'});
        const prior=getSession(req,'customer');if(prior)sessions.delete(prior.token);
        const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{role:'customer',userId:account.id,expiresAt:Date.now()+SESSION_TTL_MS});
        const secure=process.env.NODE_ENV==='production'||process.env.RENDER?'; Secure':'';
        return sendJson(res,200,{account:publicAccount(account)},{'Set-Cookie':`fd_customer_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS/1000}${secure}`});
      }
      const purpose=body.purpose;
      if(!['signup','reset'].includes(purpose))return sendJson(res,400,{error:'Μη έγκυρη διαδικασία.'});
      if(purpose==='signup'&&(body.acknowledged!==true||body.noticeVersion!==config.version))return sendJson(res,400,{error:'Διάβασε την ενημέρωση απορρήτου.'});
      state.emailChallenges=verifiedCustomers.prune(state.emailChallenges);
      const record=state.emailChallenges.find(c=>c.emailKey===key&&c.purpose===purpose);
      if(pathname.endsWith('/start')){
        const generic={received:true,message:'Αν μπορεί να προχωρήσει η διαδικασία, θα λάβεις email με κωδικό. Έλεγξε και τα ανεπιθύμητα.'};
        if((purpose==='signup'&&account)||(purpose==='reset'&&!account)||record&&Date.now()-record.createdAt<verifiedCustomers.COOLDOWN)return sendJson(res,202,generic);
        if(state.emailChallenges.length>=200)return sendJson(res,503,{error:'Προσωρινά δεν είναι διαθέσιμη η διαδικασία.'});
        const day=athensDay();
        if(state.emailSendWindow.day!==day)state.emailSendWindow={day,count:0};
        if(state.emailSendWindow.count>=50)return sendJson(res,429,{error:'Ημερήσιο όριο εγγραφών. Δοκίμασε αύριο.'});
        const next=verifiedCustomers.challenge(email,purpose,purpose==='signup'?config.version:null);
        state.emailChallenges=state.emailChallenges.filter(c=>c.emailKey!==key||c.purpose!==purpose);state.emailChallenges.push(next.record);state.emailSendWindow.count++;
        try{await persistState();await verifiedCustomers.deliver(email,purpose,next.token);}catch(e){state.emailChallenges=state.emailChallenges.filter(c=>c!==next.record);await persistState().catch(()=>{});return sendJson(res,503,{error:'Η αποστολή δεν επιβεβαιώθηκε. Δοκίμασε αργότερα.'});}
        return sendJson(res,202,generic);
      }
      if(!verifiedCustomers.matches(record,email,purpose,body.code)||(purpose==='signup'&&record.noticeVersion!==config.version)||(purpose==='signup'&&account)||(purpose==='reset'&&!account))return sendJson(res,400,{error:'Μη έγκυρος ή ληγμένος κωδικός.'});
      if(purpose==='signup'&&Object.keys(state.customers).length>=200)return sendJson(res,503,{error:'Το μητρώο έχει συμπληρωθεί.'});
      if(account&&credentialChanges.has(account.id))return sendJson(res,409,{error:'Εκκρεμεί αλλαγή λογαριασμού.'});
      if(account)credentialChanges.add(account.id);
      try{
        const salt=crypto.randomBytes(16).toString('hex'),passwordHash=await riderCodeHash(password,salt);
        if(!verifiedCustomers.matches(record,email,purpose,body.code)||(account&&state.customers[account.id]!==account)||!state.emailChallenges.includes(record))return sendJson(res,400,{error:'Μη έγκυρος ή ληγμένος κωδικός.'});
        if(purpose==='signup'&&Object.keys(state.customers).length>=200)return sendJson(res,503,{error:'Το μητρώο έχει συμπληρωθεί.'});
        const previous=account?{...account}:null;
        if(purpose==='signup'){account={...newAccount('verified-'+crypto.randomUUID(),passwordHash,salt),credentialKind:'email',email,emailVerifiedAt:nowIso(),privacyVersion:config.version,privacyAcknowledgedAt:nowIso()};state.customers[account.id]=account;}
        else{account.salt=salt;account.passwordHash=passwordHash;delete account.recoveryHash;}
        state.emailChallenges=state.emailChallenges.filter(c=>c!==record);
        try{await persistState();}catch(e){
          if(previous){account.salt=previous.salt;account.passwordHash=previous.passwordHash;if(previous.recoveryHash)account.recoveryHash=previous.recoveryHash;}else delete state.customers[account.id];
          state.emailChallenges.push(record);throw e;
        }
        for(const [token,old] of sessions)if(old.role==='customer'&&old.userId===account.id)sessions.delete(token);
        return sendJson(res,200,{completed:true,message:'Η διαδικασία ολοκληρώθηκε. Συνδέσου με email και κωδικό.'},{'Set-Cookie':'fd_customer_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
      }finally{if(purpose==='reset'&&account)credentialChanges.delete(account.id);}
    }finally{emailOperations.delete(key);}
  }
  if (method === 'POST' && ['/api/customer/register','/api/customer/login'].includes(pathname)) {
    const origin = req.headers.origin;
    if (origin && origin !== 'https://' + req.headers.host && origin !== 'http://' + req.headers.host) return sendJson(res, 403, { error: 'Μη επιτρεπόμενη προέλευση.' });
    if (!rateLimit(authWindows, 'customer:' + clientIp(req), 12, 15 * 60_000)) return sendJson(res, 429, { error: 'Πολλές προσπάθειες. Δοκίμασε αργότερα.' });
    const body = await readJson(req, 2048);
    let input;
    try { input = customerCredentials(body); } catch (error) { return sendJson(res, 400, {error:error.message}); }
    let account = Object.values(state.customers).find(a => a.alias === input.alias);
    if (pathname.endsWith('/register')) {
      if (body.pilotAcknowledged !== true) return sendJson(res,400,{error:'Επιβεβαίωσε ότι χρησιμοποιείς μόνο δοκιμαστικά στοιχεία.'});
      if (account) return sendJson(res,409,{error:'Το δοκιμαστικό όνομα χρησιμοποιείται ήδη.'});
      if (Object.keys(state.customers).length >= 200) return sendJson(res,503,{error:'Το πιλοτικό μητρώο έχει συμπληρωθεί.'});
      const salt=crypto.randomBytes(16).toString('hex');
      const hash=await riderCodeHash(input.password,salt);
      // Recheck after async hashing to prevent simultaneous duplicate registration.
      if (Object.values(state.customers).some(a => a.alias === input.alias)) return sendJson(res,409,{error:'Το δοκιμαστικό όνομα χρησιμοποιείται ήδη.'});
      if (Object.keys(state.customers).length >= 200) return sendJson(res,503,{error:'Το πιλοτικό μητρώο έχει συμπληρωθεί.'});
      account=newAccount(input.alias,hash,salt);
      state.customers[account.id]=account;
      await persistState();
    } else {
      const hash=await riderCodeHash(input.password,account?.salt || 'fd-dummy-login-salt');
      if (!account || state.customers[account.id]!==account || credentialChanges.has(account.id) || !safeEqual(hash,account.passwordHash)) return sendJson(res,401,{error:'Λάθος όνομα ή κωδικός.'});
    }
    const prior=getSession(req,'customer');
    if(prior) sessions.delete(prior.token);
    const token=crypto.randomBytes(32).toString('hex');
    sessions.set(token,{role:'customer',userId:account.id,expiresAt:Date.now()+SESSION_TTL_MS});
    const secure=process.env.NODE_ENV==='production'||process.env.RENDER?'; Secure':'';
    return sendJson(res,200,{account:publicAccount(account)},{'Set-Cookie':`fd_customer_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS/1000}${secure}`});
  }
  if(method==='POST'&&['/api/customer/recovery-code','/api/customer/recover','/api/customer/change-password'].includes(pathname)){
    const origin=req.headers.origin;
    if(origin&&origin!=='https://'+req.headers.host&&origin!=='http://'+req.headers.host)return sendJson(res,403,{error:'Μη επιτρεπόμενη προέλευση.'});
    if(!rateLimit(authWindows,'customer-recovery:'+clientIp(req),8,15*60_000))return sendJson(res,429,{error:'Πολλές προσπάθειες. Δοκίμασε αργότερα.'});
    const body=await readJson(req,2048);const recover=pathname.endsWith('/recover'),generate=pathname.endsWith('/recovery-code');
    let account,session,input;
    if(recover){
      try{input=customerCredentials({alias:body.alias,password:body.newPassword});}catch(e){return sendJson(res,400,{error:e.message});}
      account=Object.values(state.customers).find(a=>a.alias===input.alias);
      const hash=accountRecovery.recoveryHash(body.recoveryCode);
      if(!account||!hash||!safeEqual(hash,account.recoveryHash))return sendJson(res,401,{error:'Μη έγκυρα στοιχεία ανάκτησης.'});
    }else{
      session=requireRole(req,res,['customer']);if(!session)return;
      account=state.customers[session.userId];
      if(!account)return sendJson(res,401,{error:'Λογαριασμός μη διαθέσιμος.'});
      try{if(account.credentialKind==='email'){verifiedCustomers.password(body.password);if(!generate)input={password:verifiedCustomers.password(body.newPassword)};else return sendJson(res,400,{error:'Χρησιμοποίησε ανάκτηση μέσω email.'});}else{customerCredentials({alias:account.alias,password:body.password});if(!generate)input=customerCredentials({alias:account.alias,password:body.newPassword});}}catch(e){return sendJson(res,400,{error:e.message});}
    }
    if(credentialChanges.has(account.id))return sendJson(res,409,{error:'Εκκρεμεί αλλαγή λογαριασμού.'});
    credentialChanges.add(account.id);
    try{
      if(!recover&&!safeEqual(await riderCodeHash(body.password,account.salt),account.passwordHash))return sendJson(res,401,{error:'Λάθος κωδικός.'});
      if(state.customers[account.id]!==account)return sendJson(res,401,{error:'Λογαριασμός μη διαθέσιμος.'});
      if(recover&&!safeEqual(accountRecovery.recoveryHash(body.recoveryCode),account.recoveryHash))return sendJson(res,401,{error:'Μη έγκυρα στοιχεία ανάκτησης.'});
      if(generate){
        const recovery=accountRecovery.newRecovery();const previous=account.recoveryHash;
        account.recoveryHash=recovery.hash;
        try{await persistState();}catch(e){if(previous)account.recoveryHash=previous;else delete account.recoveryHash;throw e;}
        return sendJson(res,200,{recoveryCode:recovery.code});
      }
      const salt=crypto.randomBytes(16).toString('hex');const passwordHash=await riderCodeHash(input.password,salt);
      if(state.customers[account.id]!==account)return sendJson(res,401,{error:'Λογαριασμός μη διαθέσιμος.'});
      const previous={salt:account.salt,passwordHash:account.passwordHash,recoveryHash:account.recoveryHash};
      account.salt=salt;account.passwordHash=passwordHash;delete account.recoveryHash;
      try{await persistState();}catch(e){Object.assign(account,previous);throw e;}
      for(const [token,old] of sessions)if(old.role==='customer'&&old.userId===account.id)sessions.delete(token);
      return sendJson(res,200,{changed:true},{'Set-Cookie':'fd_customer_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
    }finally{credentialChanges.delete(account.id);}
  }
  if (method === 'POST' && pathname === '/api/customer/logout') {
    const customer=getSession(req,'customer');
    if(customer) sessions.delete(customer.token);
    return sendJson(res,200,{ok:true},{'Set-Cookie':'fd_customer_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
  }
  if (method === 'DELETE' && pathname === '/api/customer/account') {
    const session=requireRole(req,res,['customer']); if(!session)return;
    const account=state.customers[session.userId];
    if(!account)return sendJson(res,404,{error:'Δεν υπάρχει λογαριασμός.'});
    if(credentialChanges.has(account.id))return sendJson(res,409,{error:'Εκκρεμεί αλλαγή λογαριασμού.'});
    const body=await readJson(req,2048);
    if(body.confirmDelete!==true||typeof body.password!=='string'||body.password.length>128)return sendJson(res,400,{error:'Χρειάζεται επιβεβαίωση και κωδικός.'});
    if(!rateLimit(authWindows,'customer-delete:'+clientIp(req),6,15*60_000))return sendJson(res,429,{error:'Πολλές προσπάθειες.'});
    if(!safeEqual(await riderCodeHash(body.password,account.salt),account.passwordHash))return sendJson(res,401,{error:'Λάθος κωδικός.'});
    if(credentialChanges.has(account.id)||state.customers[account.id]!==account)return sendJson(res,409,{error:'Εκκρεμεί αλλαγή λογαριασμού.'});
    delete state.customers[account.id];
    for(const [token,old] of sessions)if(old.role==='customer'&&old.userId===account.id)sessions.delete(token);
    for(const order of state.orders)if(order.customerId===account.id){delete order.customerId;order.trackingPrivate=true;}
    await persistState();
    return sendJson(res,200,{deleted:true},{'Set-Cookie':'fd_customer_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    if (!rateLimit(authWindows, clientIp(req), 20, 15 * 60_000)) return sendJson(res, 429, { error: 'Πολλές προσπάθειες σύνδεσης. Δοκίμασε ξανά αργότερα.' });
    const body = await readJson(req, 4096);
    const role = ['shop', 'rider', 'admin'].includes(body.role) ? body.role : '';
    if (!role) return sendJson(res, 400, { error: 'Μη έγκυρος ρόλος.' });
    if(role==='admin'&&adminPasswordChanging)return sendJson(res,409,{error:'Εκκρεμεί αλλαγή κωδικού. Δοκίμασε σε λίγο.'});

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
        storeId=validStoreId(body.storeId===undefined?'default':body.storeId);
        if(!storeId||!getStore(state,storeId))return sendJson(res,401,{error:'Μη έγκυρα στοιχεία καταστήματος.'});
        if(storeId!=='default'){
          const store=getStore(state,storeId);
          const supplied=await riderCodeHash(String(body.code||''),store.codeSalt);
          if(!safeEqual(supplied,store.codeHash))return sendJson(res,401,{error:'Μη έγκυρα στοιχεία καταστήματος.'});
        } else {
        if (!state.shopCredential && !expected) return sendJson(res, 503, { error: 'Δεν υπάρχει κωδικός καταστήματος. Ο διαχειριστής μπορεί να δημιουργήσει νέο από το Control Center.' });
        if (!(await shopCodeMatches(String(body.code || '')))) return sendJson(res, 401, { error: 'Λάθος κωδικός καταστήματος. Μπορείς να εκδώσεις νέο από το Control Center.' });
        }
      } else {
        if(!adminAuth.emailMatches(body.email,DEMO_MODE?'':process.env.FD_ADMIN_LOGIN_EMAIL))return sendJson(res,401,{error:'Λάθος email ή κωδικός διαχειριστή.'});
        if(!state.adminCredential&&!expected)return sendJson(res,503,{error:'Δεν έχει οριστεί κωδικός διαχειριστή στον server.'});
        if(!(await adminPasswordMatches(String(body.code||''))))return sendJson(res,401,{error:'Λάθος email ή κωδικός διαχειριστή.'});
      }
    }

    let token,ttl=SESSION_TTL_MS;
    if(role==='admin'){
      const created=adminAuth.issue(state.adminSessions);const previous=state.adminSessions;
      state.adminSessions=created.sessions;
      try{await persistState();}catch(e){state.adminSessions=previous;throw e;}
      token=created.token;ttl=adminAuth.SESSION_TTL_MS;
    }else{
      token=crypto.randomBytes(32).toString('hex');
      sessions.set(token,{role,userId,storeId,expiresAt:Date.now()+ttl});
    }
    const secure = process.env.NODE_ENV === 'production' || process.env.RENDER ? '; Secure' : '';
    return sendJson(res, 200, { ok: true, role, userId, riderName, expiresInSeconds: ttl / 1000 }, { 'Set-Cookie': `fd_${role}_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl / 1000}${secure}` });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const body = await readJson(req, 1024);
    const role = ['shop', 'rider', 'admin'].includes(body.role) ? body.role : '';
    const session = role ? getSession(req, role) : null;
    if (session) {
      sessions.delete(session.token);
      if(session.role==='admin'){
        const old=state.adminSessions;state.adminSessions=adminAuth.revoke(old,session.token);
        try{await persistState();}catch(e){state.adminSessions=old;throw e;}
      }
      if (session.role === 'rider' && state.riders[session.userId]) {
        state.riders[session.userId].online = false;
        hideRiderLocation(session.userId);
        await persistState();
      }
    }
    const cookieName = role ? `fd_${role}_session` : 'fd_admin_session';
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }

  if(method==='POST'&&pathname==='/api/admin/change-password'){
    const session=requireRole(req,res,['admin']);if(!session)return;
    const origin=req.headers.origin;
    if(origin&&origin!=='https://'+req.headers.host&&origin!=='http://'+req.headers.host)return sendJson(res,403,{error:'Μη επιτρεπόμενη προέλευση.'});
    if(!rateLimit(authWindows,'admin-change:'+clientIp(req),5,15*60_000))return sendJson(res,429,{error:'Πολλές προσπάθειες αλλαγής κωδικού.'});
    if(adminPasswordChanging)return sendJson(res,409,{error:'Εκκρεμεί άλλη αλλαγή κωδικού.'});
    const body=await readJson(req,2048);
    let newPassword;
    try{newPassword=adminAuth.validatePassword(body.newCode,process.env.FD_ADMIN_LOGIN_EMAIL);}catch(e){return sendJson(res,e.statusCode||400,{error:e.message});}
    adminPasswordChanging=true;
    try{
      if(!(await adminPasswordMatches(String(body.currentCode||''))))return sendJson(res,401,{error:'Ο τρέχων κωδικός δεν είναι σωστός.'});
      const salt=crypto.randomBytes(16).toString('hex'),hash=await riderCodeHash(newPassword,salt);
      const previous={credential:state.adminCredential,sessions:state.adminSessions};
      state.adminCredential={salt,hash,updatedAt:nowIso()};state.adminSessions=[];
      try{await persistState();}catch(e){state.adminCredential=previous.credential;state.adminSessions=previous.sessions;throw e;}
      return sendJson(res,200,{changed:true,logoutRequired:true},{'Set-Cookie':'fd_admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});
    }finally{adminPasswordChanging=false;}
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    const roleHint = String(req.headers['x-fd-role'] || '');
    const session = getSession(req, roleHint);
    return sendJson(res, 200, { authenticated: Boolean(session), role: session?.role || null, storeId:session?.storeId||null });
  }

  if(method==='GET'&&pathname==='/api/stores'){
    return sendJson(res,200,{stores:allStores(state).filter(s=>s.active).map(s=>publicStore(state,s))});
  }
  if(pathname==='/api/admin/stores'&&['GET','POST','PATCH'].includes(method)){
    const session=requireRole(req,res,['admin']);if(!session)return;
    if(method==='GET')return sendJson(res,200,{stores:allStores(state).map(s=>({...publicStore(state,s),active:s.active}))});
    const body=await readJson(req,4096);
    if(method==='POST'){
      if(Object.keys(state.stores).length>=30)return sendJson(res,409,{error:'Το πιλοτικό υποστηρίζει έως 30 επιπλέον καταστήματα.'});
      const accessCode=crypto.randomBytes(18).toString('base64url'),salt=crypto.randomBytes(16).toString('hex');
      let store;try{store=newStore(body.name,salt,await riderCodeHash(accessCode,salt));}catch(e){return sendJson(res,e.statusCode||400,{error:e.message});}
      state.stores[store.id]=store;await persistState();
      return sendJson(res,201,{store:publicStore(state,store),accessCode});
    }
    const id=validStoreId(body.storeId);const store=id&&getStore(state,id);
    if(!store)return sendJson(res,404,{error:'Το κατάστημα δεν βρέθηκε.'});
    if(typeof body.name==='string'){
      const name=body.name.trim();if(name.length<2||name.length>100)return sendJson(res,400,{error:'Μη έγκυρο όνομα.'});
      if(id==='default')state.defaultStoreName=name;else store.name=name;
    }
    if(typeof body.active==='boolean'&&id!=='default'){
      if(body.active&&(!store.products.some(p=>p.active)||!store.settings.storeLocation))return sendJson(res,409,{error:'Πρόσθεσε ενεργό προϊόν και σημείο καταστήματος πριν την εμφάνιση στο πιλοτικό μενού.'});
      store.active=body.active;
    }
    await persistState();return sendJson(res,200,{store:publicStore(state,getStore(state,id))});
  }

  if (method === 'GET' && pathname === '/api/config') {
    const role=String(req.headers['x-fd-role']||'');
    const session=role==='shop'?getSession(req,'shop'):null;
    const id=session?.storeId||validStoreId(url.searchParams.get('storeId')||'default');
    const store=id&&getStore(state,id);
    if(!store||(!store.active&&!session))return sendJson(res,404,{error:'Το κατάστημα δεν είναι διαθέσιμο.'});
    const settings={...state.settings,shopDeliveryFee:store.settings.shopDeliveryFee||0,storeLocation:store.settings.storeLocation||null,operations:storeOperations.settings(store)};
    return sendJson(res,200,{settings,storeLocation:settings.storeLocation,demoMode:DEMO_MODE,store:publicStore(state,store),acceptingOrders:publicStore(state,store).acceptingOrders});
  }

  if (method === 'GET' && pathname === '/api/products') {
    const id=validStoreId(url.searchParams.get('storeId')||'default');const store=id&&getStore(state,id);
    if(!store||!store.active)return sendJson(res,404,{error:'Το κατάστημα δεν είναι διαθέσιμο.'});
    return sendJson(res,200,{products:store.products.filter(p=>p.active)});
  }

  if (pathname === '/api/shop/products' && ['GET', 'POST'].includes(method)) {
    const session = requireRole(req, res, ['shop', 'admin']); if (!session) return;
    const store=getStore(state,session.storeId||'default');
    if (method === 'GET') return sendJson(res, 200, { products: store.products });
    const body = await readJson(req, 4096);
    if (store.products.length >= 200) return sendJson(res, 409, { error: 'Το πιλοτικό δέχεται έως 200 προϊόντα.' });
    const name = String(body.name || '').trim();
    const category = String(body.category || 'Μενού').trim();
    const description = String(body.description || '').trim();
    if (name.length < 2 || name.length > 100 || !category || category.length > 60 || description.length > 500) return sendJson(res, 400, { error: 'Έλεγξε όνομα, κατηγορία και περιγραφή προϊόντος.' });
    if (typeof body.price !== 'number') return sendJson(res, 400, { error: 'Δώσε έγκυρη τιμή προϊόντος.' });
    const product = { id: crypto.randomUUID(), name, category, description, price: validateMoney(body.price, 'Τιμή προϊόντος'), active: body.active !== false };
    store.products.push(product);
    await persistState();
    return sendJson(res, 201, { product });
  }

  const productMutation = pathname.match(/^\/api\/shop\/products\/([a-zA-Z0-9-]+)$/);
  if (method === 'PATCH' && productMutation) {
    const session = requireRole(req, res, ['shop', 'admin']); if (!session) return;
    const product = getStore(state,session.storeId||'default').products.find(p => p.id === productMutation[1]);
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
    const id=validStoreId(body.storeId===undefined?'default':body.storeId);const store=id&&getStore(state,id);
    const customerSession = getSession(req, 'customer');
    const customerAccount = customerSession ? state.customers[customerSession.userId] : null;
    if(customerAccount?.credentialKind==='email')return sendJson(res,409,{error:'Οι πραγματικές παραγγελίες δεν έχουν ενεργοποιηθεί ακόμη.'});
    let requestId,requestDigest;
    try{requestId=checkoutReliability.requestKey(body,customerAccount);if(requestId)requestDigest=checkoutReliability.digest(body,id);}catch(e){return sendJson(res,e.statusCode||400,{error:e.message});}
    const pendingKey=requestId?customerAccount.id+':'+requestId:null;
    if(pendingKey){
      const pending=checkoutPending.get(pendingKey);
      if(pending){if(pending.digest!==requestDigest)return sendJson(res,409,{error:'Η προηγούμενη υποβολή έχει διαφορετικά στοιχεία.'});try{await pending.saved;}catch{return sendJson(res,503,{error:'Η προηγούμενη υποβολή δεν επιβεβαιώθηκε. Δοκίμασε ξανά.'});}}
      const prior=state.orders.find(o=>o.customerId===customerAccount.id&&o.checkoutRequestId===requestId);
      if(prior){if(prior.checkoutDigest!==requestDigest)return sendJson(res,409,{error:'Η προηγούμενη υποβολή έχει διαφορετικά στοιχεία.'});return sendJson(res,200,{order:publicOrder(prior),trackingUrl:'/app/customer/?order='+encodeURIComponent(prior.id),replayed:true});}
    }
    if(!store||!store.active)return sendJson(res,404,{error:'Το κατάστημα δεν είναι διαθέσιμο.'});
    if(store.id!=='default'&&!customerAccount)return sendJson(res,401,{error:'Συνδέσου στον δοκιμαστικό λογαριασμό σου.'});
    let payment;
    try { payment = checkoutPayment(body, customerAccount); } catch (error) { return sendJson(res, error.statusCode || 400, {error:error.message}); }
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
      const product = store.products.find(p => p.id === String(row.productId) && p.active);
      const qty = Number(row.qty);
      if (!product || !Number.isInteger(qty) || qty < 1 || qty > 20) return sendJson(res, 400, { error: 'Μη έγκυρο προϊόν ή ποσότητα.' });
      lines.push({ productId: product.id, name: product.name, unitPrice: product.price, qty, lineTotal: round2(product.price * qty) });
    }
    try{checkoutReliability.checkUniqueItems(lines);if(requestId)checkoutReliability.verifyQuote(body,lines,store.settings.shopDeliveryFee||0);}catch(e){return sendJson(res,e.statusCode||400,{error:e.message});}
    const subtotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
    // Server-side quote: never trust client-provided service fee or commission.
    const pricingSnapshot = priceOrder(Math.round(subtotal * 100), Math.round((store.settings.shopDeliveryFee||0) * 100));
    let deliveryQuote;
    try{deliveryQuote=storeOperations.checkCheckout(state,store,{lat:deliveryLat,lng:deliveryLng},subtotal);}catch(e){return sendJson(res,e.statusCode||400,{error:e.message});}
    const order = {
      id: crypto.randomUUID(), storeId: store.id, items: lines, subtotal,
      ...payment, ...deliveryQuote, ...(requestId?{checkoutRequestId:requestId,checkoutDigest:requestDigest}:{}),customerId: customerAccount?.id || null, trackingPrivate: Boolean(customerAccount),
      customerName, customerPhone, deliveryAddress,
      deliveryLocation: { lat: deliveryLat, lng: deliveryLng },
      serviceFee: SERVICE_FEE_CENTS / 100, deliveryFee: round2(store.settings.shopDeliveryFee||0),
      total: round2(pricingSnapshot.customerTotalCents / 100),
      billingModel: 'shop-percent-v2', shopFeeCents: pricingSnapshot.commissionGrossCents,
      pricingSnapshot, completedAt: null,
      status: 'new', createdAt: nowIso(), updatedAt: nowIso(),
      estimatedKm: null, badWeather: false, riderPayEstimate: null,
      assignedRider: null, assignedRiderName: null, riderLocation: null, deliveryManagedByShop: false
    };
    state.orders.push(order);
    const saved=persistState();if(pendingKey)checkoutPending.set(pendingKey,{digest:requestDigest,saved});
    try{await saved;}catch(e){state.orders=state.orders.filter(o=>o.id!==order.id);return sendJson(res,503,{error:'Η αποθήκευση δεν επιβεβαιώθηκε. Δοκίμασε ξανά.'});}finally{if(pendingKey)checkoutPending.delete(pendingKey);}
    return sendJson(res, 201, { order: publicOrder(order), trackingUrl: `/app/customer/?order=${encodeURIComponent(order.id)}` });
  }

  const publicTracking = pathname.match(/^\/api\/orders\/([0-9a-f-]+)$/i);
  if (method === 'GET' && publicTracking) {
    const order = state.orders.find(item => item.id === publicTracking[1]);
    if (order && (order.customerId || order.trackingPrivate)) {
      const customer=getSession(req,'customer');
      const role=String(req.headers['x-fd-role']||'');
      const staff=['admin','shop','rider'].includes(role)?getSession(req,role):null;
      const staffAllowed=staff && (staff.role==='admin'||(staff.role==='shop'&&(order.storeId||'default')===staff.storeId)||(staff.role==='rider'&&order.assignedRider===staff.userId));
      if (!(customer && order.customerId && customer.userId===order.customerId) && !staffAllowed) return sendJson(res,404,{error:'Η παραγγελία δεν βρέθηκε.'});
    }
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
        if (!rider || rider.active === false || (rider.storeId||'default') !== (order.storeId||'default')) return sendJson(res, 400, { error: 'Επίλεξε ενεργό διανομέα του καταστήματος.' });
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
    if (session.role === 'shop' && status === 'ready' && body.autoAssign === true) {
      order.dispatchRequestedAt = order.updatedAt;
    }
    if (order.dispatchRequestedAt || ['delivered', 'cancelled'].includes(status)) {
      dispatchReadyOrders(state, order.storeId || 'default', order.updatedAt);
    }
    if(status==='delivered' && ['shop-fixed-v1','shop-percent-v2'].includes(order.billingModel)) order.completedAt=order.updatedAt;
    if (['delivered', 'cancelled'].includes(status)) order.riderLocation = null;
    await persistState();
    return sendJson(res, 200, { order: privateOrder(order) });
  }

  if(method==='GET' && pathname==='/api/shop/billing'){
    const session=requireRole(req,res,['shop','admin']);if(!session)return;
    const storeId=session.role==='admin'?validStoreId(url.searchParams.get('storeId')||'default'):session.storeId||'default';
    if(!storeId||!getStore(state,storeId))return sendJson(res,404,{error:'Το κατάστημα δεν βρέθηκε.'});
    return sendJson(res,200,{...settlementSummary(state.orders,state.shopSettlements,storeId),payout:visiblePayout(state.shopPayout,session.role),hold:state.shopHolds[storeId]||{suspended:false},holdHistory:state.shopHoldHistory.filter(x=>x.storeId===storeId).slice(-30)});
  }
  if(method==='PATCH' && ['/api/admin/shop-payout','/api/admin/shop-hold'].includes(pathname)){
    const session=requireRole(req,res,['admin']);if(!session)return;
    const origin=req.headers.origin;
    if(origin&&origin!=='https://'+req.headers.host&&origin!=='http://'+req.headers.host)return sendJson(res,403,{error:'Μη επιτρεπόμενη προέλευση.'});
    if(!rateLimit(authWindows,'shop-controls:'+clientIp(req),15,15*60_000))return sendJson(res,429,{error:'Πολλές προσπάθειες.'});
    const body=await readJson(req,4096);
    if(!(await adminPasswordMatches(String(body.adminCode||''))))return sendJson(res,403,{error:'Απαιτείται επιβεβαίωση με τον κωδικό Admin.'});
    const storeId=validStoreId(body.storeId||'default');if(!storeId||!getStore(state,storeId))return sendJson(res,404,{error:'Το κατάστημα δεν βρέθηκε.'});
    if(pathname.endsWith('shop-payout')){
      let payout;
      try{payout=paymentDetails(body);}catch(e){return sendJson(res,e.statusCode||400,{error:e.message});}
      const old=state.shopPayout;state.shopPayout=payout;
      try{await persistState();}catch(e){state.shopPayout=old;throw e;}
      return sendJson(res,200,{payout});
    }
    const old=state.shopHolds[storeId];let hold;
    try{hold=shopHold(body,old,settlementSummary(state.orders,state.shopSettlements,storeId));}catch(e){return sendJson(res,e.statusCode||400,{error:e.message});}
    const entry={...hold,storeId,id:crypto.randomUUID()};state.shopHolds[storeId]=hold;state.shopHoldHistory.push(entry);
    try{await persistState();}catch(e){if(old)state.shopHolds[storeId]=old;else delete state.shopHolds[storeId];state.shopHoldHistory=state.shopHoldHistory.filter(x=>x.id!==entry.id);throw e;}
    return sendJson(res,200,{hold});
  }
  if(method==='POST' && pathname==='/api/admin/shop-settlements'){
    const session=requireRole(req,res,['admin']);if(!session)return;
    const body=await readJson(req,1024);
    if(body.confirmPilot!==true)return sendJson(res,400,{error:'Απαιτείται επιβεβαίωση ότι η καταχώριση είναι αποκλειστικά δοκιμαστική.'});
    const storeId=validStoreId(body.storeId||'default');if(!storeId||!getStore(state,storeId))return sendJson(res,404,{error:'Το κατάστημα δεν βρέθηκε.'});
    let entry;
    try{entry=recordSettlement(state.orders,state.shopSettlements,storeId,body.day,body.expectedCents);}
    catch(error){return sendJson(res,error.statusCode||400,{error:error.message});}
    state.shopSettlements.push(entry);
    try{await persistState();}catch(error){state.shopSettlements=state.shopSettlements.filter(x=>x.id!==entry.id);throw error;}
    return sendJson(res,201,{settlement:entry,...settlementSummary(state.orders,state.shopSettlements,storeId)});
  }

  if(method==='GET'&&pathname==='/api/admin/migration/preflight'){
    const admin=requireRole(req,res,['admin']);if(!admin)return;
    if(!rateLimit(requestWindows,'migration-preview:'+clientIp(req),5,5*60*1000))return sendJson(res,429,{error:'Πολλοί έλεγχοι σε μικρό χρονικό διάστημα.'});
    if(!process.env.FD_MIGRATION_TARGET_DATABASE_URL)return sendJson(res,503,{error:'Η νέα βάση δεν έχει συνδεθεί στο Render.'});
    if(!postgresPool)return sendJson(res,503,{error:'Δεν υπάρχει μόνιμη τρέχουσα βάση.'});
    const source=process.env.DATABASE_URL,target=process.env.FD_MIGRATION_TARGET_DATABASE_URL;
    try{
      const sourceUrl=new URL(source),targetUrl=new URL(migrationTarget.targetConnection(target));
      if(sourceUrl.hostname===targetUrl.hostname&&sourceUrl.pathname===targetUrl.pathname)return sendJson(res,409,{error:'Η νέα βάση είναι ήδη η τρέχουσα.'});
      await writeQueue;
      const old=(await postgresPool.query('SELECT body FROM fair_delivery_state WHERE id=1')).rows[0]?.body;
      if(!old)return sendJson(res,503,{error:'Δεν υπάρχει μητρώο στην τρέχουσα βάση.'});
      const integrity=migrationTools.validateSnapshot(old);
      const destination=migrationTarget.targetPool(target);
      try{
        const status=await migrationTarget.destinationState(destination);
        return sendJson(res,200,{source:{digest:integrity.digest,counts:integrity.counts},destination:{empty:status.recordCount===0,recordCount:status.recordCount},maintenance:process.env.FD_MAINTENANCE_MODE==='true',copyAvailable:process.env.FD_MAINTENANCE_MODE==='true'&&status.recordCount===0});
      }finally{await destination.end();}
    }catch{return sendJson(res,503,{error:'Ο έλεγχος σύνδεσης ή ακεραιότητας απέτυχε.'});}
  }
  if(method==='POST'&&pathname==='/api/admin/migration/copy'){
    const admin=requireRole(req,res,['admin']);if(!admin)return;
    const origin=req.headers.origin;
    if(origin&&origin!=='https://'+req.headers.host&&origin!=='http://'+req.headers.host)return sendJson(res,403,{error:'Μη επιτρεπόμενη προέλευση.'});
    if(process.env.FD_MAINTENANCE_MODE!=='true')return sendJson(res,409,{error:'Η εγγραφή στη νέα βάση επιτρέπεται μόνο όταν έχουν κλείσει οι καταχωρίσεις.'});
    if(!postgresPool||!process.env.FD_MIGRATION_TARGET_DATABASE_URL)return sendJson(res,503,{error:'Δεν έχουν συνδεθεί η αρχική και η νέα βάση.'});
    if(migrationCopyBusy)return sendJson(res,409,{error:'Εκκρεμεί άλλη μεταφορά.'});
    if(!rateLimit(authWindows,'migration-copy:'+clientIp(req),3,15*60*1000))return sendJson(res,429,{error:'Πολλές προσπάθειες μεταφοράς.'});
    const body=await readJson(req,4096);
    if(!(await adminPasswordMatches(String(body.adminCode||''))))return sendJson(res,403,{error:'Απαιτείται επαλήθευση κωδικού Admin.'});
    if(body.confirmDownloadedBackup!==true||body.confirmNewDatabase!==true||typeof body.expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(body.expectedDigest))return sendJson(res,400,{error:'Χρειάζεται επαληθευμένο κρυπτογραφημένο αντίγραφο και ακριβές SHA-256.'});
    try{
      const sourceUrl=new URL(process.env.DATABASE_URL),targetUrl=new URL(migrationTarget.targetConnection(process.env.FD_MIGRATION_TARGET_DATABASE_URL));
      if(sourceUrl.hostname===targetUrl.hostname&&sourceUrl.pathname===targetUrl.pathname)return sendJson(res,409,{error:'Δεν επιτρέπεται αντιγραφή προς την ίδια βάση.'});
    }catch{return sendJson(res,503,{error:'Δεν είναι ασφαλής ο προορισμός.'});}
    migrationCopyBusy=true;
    try{
      await writeQueue;
      const old=(await postgresPool.query('SELECT body FROM fair_delivery_state WHERE id=1')).rows[0]?.body;
      if(!old)return sendJson(res,503,{error:'Δεν βρέθηκε η αρχική βάση.'});
      const integrity=migrationTools.validateSnapshot(old);
      if(integrity.digest!==body.expectedDigest)return sendJson(res,409,{error:'Το αποθηκευμένο μητρώο διαφέρει από το αντίγραφο. Πάρε και έλεγξε νέο backup.'});
      const destination=migrationTarget.targetPool(process.env.FD_MIGRATION_TARGET_DATABASE_URL);
      try{
        const copied=await migrationTarget.copyIntoNewDatabase(destination,old);
        return sendJson(res,200,{copied:true,sourceUnchanged:true,cutoverDone:false,integritySha256:copied.digest,counts:copied.counts});
      }finally{await destination.end();}
    }catch{return sendJson(res,503,{error:'Η αντιγραφή δεν ολοκληρώθηκε ή δεν επιβεβαιώθηκε. Η αρχική βάση δεν άλλαξε.'});}
    finally{migrationCopyBusy=false;}
  }

  if(method==='GET'&&pathname==='/api/admin/storage/verify'){
    const session=requireRole(req,res,['admin']);if(!session)return;
    if(!rateLimit(requestWindows,'admin-storage:'+clientIp(req),12,60*1000))return sendJson(res,429,{error:'Πολλοί έλεγχοι σε μικρό χρονικό διάστημα.'});
    try{
      await writeQueue;
      let snapshot,updatedAt=null;
      if(postgresPool){
        const record=await postgresPool.query('SELECT body, updated_at FROM fair_delivery_state WHERE id = 1');
        if(record.rows.length!==1)return sendJson(res,503,{error:'Δεν βρέθηκε αποθηκευμένο μητρώο.'});
        snapshot=record.rows[0].body;updatedAt=record.rows[0].updated_at;
      }else{
        snapshot=JSON.parse(await fs.promises.readFile(STATE_FILE,'utf8'));
      }
      const integrity=migrationTools.validateSnapshot(snapshot);
      const expires=process.env.FD_STORAGE_EXPIRES_AT||null;
      return sendJson(res,200,{storage:postgresPool?'postgres':'temporary-file',stored:true,integritySha256:integrity.digest,counts:integrity.counts,lastPersistedAt:updatedAt,expiresAt:expires});
    }catch{
      return sendJson(res,503,{error:'Αποτυχία επαλήθευσης μόνιμης αποθήκευσης.'});
    }
  }

  if(method==='POST'&&pathname==='/api/admin/backup'){
    const session=requireRole(req,res,['admin']);if(!session)return;
    const origin=req.headers.origin;
    if(origin&&origin!=='https://'+req.headers.host&&origin!=='http://'+req.headers.host)return sendJson(res,403,{error:'Μη επιτρεπόμενη προέλευση.'});
    if(!rateLimit(authWindows,'backup:'+clientIp(req),4,15*60_000))return sendJson(res,429,{error:'Πολλές προσπάθειες.'});
    const body=await readJson(req,4096);
    if(!(await adminPasswordMatches(String(body.adminCode||''))))return sendJson(res,403,{error:'Χρειάζεται ο κωδικός Admin.'});
    if(body.confirm!==true||!encryptedBackup.validPhrase(body.passphrase))return sendJson(res,400,{error:'Επιβεβαίωσε την εξαγωγή και φράση κρυπτογράφησης 20–256 χαρακτήρων.'});
    if(backupBusy)return sendJson(res,409,{error:'Εκκρεμεί άλλη εξαγωγή.'});
    backupBusy=true;
    try{
      await writeQueue;
      const snapshot=postgresPool?(await postgresPool.query('SELECT body FROM fair_delivery_state WHERE id=1')).rows[0]?.body:JSON.parse(await fs.promises.readFile(STATE_FILE,'utf8'));
      if(!snapshot||typeof snapshot!=='object')return sendJson(res,503,{error:'Δεν βρέθηκε αποθηκευμένο αντίγραφο.'});
      const envelope=await encryptedBackup.encryptBackup(snapshot,body.passphrase);
      return sendJson(res,200,envelope);
    }catch(e){return sendJson(res,503,{error:'Η κρυπτογραφημένη εξαγωγή δεν ολοκληρώθηκε.'});}finally{backupBusy=false;}
  }

  if (method === 'GET' && pathname === '/api/stats') {
    const session = requireRole(req, res, ['admin']); if (!session) return;
    const today = athensDay();
    const todayOrders = state.orders.filter(o => athensDay(o.createdAt)===today);
    const platformFeeToday=allStores(state).reduce((sum,store)=>sum+(settlementSummary(state.orders,state.shopSettlements,store.id,today).days.find(d=>d.day===today)?.feeCents||0),0)/100;
    return sendJson(res, 200, {
      activeOrders: state.orders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
      ordersToday: todayOrders.length,
      deliveredToday: todayOrders.filter(o => o.status === 'delivered').length,
      grossValueToday: round2(todayOrders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.subtotal, 0)),
      shopsCommissionToday: round2(todayOrders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.subtotal * state.settings.shopCommissionPercent / 100, 0)),
      riderCountOnline: Object.values(state.riders).filter(r => r.online).length,
      platformFeeToday
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
        if (key === 'customerServiceFee' && value !== SERVICE_FEE_CENTS / 100) return sendJson(res,400,{error:'Η νέα χρέωση πελάτη είναι σταθερά 2,30 € (συμπεριλαμβανομένου ΦΠΑ υπηρεσίας).'});
        if (key === 'shopCommissionPercent' && value !== COMMISSION_BPS / 100) return sendJson(res,400,{error:'Η νέα προμήθεια καταστήματος είναι 8% επί των προϊόντων, συν ΦΠΑ υπηρεσίας.'});
        settings[key] = round2(value);
      }
    }
    state.settings = settings;
    await persistState();
    return sendJson(res, 200, { settings: state.settings });
  }

  if (method === 'POST' && pathname === '/api/admin/shop-code') {
    const session = requireRole(req, res, ['admin']); if (!session) return;
    const body=await readJson(req,1024);
    const storeId=validStoreId(body.storeId||'default'),store=storeId&&getStore(state,storeId);
    if(!store)return sendJson(res,404,{error:'Το κατάστημα δεν βρέθηκε.'});
    const accessCode = crypto.randomBytes(18).toString('base64url');
    const codeSalt = crypto.randomBytes(16).toString('hex');
    const credential={codeSalt,codeHash:await riderCodeHash(accessCode,codeSalt),updatedAt:nowIso()};
    if(storeId==='default')state.shopCredential=credential;else Object.assign(store,credential);
    for(const [token,old] of sessions)if(old.role==='shop'&&old.storeId===storeId)sessions.delete(token);
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

  if(pathname==='/api/shop/operations'&&['GET','PATCH'].includes(method)){
    const session=requireRole(req,res,['shop']);if(!session)return;
    const store=getStore(state,session.storeId||'default');
    if(!store)return sendJson(res,404,{error:'Το κατάστημα δεν βρέθηκε.'});
    const current=storeOperations.settings(store);
    if(method==='GET')return sendJson(res,200,{operations:current,store:publicStore(state,store)});
    const origin=req.headers.origin;
    if(origin&&origin!=='https://'+req.headers.host&&origin!=='http://'+req.headers.host)return sendJson(res,403,{error:'Μη επιτρεπόμενη προέλευση.'});
    const body=await readJson(req,4096);
    let next;
    try{next=storeOperations.validated(Object.keys(body).length===1&&typeof body.paused==='boolean'?{...current,paused:body.paused}:body);}catch(e){return sendJson(res,e.statusCode||400,{error:e.message});}
    if(next.radiusKm!==null&&!store.settings.storeLocation)return sendJson(res,409,{error:'Όρισε πρώτα το σημείο καταστήματος στον χάρτη.'});
    const old=store.settings.operations;store.settings.operations=next;
    try{await persistState();}catch(e){if(old)store.settings.operations=old;else delete store.settings.operations;throw e;}
    return sendJson(res,200,{operations:next,store:publicStore(state,store)});
  }

  if (method === 'POST' && pathname === '/api/shop/location') {
    const session = requireRole(req, res, ['shop', 'admin']); if (!session) return;
    const body = await readJson(req, 4096);
    const lat = Number(body.lat); const lng = Number(body.lng);
    if (!validPoint(body)) return sendJson(res, 400, { error: 'Μη έγκυρες συντεταγμένες καταστήματος.' });
    const settings=getStore(state,session.storeId||'default').settings;
    settings.storeLocation = { lat, lng, updatedAt: nowIso() };
    await persistState();
    return sendJson(res, 200, { storeLocation: settings.storeLocation });
  }

  if (method === 'POST' && pathname === '/api/shop/delivery-fee') {
    const session = requireRole(req, res, ['shop', 'admin']); if (!session) return;
    const body = await readJson(req, 4096);
    if (typeof body.deliveryFee !== 'number') return sendJson(res, 400, { error: 'Δώσε το κόστος διανομής σε ευρώ.' });
    const settings=getStore(state,session.storeId||'default').settings;
    settings.shopDeliveryFee = validateMoney(body.deliveryFee, 'Κόστος διανομής', 50);
    await persistState();
    return sendJson(res, 200, { deliveryFee: settings.shopDeliveryFee });
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
    else dispatchReadyOrders(state, state.riders[session.userId].storeId || 'default', nowIso());
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

  if(method==='POST'&&pathname==='/api/assistant'){
    const session=requireRole(req,res,['admin']);if(!session)return;
    const origin=req.headers.origin;
    if(origin&&origin!=='https://'+req.headers.host&&origin!=='http://'+req.headers.host)return sendJson(res,403,{error:'Μη επιτρεπόμενη προέλευση.'});
    const body=await readJson(req,12*1024);
    if(body.report){
      const answer=fairAssistant.localReport(state,body.report);
      return answer?sendJson(res,200,{answer,mode:'local-report'}):sendJson(res,400,{error:'Άγνωστη αναφορά.'});
    }
    const message=typeof body.message==='string'?body.message.trim():'';
    if(!message||message.length>2000)return sendJson(res,400,{error:'Γράψε ερώτηση έως 2.000 χαρακτήρες.'});
    if(body.externalConfirmed!==true)return sendJson(res,200,{answer:offlineHelp(message),mode:'guide'});
    if(!fairAssistant.configured())return sendJson(res,503,{error:'Ο Groq AI δεν έχει συνδεθεί ακόμα. Χρειάζεται κλειδί δωρεάν λογαριασμού και επιβεβαίωση του Free plan.'});
    if(!rateLimit(aiWindows,'groq-global',10,10*60*1000))return sendJson(res,429,{error:'Όριο 10 AI ερωτήσεων ανά 10 λεπτά. Δοκίμασε αργότερα.'});
    if(!rateLimit(aiWindows,'groq-day',100,24*60*60*1000))return sendJson(res,429,{error:'Ημερήσιο όριο AI. Οι τοπικές αναφορές παραμένουν διαθέσιμες.'});
    try{
      const result=await fairAssistant.askGroq(message);
      if(result.status==='private')return sendJson(res,400,{error:'Αφαίρεσε προσωπικά στοιχεία, αριθμούς λογαριασμών και μυστικά από την ερώτηση.'});
      if(result.status==='quota')return sendJson(res,429,{error:'Ο Groq έφτασε το διαθέσιμο όριο. Δεν γίνεται μετάβαση σε πληρωμένο πάροχο.'});
      if(result.status==='ok')return sendJson(res,200,{answer:result.answer,mode:'ai',model:fairAssistant.MODEL,truncated:result.truncated===true});
      return sendJson(res,502,{error:'Ο Groq δεν είναι διαθέσιμος. Δοκίμασε αργότερα ή χρησιμοποίησε τις τοπικές αναφορές.'});
    }catch(e){return sendJson(res,502,{error:'Δεν ήταν δυνατή η σύνδεση με τον Groq. Δοκίμασε αργότερα.'});}
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
    if(role==='admin')content += `self.addEventListener('push',event=>{event.waitUntil((async()=>{let payload={};try{payload=event.data?event.data.json():{};}catch{}if(!['new-application','test-notification'].includes(payload.type))return;const isTest=payload.type==='test-notification';await self.registration.showNotification(isTest?'Δοκιμαστική ειδοποίηση':'Νέο αίτημα στο Fair Delivery',{body:isTest?'Οι ειδοποιήσεις του Fair Delivery λειτουργούν.':'Υπάρχει νέο αίτημα. Άνοιξε τις Αιτήσεις.',tag:'fd-request-'+String(payload.id||Date.now()),icon:'/app/admin/icon-192.png',badge:'/app/admin/icon-192.png',data:{url:'/app/admin/#applications'}});})());});self.addEventListener('notificationclick',event=>{event.notification.close();event.waitUntil((async()=>{const target=new URL('/app/admin/#applications',self.location.origin);const windows=await clients.matchAll({type:'window',includeUncontrolled:true});for(const w of windows){if(new URL(w.url).origin===target.origin&&new URL(w.url).pathname.startsWith('/app/admin/')){await w.focus();w.navigate(target.href);return;}}await clients.openWindow(target.href);})());});`;
    mime='application/javascript; charset=utf-8';
  } else {
    content = `<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fair Delivery — Χωρίς σύνδεση</title><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#0a0d15;color:#fff;font:16px system-ui;text-align:center;padding:24px}section{max-width:400px}a{color:#ff6b76}</style></head><body><section><h1>Fair Delivery ${config.label}</h1><p>Δεν υπάρχει σύνδεση στο διαδίκτυο. Για τις ζωντανές παραγγελίες χρειάζεται πρόσβαση στο δίκτυο.</p><a href="${scope}">Δοκίμασε ξανά</a></section></body></html>`;
    mime='text/html; charset=utf-8';
  }
  res.writeHead(200, {'Content-Type':mime,'Cache-Control':cacheControl,'X-Content-Type-Options':'nosniff'});
  res.end(req.method==='HEAD'?undefined:content);
  return true;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const PUBLIC_FILES = new Set(['google36c42afe351a4083.html', 'discover.html', 'robots.txt', 'sitemap.xml', 'index.html', 'customer-app.html', 'shop-app.html', 'Rider-App.html', 'admin.js', 'customer.js', 'shop.js', 'rider.js', 'assets/app.css', 'assets/common.js', 'assets/pwa.js', 'assets/v2.css', 'assets/pita.webp', 'assets/neighborhood.webp', 'assets/shell.js', 'courier-apply.html', 'courier-apply.js', 'courier-interest.js', 'courier-qualification.html', 'customer-account.js']);
async function serveStatic(req, res, url) {
  let requested = decodeURIComponent(url.pathname === '/' ? '/discover.html' : url.pathname).replace(/^\/+/, '');
  if (!PUBLIC_FILES.has(requested)) return sendJson(res, 404, { error: 'Η σελίδα δεν βρέθηκε.' });
  const file = path.join(__dirname, 'public', requested);
  try {
    const content = await fs.promises.readFile(file);
    const privatePage = new Set(['index.html', 'shop-app.html', 'Rider-App.html']).has(requested);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Cache-Control': requested.endsWith('.html') || requested === 'robots.txt' || requested === 'sitemap.xml' ? 'no-cache' : 'public, max-age=3600',
      ...(privatePage ? { 'X-Robots-Tag': 'noindex, nofollow' } : {})
    });
    res.end(req.method === 'HEAD' ? undefined : content);
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
