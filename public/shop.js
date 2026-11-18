'use strict';
const $ = id => document.getElementById(id);
let shopMap = null; let storeMarker = null; let shopLayers = []; let currentDrivers = [];
const MAP_CENTER = [37.97, 23.67];
function renderDrivers(drivers) {
  $('riders').innerHTML = drivers.length ? drivers.map(d => `<div class="driver-row"><div style="min-width:0"><b>${FD.esc(d.name)}</b><div class="hint">${d.online ? '● Διαθέσιμος' : '○ Εκτός σύνδεσης'} · ${d.active ? 'Ενεργός' : 'Ανενεργός'}</div><div class="small" style="overflow-wrap:anywhere">ID: ${FD.esc(d.id)}</div></div><button class="secondary" data-reset-rider="${FD.esc(d.id)}">Νέος κωδικός</button></div>`).join('') : '<p class="hint">Δεν έχει δημιουργηθεί ακόμη οδηγός. Μπορείς να κάνεις διανομή από το κατάστημα χωρίς εγγραφή οδηγού.</p>';
  document.querySelectorAll('[data-reset-rider]').forEach(button => button.onclick = async () => {
    if (!confirm('Να ακυρωθεί ο προηγούμενος κωδικός αυτού του οδηγού;')) return;
    try {
      const r = await FD.api(`/api/shop/riders/${button.dataset.resetRider}/reset-code`, { method: 'POST', body: '{}' });
      FD.notice('riderCodeNotice', `ID: ${r.riderId}\nΝΕΟΣ ΚΩΔΙΚΟΣ (εμφανίζεται μόνο τώρα): ${r.accessCode}\n${r.warning || ''}`);
    } catch (e) { FD.notice('riderCodeNotice', e.message, true); }
  });
}
async function loadShopProducts() {
  const response = await FD.api('/api/shop/products');
  $('shopProducts').innerHTML = response.products.map(p => `<div class="driver-row"><div><b>${FD.esc(p.name)}</b><div class="hint">${FD.esc(p.category)} · ${FD.money(p.price)} · ${p.active ? 'Διαθέσιμο' : 'Κρυφό'}</div></div><div class="actions"><button class="secondary" data-edit-product="${FD.esc(p.id)}">Αλλαγή τιμής</button><button class="secondary" data-toggle-product="${FD.esc(p.id)}" data-active="${p.active}">${p.active ? 'Μη διαθέσιμο' : 'Ενεργοποίηση'}</button></div></div>`).join('') || '<p class="hint">Δεν υπάρχουν προϊόντα.</p>';
  document.querySelectorAll('[data-edit-product]').forEach(button => button.onclick = async () => {
    const product = response.products.find(p => p.id === button.dataset.editProduct);
    const input = prompt(`Νέα τιμή για ${product.name} σε ευρώ:`, String(product.price));
    if (input === null) return;
    const price = Number(input.replace(',', '.'));
    if (!input.trim() || !Number.isFinite(price)) return FD.notice('productNotice', 'Γράψε έγκυρη τιμή.', true);
    try { await FD.api(`/api/shop/products/${product.id}`, { method: 'PATCH', body: JSON.stringify({ price }) }); await loadShopProducts(); FD.notice('productNotice', 'Η τιμή ενημερώθηκε.'); }
    catch (e) { FD.notice('productNotice', e.message, true); }
  });
  document.querySelectorAll('[data-toggle-product]').forEach(button => button.onclick = async () => {
    try { await FD.api(`/api/shop/products/${button.dataset.toggleProduct}`, { method: 'PATCH', body: JSON.stringify({ active: button.dataset.active !== 'true' }) }); await loadShopProducts(); }
    catch (e) { FD.notice('productNotice', e.message, true); }
  });
}
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
  renderDrivers(currentDrivers);
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
  const [r, driverResponse, config, billing] = await Promise.all([FD.api('/api/orders'), FD.api('/api/shop/riders'), FD.api('/api/config'), FD.api('/api/shop/billing')]);
  $('shopBillingOutstanding').textContent=FD.money(billing.outstandingCents/100);
  $('shopPayoutInfo').textContent=billing.payout?(billing.payout.beneficiary+' · '+(billing.payout.iban?'IBAN: '+billing.payout.iban:'')+(billing.payout.irisPhone?' · IRIS: '+billing.payout.irisPhone:'')):'Δεν έχουν οριστεί στοιχεία εξόφλησης.';
  FD.notice('shopHoldNotice',billing.hold.suspended?'Αναστολή νέων παραγγελιών: '+billing.hold.reason+' · Επικοινώνησε με τον διαχειριστή για διευκρινίσεις ή εξόφληση.':'',billing.hold.suspended);
  $('shopBillingDays').innerHTML=billing.days.map(d=>`<article class="order"><b>${FD.esc(d.day)}</b><p class="hint">${d.completed} ολοκληρωμένες · Σύνολο ${FD.money(d.feeCents/100)} · Εξοφλήσεις ${FD.money(d.settledCents/100)}</p><b>Εκκρεμούν ${FD.money(d.outstandingCents/100)}</b></article>`).join('')||'<p class="hint">Δεν υπάρχουν οφειλές στο νέο μοντέλο.</p>';
  currentDrivers = driverResponse.riders;
  renderDrivers(currentDrivers);
  if (document.activeElement !== $('shopDeliveryFee')) $('shopDeliveryFee').value = config.settings.shopDeliveryFee || 0;
  const orders = r.orders;
  if ($('shopActive')) $('shopActive').textContent=String(orders.filter(o=>!['delivered','cancelled'].includes(o.status)).length);
  if ($('shopToday')) $('shopToday').textContent=String(orders.filter(o=>o.createdAt.slice(0,10)===new Date().toISOString().slice(0,10)).length);
  if ($('shopOnline')) $('shopOnline').textContent=String(currentDrivers.filter(d=>d.online).length);
  $('orders').innerHTML = orders.length ? orders.map(o => {
    const assignment = o.status === 'ready' ? `<div class="assign-row"><button data-store-delivery="${o.id}">Έφυγε με διανομέα του καταστήματος</button>${currentDrivers.length ? `<select id="driver-${o.id}" aria-label="Επιλογή διανομέα"><option value="">Επίλεξε οδηγό με λογαριασμό</option>${currentDrivers.filter(d => d.active).map(d => `<option value="${FD.esc(d.id)}">${FD.esc(d.name)}${d.online ? ' · online' : ''}</option>`).join('')}</select><button data-assign="${o.id}">Ανάθεση σε λογαριασμό</button>` : ''}</div>` : '';
    const actions = o.status === 'new' ? `<button data-status="accepted" data-id="${o.id}">Αποδοχή</button><button class="danger" data-status="cancelled" data-id="${o.id}">Ακύρωση</button>` : o.status === 'accepted' ? `<button data-status="ready" data-id="${o.id}">Έτοιμη για διανομή</button><button class="danger" data-status="cancelled" data-id="${o.id}">Ακύρωση</button>` : o.status === 'ready' ? `<button class="danger" data-status="cancelled" data-id="${o.id}">Ακύρωση</button>` : o.status === 'assigned' && o.deliveryManagedByShop ? `<button data-status="delivered" data-id="${o.id}">Ολοκληρώθηκε η παράδοση</button>` : '';
    return `<article class="order"><div class="row"><h3>Παραγγελία ${FD.esc(o.id.slice(0, 8))}</h3><span class="status">${FD.esc(FD.status(o.status))}</span></div><div class="meta">${new Date(o.createdAt).toLocaleString('el-GR')} · ${FD.money(o.total)} (διανομή: ${FD.money(o.deliveryFee || 0)}, χρέωση πελάτη προς πλατφόρμα: ${FD.money(o.serviceFee)})</div><div class="meta">Τρόπος πληρωμής: ${FD.esc(({cash:"Μετρητά",card:"Κάρτα",iris:"IRIS"})[o.paymentMethod]||"—")} · Πιλοτικό — καμία είσπραξη</div><div class="order-contact"><b>${FD.esc(o.customerName || 'Πελάτης')}</b> · <a href="tel:${FD.esc(o.customerPhone || '')}">${FD.esc(o.customerPhone || '—')}</a><br>${FD.esc(o.deliveryAddress || 'Δεν υπάρχει διεύθυνση')}</div><ul class="muted-list">${o.items.map(i => `<li>${FD.esc(i.name)} × ${i.qty} — ${FD.money(i.lineTotal)}</li>`).join('')}</ul>${o.assignedRiderName ? `<p class="hint">Ανατέθηκε στον/στην: <b>${FD.esc(o.assignedRiderName)}</b></p>` : ''}<div class="actions">${actions}</div>${assignment}</article>`;
  }).join('') : '<p class="hint">Δεν υπάρχουν παραγγελίες.</p>';
  document.querySelectorAll('[data-status]').forEach(b => b.onclick = async () => { try { await FD.api(`/api/orders/${b.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: b.dataset.status }) }); FD.notice('notice', 'Η κατάσταση ενημερώθηκε.'); await loadOrders(); } catch (e) { FD.notice('notice', e.message, true); } });
  document.querySelectorAll('[data-assign]').forEach(b => b.onclick = async () => { try { const select = $(`driver-${b.dataset.assign}`); if (!select.value) throw new Error('Επίλεξε διανομέα πρώτα.'); await FD.api(`/api/orders/${b.dataset.assign}`, { method: 'PATCH', body: JSON.stringify({ status: 'assigned', riderId: select.value }) }); FD.notice('notice', 'Η παραγγελία ανατέθηκε στον οδηγό.'); await loadOrders(); } catch (e) { FD.notice('notice', e.message, true); } });
  document.querySelectorAll('[data-store-delivery]').forEach(b => b.onclick = async () => { try { await FD.api(`/api/orders/${b.dataset.storeDelivery}`, { method: 'PATCH', body: JSON.stringify({ status: 'assigned', storeDelivery: true }) }); FD.notice('notice', 'Η παραγγελία έφυγε για παράδοση με διανομέα του καταστήματος.'); await loadOrders(); } catch (e) { FD.notice('notice', e.message, true); } });
  if (!shopMap) initShopMap(config.storeLocation); drawShopMap(orders, currentDrivers, config.storeLocation);
  await loadShopProducts();
}
async function enter() { try { await FD.login('shop', $('code').value); $('login').classList.add('hidden'); $('app').classList.remove('hidden'); await loadOrders(); setInterval(() => loadOrders().catch(() => {}), 8000); } catch (e) { FD.notice('loginMsg', e.message, true); } }
$('loginBtn').onclick = enter;
$('createRider').onclick = async () => { try { const name = $('riderName').value.trim(); const r = await FD.api('/api/shop/riders', { method: 'POST', body: JSON.stringify({ name }) }); $('riderName').value = ''; FD.notice('riderCodeNotice', `Οδηγός: ${r.rider.name} · ID: ${r.rider.id}
Προσωπικός κωδικός (εμφανίζεται μόνο τώρα): ${r.accessCode}`); await loadOrders(); } catch (e) { FD.notice('riderCodeNotice', e.message, true); } };
$('saveDeliveryFee').onclick = async () => { try { const deliveryFee = Number($('shopDeliveryFee').value); if ($('shopDeliveryFee').value === '') throw new Error('Γράψε ποσό διανομής.'); const r = await FD.api('/api/shop/delivery-fee', { method: 'POST', body: JSON.stringify({ deliveryFee }) }); FD.notice('deliveryFeeNotice', `Η διανομή ορίστηκε σε ${FD.money(r.deliveryFee)} για τις επόμενες παραγγελίες.`); } catch (e) { FD.notice('deliveryFeeNotice', e.message, true); } };
$('addProduct').onclick = async () => { try {
  const name = $('productName').value.trim(); const rawPrice = $('productPrice').value; const price = Number(rawPrice);
  if (!name || rawPrice === '' || !Number.isFinite(price)) throw new Error('Γράψε όνομα και τιμή προϊόντος.');
  await FD.api('/api/shop/products', { method: 'POST', body: JSON.stringify({ name, price, category: $('productCategory').value.trim() || 'Μενού', description: $('productDescription').value.trim() }) });
  $('productName').value = ''; $('productPrice').value = ''; $('productDescription').value = '';
  FD.notice('productNotice', 'Το προϊόν προστέθηκε.'); await loadShopProducts();
} catch (e) { FD.notice('productNotice', e.message, true); } };
$('refresh').onclick = () => loadOrders().catch(e => FD.notice('notice', e.message, true));
$('logout').onclick = async () => { await FD.logout('shop'); location.reload(); };
(async () => { const m = await FD.me('shop'); if (m.authenticated && m.role === 'shop') { $('login').classList.add('hidden'); $('app').classList.remove('hidden'); await loadOrders(); setInterval(() => loadOrders().catch(() => {}), 8000); } })().catch(() => {});
