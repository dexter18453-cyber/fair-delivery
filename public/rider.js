'use strict';
const $ = id => document.getElementById(id);
let online = false; let poller = null; let geoWatch = null; let riderMap = null; let riderMarker = null; let routeLayers = [];
const MAP_CENTER = [37.97, 23.67];
function initRiderMap() { if (!window.L || riderMap) return; riderMap = L.map('riderMap').setView(MAP_CENTER, 12); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(riderMap); setTimeout(() => riderMap.invalidateSize(), 150); }
function updateRiderPosition(lat, lng) { if (!riderMap) initRiderMap(); if (!riderMap) return; const p = [lat, lng]; if (!riderMarker) riderMarker = L.marker(p).addTo(riderMap).bindPopup('Η θέση μου'); else riderMarker.setLatLng(p); riderMap.setView(p, 15); }
function drawOrders(orders) { if (!riderMap) return; routeLayers.forEach(layer => riderMap.removeLayer(layer)); routeLayers = []; const points = []; for (const o of orders) { if (!o.deliveryLocation) continue; const p = [o.deliveryLocation.lat, o.deliveryLocation.lng]; points.push(p); routeLayers.push(L.marker(p).addTo(riderMap).bindPopup(`Παράδοση ${FD.esc(o.id.slice(0, 8))}<br>${FD.esc(o.deliveryAddress || '')}`)); if (o.riderLocation) { const rp = [o.riderLocation.lat, o.riderLocation.lng]; points.push(rp); routeLayers.push(L.polyline([rp, p], { color: '#17b890', weight: 5, opacity: .85, dashArray: '8 8' }).addTo(riderMap)); } } if (points.length) riderMap.fitBounds(L.latLngBounds(points).pad(.25)); }
let trips = [];
let editingTrip = null;
let rates = null;
const drafts = new Map();
function closeTrip() {
  editingTrip = null;
  $('tripEditor').classList.add('hidden');
}
function previewTrip() {
  if (!editingTrip) return;
  const input = $('km');
  const km = input.valueAsNumber;
  drafts.set(editingTrip, { km: input.value, weather: $('weather').checked });
  if (!rates) $('tripPreview').textContent = 'Οι τιμές εκτίμησης δεν είναι διαθέσιμες.';
  else {
    const base = rates.riderBaseAmount, perKm = rates.riderPerKm;
    const bonus = $('weather').checked ? rates.badWeatherBonus : 0;
    const formula = 'Βάση ' + FD.money(base) + ' + ' + FD.money(perKm) + '/χλμ.' + (bonus ? ' + ' + FD.money(bonus) + ' κακοκαιρία' : '');
    $('tripPreview').textContent = Number.isFinite(km) && input.validity.valid
      ? formula + ' · Πιλοτική εκτίμηση ' + FD.money(base + km * perKm + bonus)
      : formula + ' · Συμπλήρωσε τη συνολική απόσταση για εκτίμηση.';
  }
}
function openTrip(id) {
  const order = trips.find(o => o.id === id);
  if (!order) return;
  editingTrip = id;
  $('tripTitle').textContent = 'Αμοιβή διαδρομής · ' + id.slice(0,8);
  $('km').value = drafts.get(id)?.km ?? order.estimatedKm ?? '';
  $('weather').checked = drafts.get(id)?.weather ?? order.badWeather;
  $('finishTrip').hidden = order.status !== 'picked_up';
  $('tripEditor').classList.remove('hidden');
  previewTrip();
  $('tripEditor').scrollIntoView({block:'center'});
}
$('closeTrip').onclick = closeTrip;
$('km').oninput = previewTrip;
$('weather').onchange = previewTrip;
$('finishTrip').onclick = async () => {
  const id = editingTrip;
  if (!id || !$('km').reportValidity()) return;
  const payload = {status:'delivered', badWeather:$('weather').checked};
  if ($('km').value !== '') payload.estimatedKm = $('km').valueAsNumber;
  $('finishTrip').disabled = true;
  try {
    const {order} = await FD.api('/api/orders/' + encodeURIComponent(id), {method:'PATCH',body:JSON.stringify(payload)});
    closeTrip();
    drafts.delete(id);
    FD.notice('notice', 'Η παράδοση ολοκληρώθηκε.' + (order.riderPayEstimate == null ? ' Χωρίς εκτίμηση απόστασης.' : ' Πιλοτική αμοιβή ' + FD.money(order.riderPayEstimate)));
    await loadOrders();
  } catch(e) { FD.notice('notice', e.message, true); }
  finally { $('finishTrip').disabled = false; }
};
async function loadOrders() { const r = await FD.api('/api/orders'); const orders = r.orders; trips = orders; if (editingTrip && !orders.some(o => o.id === editingTrip)) closeTrip(); $('orders').innerHTML = orders.length ? orders.map(o => `<article class="order"><div class="row"><h3>Παραγγελία ${FD.esc(o.id.slice(0, 8))}</h3><span class="status">${FD.esc(FD.status(o.status))}</span></div><div class="meta">${new Date(o.createdAt).toLocaleString('el-GR')} · Αξία παραγγελίας ${FD.money(o.total)}</div><div class="meta">Τρόπος πληρωμής: ${FD.esc(({cash:"Μετρητά",card:"Κάρτα",iris:"IRIS"})[o.paymentMethod]||"—")} · Πιλοτικό — καμία είσπραξη</div><div class="order-contact"><b>${FD.esc(o.customerName || 'Πελάτης')}</b> · <a href="tel:${FD.esc(o.customerPhone || '')}">${FD.esc(o.customerPhone || '—')}</a><br>${FD.esc(o.deliveryAddress || 'Δεν υπάρχει διεύθυνση')}</div><ul class="muted-list">${o.items.map(i => `<li>${FD.esc(i.name)} × ${i.qty}</li>`).join('')}</ul><div class="actions">${o.status === 'assigned' ? `<button data-status="picked_up" data-id="${o.id}">Παρέλαβα από κατάστημα</button><button class="secondary" data-trip="${o.id}">Εκτίμηση αμοιβής</button>` : ''}${o.status === 'picked_up' ? `<button data-trip="${o.id}">Ολοκλήρωση παράδοσης</button>` : ''}${o.status === 'delivered' ? `<span class="price">Εκτιμώμενη αμοιβή: ${o.riderPayEstimate == null ? '—' : FD.money(o.riderPayEstimate)}</span>` : ''}</div></article>`).join('') : '<p class="hint">Δεν έχει ανατεθεί ακόμη παραγγελία σε εσένα.</p>';
  document.querySelectorAll('[data-trip]').forEach(b => b.onclick = () => openTrip(b.dataset.trip));
  document.querySelectorAll('[data-status]').forEach(b => b.onclick = async () => { try { const payload = { status: b.dataset.status }; await FD.api(`/api/orders/${b.dataset.id}`, { method: 'PATCH', body: JSON.stringify(payload) }); FD.notice('notice', 'Η κατάσταση της παραγγελίας ενημερώθηκε.'); await loadOrders(); } catch (e) { FD.notice('notice', e.message, true); } });
  drawOrders(orders);
}
function updateAvailability() {
  $('onlineBtn').textContent = online ? 'GO OFFLINE' : 'GO ONLINE';
  $('onlineText').textContent = online ? 'Είσαι online και διαθέσιμος για αναθέσεις.' : 'Είσαι offline.';
  $('gpsBtn').disabled = !online;
  $('gpsBtn').textContent = geoWatch === null ? 'Κοινοποίηση θέσης' : 'Παύση κοινοποίησης';
}
function startPolling() {
  if (!poller) poller = setInterval(() => loadOrders().catch(e => FD.notice('notice', e.message, true)), 7000);
}
function startGps() {
  if (!online) return;
  if (!navigator.geolocation) { $('locationText').textContent = 'Ο browser δεν υποστηρίζει γεωεντοπισμό.'; return; }
  if (geoWatch !== null) return;
  $('locationText').textContent = 'Αναμονή άδειας τοποθεσίας…';
  let lastSent = 0;
  geoWatch = navigator.geolocation.watchPosition(async pos => {
    if (!online) return;
    const { latitude: lat, longitude: lng } = pos.coords;
    updateRiderPosition(lat, lng);
    const now = Date.now(); if (now - lastSent < 8000) return; lastSent = now;
    try { await FD.api('/api/rider/location', { method: 'POST', body: JSON.stringify({ lat, lng }) }); $('locationText').textContent = `Η θέση ενημερώθηκε στις ${new Date().toLocaleTimeString('el-GR')}.`; }
    catch (e) { $('locationText').textContent = e.message; }
  }, err => {
    stopGps();
    $('locationText').textContent = 'Η κοινοποίηση θέσης δεν είναι διαθέσιμη: ' + err.message;
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 });
  updateAvailability();
}
function stopGps() {
  if (geoWatch !== null && navigator.geolocation) navigator.geolocation.clearWatch(geoWatch);
  geoWatch = null;
  updateAvailability();
}
async function setOnline(value) {
  try {
    await FD.api('/api/rider/status', { method: 'POST', body: JSON.stringify({ online: value }) });
    online = value; updateAvailability();
    if (online) startGps();
    else { stopGps(); $('locationText').textContent = 'Η κοινοποίηση θέσης σταμάτησε.'; }
    FD.notice('notice', online ? 'Η διαθεσιμότητα ενεργοποιήθηκε.' : 'Η διαθεσιμότητα απενεργοποιήθηκε.');
    await loadOrders();
  } catch (e) { FD.notice('notice', e.message, true); }
}
async function showApp(profile) {
  FD.api('/api/config').then(config => { rates = config.settings; previewTrip(); }).catch(() => {});
  online = profile.rider.online;
  $('login').classList.add('hidden'); $('app').classList.remove('hidden');
  $('riderGreeting').textContent = `Καλώς ήρθες, ${profile.rider.name}`;
  updateAvailability(); initRiderMap(); await loadOrders(); startPolling();
  if (online) $('locationText').textContent = 'Πάτησε «Κοινοποίηση θέσης» για να ξεκινήσεις ξανά το GPS.';
}
async function enter() {
  try {
    await FD.login('rider', $('code').value, { riderId: $('riderId').value.trim() });
    await showApp(await FD.api('/api/rider/profile'));
  } catch (e) { FD.notice('loginMsg', e.message, true); }
}
$('loginBtn').onclick = enter;
$('onlineBtn').onclick = () => setOnline(!online);
$('gpsBtn').onclick = () => {
  if (geoWatch === null) startGps();
  else { stopGps(); $('locationText').textContent = 'Η κοινοποίηση θέσης είναι σε παύση.'; }
};
$('refresh').onclick = () => loadOrders().catch(e => FD.notice('notice', e.message, true));
$('logout').onclick = async () => { stopGps(); await FD.logout('rider'); location.reload(); };
window.addEventListener('pagehide', () => { stopGps(); if (poller) clearInterval(poller); poller = null; });
window.addEventListener('pageshow', event => { if (event.persisted && !$('app').classList.contains('hidden')) startPolling(); });
(async () => { const m = await FD.me('rider'); if (m.authenticated && m.role === 'rider') await showApp(await FD.api('/api/rider/profile')); })().catch(e => FD.notice('loginMsg', e.message, true));
