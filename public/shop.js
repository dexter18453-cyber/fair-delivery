'use strict';
const $ = id => document.getElementById(id);
let shopMap = null; let storeMarker = null; let shopLayers = []; let currentDrivers = [];
const MAP_CENTER = [37.97, 23.67];
function initShopMap(storeLocation) {
  if (!window.L || shopMap) return;
  shopMap = L.map('shopMap').setView(storeLocation ? [storeLocation.lat, storeLocation.lng] : MAP_CENTER, storeLocation ? 16 : 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(shopMap);
  if (storeLocation) storeMarker = L.marker([storeLocation.lat, storeLocation.lng]).addTo(shopMap).bindPopup('Κατάστημα');
  shopMap.on('click', async e => {
    try {
      const r = await FD.api('/api/shop/location', { method: 'POST', body: JSON.stringify({ lat: e.latlng.lat, lng: e.latlng.lng }) });
      if (!storeMarker) storeMarker = L.marker(e.latlng).addTo(shopMap).bindPopup('Κατάστημα'); else storeMarker.setLatLng(e.latlng);
      $('storeLocationNote').textContent = `Αποθηκεύτηκε: ${r.storeLocation.lat.toFixed(5)}, ${r.storeLocation.lng.toFixed(5)}`;
    } catch (err) { FD.notice('notice', err.message, true); }
  });
  setTimeout(() => shopMap.invalidateSize(), 150);
}
async function loadDrivers() {
  const r = await FD.api('/api/shop/riders'); currentDrivers = r.riders;
  $('riders').innerHTML = currentDrivers.length ? currentDrivers.map(d => `<div class="driver-row"><div><b>${FD.esc(d.name)}</b><div class="hint">${d.online ? '● Διαθέσιμος' : '○ Εκτός σύνδεσης'} · ${d.active ? 'Ενεργός' : 'Ανενεργός'}</div></div><span class="chip">${FD.esc(d.id.slice(0, 8))}</span></div>`).join('') : '<p class="hint">Δεν έχει δημιουργηθεί ακόμη οδηγός.</p>';
}
function drawShopMap(orders, drivers, storeLocation) {
  if (!window.L || !shopMap) return;
  shopLayers.forEach(layer => shopMap.removeLayer(layer)); shopLayers = [];
  if (storeLocation) { if (!storeMarker) storeMarker = L.marker([storeLocation.lat, storeLocation.lng]).addTo(shopMap).bindPopup('Κατάστημα'); }
  for (const o of orders) if (o.deliveryLocation) {
    const p = [o.deliveryLocation.lat, o.deliveryLocation.lng];
    shopLayers.push(L.marker(p).addTo(shopMap).bindPopup(`<b>Παραγγελία ${FD.esc(o.id.slice(0, 8))}</b><br>${FD.esc(o.deliveryAddress || '')}<br>${FD.esc(FD.status(o.status))}`));
  }
  for (const d of drivers) if (d.online && Number.isFinite(d.lat) && Number.isFinite(d.lng)) {
    shopLayers.push(L.circleMarker([d.lat, d.lng], { radius: 8, color: '#17b890', fillOpacity: .9 }).addTo(shopMap).bindPopup(`Οδηγός: ${FD.esc(d.name)}`));
  }
}
async function loadOrders() {
  const [r, driverResponse, config] = await Promise.all([FD.api('/api/orders'), FD.api('/api/shop/riders'), FD.api('/api/config')]);
  currentDrivers = driverResponse.riders;
  $('riders').innerHTML = currentDrivers.length ? currentDrivers.map(d => `<div class="driver-row"><div><b>${FD.esc(d.name)}</b><div class="hint">${d.online ? '● Διαθέσιμος' : '○ Εκτός σύνδεσης'}</div></div><span class="chip">${FD.esc(d.id.slice(0, 8))}</span></div>`).join('') : '<p class="hint">Δεν έχει δημιουργηθεί ακόμη οδηγός.</p>';
  const orders = r.orders;
  $('orders').innerHTML = orders.length ? orders.map(o => {
    const assignment = o.status === 'ready' ? `<div class="assign-row"><select id="driver-${o.id}" aria-label="Επιλογή διανομέα"><option value="">Επίλεξε οδηγό</option>${currentDrivers.filter(d => d.active).map(d => `<option value="${FD.esc(d.id)}">${FD.esc(d.name)}${d.online ? ' · online' : ''}</option>`).join('')}</select><button data-assign="${o.id}">Ανάθεση οδηγού</button></div>` : '';
    const actions = o.status === 'new' ? `<button data-status="accepted" data-id="${o.id}">Αποδοχή</button><button class="danger" data-status="cancelled" data-id="${o.id}">Ακύρωση</button>` : o.status === 'accepted' ? `<button data-status="ready" data-id="${o.id}">Έτοιμη για διανομή</button>` : '';
    return `<article class="order"><div class="row"><h3>Παραγγελία ${FD.esc(o.id.slice(0, 8))}</h3><span class="status">${FD.esc(FD.status(o.status))}</span></div><div class="meta">${new Date(o.createdAt).toLocaleString('el-GR')} · ${FD.money(o.total)}</div><div class="order-contact"><b>${FD.esc(o.customerName || 'Πελάτης')}</b> · <a href="tel:${FD.esc(o.customerPhone || '')}">${FD.esc(o.customerPhone || '—')}</a><br>${FD.esc(o.deliveryAddress || 'Δεν υπάρχει διεύθυνση')}</div><ul class="muted-list">${o.items.map(i => `<li>${FD.esc(i.name)} × ${i.qty} — ${FD.money(i.lineTotal)}</li>`).join('')}</ul>${o.assignedRiderName ? `<p class="hint">Ανατέθηκε στον/στην: <b>${FD.esc(o.assignedRiderName)}</b></p>` : ''}<div class="actions">${actions}</div>${assignment}</article>`;
  }).join('') : '<p class="hint">Δεν υπάρχουν παραγγελίες.</p>';
  document.querySelectorAll('[data-status]').forEach(b => b.onclick = async () => { try { await FD.api(`/api/orders/${b.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: b.dataset.status }) }); FD.notice('notice', 'Η κατάσταση ενημερώθηκε.'); await loadOrders(); } catch (e) { FD.notice('notice', e.message, true); } });
  document.querySelectorAll('[data-assign]').forEach(b => b.onclick = async () => { try { const select = $(`driver-${b.dataset.assign}`); if (!select.value) throw new Error('Επίλεξε διανομέα πρώτα.'); await FD.api(`/api/orders/${b.dataset.assign}`, { method: 'PATCH', body: JSON.stringify({ status: 'assigned', riderId: select.value }) }); FD.notice('notice', 'Η παραγγελία ανατέθηκε στον οδηγό.'); await loadOrders(); } catch (e) { FD.notice('notice', e.message, true); } });
  if (!shopMap) initShopMap(config.storeLocation); drawShopMap(orders, currentDrivers, config.storeLocation);
}
async function enter() { try { await FD.login('shop', $('code').value); $('login').classList.add('hidden'); $('app').classList.remove('hidden'); await loadOrders(); setInterval(() => loadOrders().catch(() => {}), 8000); } catch (e) { FD.notice('loginMsg', e.message, true); } }
$('loginBtn').onclick = enter;
$('createRider').onclick = async () => { try { const name = $('riderName').value.trim(); const r = await FD.api('/api/shop/riders', { method: 'POST', body: JSON.stringify({ name }) }); $('riderName').value = ''; FD.notice('riderCodeNotice', `Οδηγός: ${r.rider.name} · ID: ${r.rider.id}
Προσωπικός κωδικός (εμφανίζεται μόνο τώρα): ${r.accessCode}`); await loadOrders(); } catch (e) { FD.notice('riderCodeNotice', e.message, true); } };
$('refresh').onclick = () => loadOrders().catch(e => FD.notice('notice', e.message, true));
$('logout').onclick = async () => { await FD.logout('shop'); location.reload(); };
(async () => { const m = await FD.me('shop'); if (m.authenticated && m.role === 'shop') { $('login').classList.add('hidden'); $('app').classList.remove('hidden'); await loadOrders(); setInterval(() => loadOrders().catch(() => {}), 8000); } })().catch(() => {});
