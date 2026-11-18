'use strict';
const crypto = require('crypto');
const METHODS = Object.freeze(['cash', 'card', 'iris']);
function fail(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
// Pilot accounts deliberately use aliases, not email or actual bank data.
function credentials(body) {
  const alias = typeof body.alias === 'string' ? body.alias.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^demo-[a-z0-9]{4,24}$/.test(alias)) fail('Χρησιμοποίησε δοκιμαστικό όνομα demo- και 4–24 λατινικά γράμματα ή αριθμούς.');
  if (password.length < 12 || password.length > 128 || Buffer.byteLength(password) > 256) fail('Χρειάζεται δοκιμαστικός κωδικός 12–128 χαρακτήρων.');
  return { alias, password };
}
function publicAccount(account) { return account ? { id: account.id, alias: account.alias, createdAt: account.createdAt, pilot: true } : null; }
function newAccount(alias, passwordHash, salt) { return { id: crypto.randomUUID(), alias, passwordHash, salt, createdAt: new Date().toISOString() }; }
function checkoutPayment(body, account) {
  const explicit = body.paymentMethod !== undefined;
  const method = explicit ? body.paymentMethod : 'cash';
  if (!METHODS.includes(method)) fail('Μη έγκυρος τρόπος πληρωμής.');
  // Legacy guest checkout is cash-only and still strictly a no-payment pilot.
  if (explicit && !account) fail('Συνδέσου σε δοκιμαστικό λογαριασμό πελάτη πρώτα.', 401);
  // No payment processor credentials, checkout initiation or webhook verification yet.
  // All methods are simulations. Never accept payment state from the browser.
  if (method !== 'cash' && body.confirmPaymentSimulation !== true) fail('Κάρτα και IRIS είναι διαθέσιμα μόνο ως δοκιμή χωρίς χρέωση.', 409);
  return { paymentMethod: method, paymentStatus: 'pilot_not_charged', paymentMode: 'simulation', paymentCollected: false };
}
module.exports = { METHODS, credentials, publicAccount, newAccount, checkoutPayment };
