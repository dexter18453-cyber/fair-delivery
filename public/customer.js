'use strict';
const $ = id => document.getElementById(id);
let products = []; let cart = new Map(); let currentOrderId = null; let trackingTimer = null;
let serviceFee = 0; let deliveryFee = 0; let submitting = false;
let deliveryMap = null; let deliveryMarker = null; let trackingMap = null; let trackingLayers = [];
const DEFAULT_CENTER = [37.97, 23.67];
function renderCart() {
  let subtotal = 0; const rows = [];
  for (const [id, qty] of cart) { const p = products.find(x => x.id === id); if (!p) continue; subtotal += p.price * qty;
    rows.push(`<div class="product"><div><b>${FD.esc(p.name)}</b><div class="hint">${FD.money(p.price)} × ${qty}</div></div><div class="qty"><button class="secondary" data-minus="${FD.esc(id)}">−</button><b>${qty}</b><button data-plus="${FD.esc(id)}">+</button></div></div>`);
  }
  $('cart').innerHTML = rows.join('') || '<p class="hint">Το καλάθι είναι άδειο.</p>';
  $('subtotal').textContent = FD.money(subtotal);
  $('serviceFee').textContent = FD.money(rows.length ? serviceFee : 0);
  $('deliveryFee').textContent = FD.money(rows.length ? deliveryFee : 0);
  $('total').textContent = FD.money(rows.length ? subtotal + serviceFee + deliveryFee : 0);
  $('placeOrder').disabled = submitting || !rows.length;
  document.querySelectorAll('[data-plus]').forEach(b => b.onclick = () => changeQty(b.dataset.plus, 1));
  document.querySelectorAll('[data-minus]').forEach(b => b.onclick = () => changeQty(b.dataset.minus, -1));
}
function changeQty(id, delta) { const qty = (cart.get(id) || 0) + delta; if (qty <= 0) cart.delete(id); else cart.set(id, Math.min(qty, 20)); renderCart(); }
function setDeliveryPoint(lat, lng) {
  $('deliveryCoords').textContent = `Σημείο παράδοσης: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  $('deliveryCoords').dataset.lat = String(lat); $('deliveryCoords').dataset.lng = String(lng);
  if (!deliveryMap || !window.L) return;
  if (!deliveryMarker) deliveryMarker = L.marker([lat, lng]).addTo(deliveryMap).bindPopup('Σημείο παράδοσης');
  else deliveryMarker.setLatLng([lat, lng]);
}
function initDeliveryMap() {
  if (!window.L) { $('locationNote').textContent = 'Ο χάρτης δεν φορτώθηκε. Έλεγξε τη σύνδεση στο internet.'; return; }
  deliveryMap = L.map('deliveryMap').setView(DEFAULT_CENTER, 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(deliveryMap);
  deliveryMap.on('click', e => setDeliveryPoint(e.latlng.lat, e.latlng.lng));
  setTimeout(() => deliveryMap.invalidateSize(), 200);
}
let selectedCategory='Όλα';
function productEmoji(p) {
  const text=(p.name+' '+p.category).toLocaleLowerCase('el-GR');
  if(/καφ|coffee/.test(text))return '☕';
  if(/πίτσα|pizza/.test(text))return '🍕';
  if(/σουβλ|πίτα|γύρο/.test(text))return '🌯';
  if(/burger|μπεργ/.test(text))return '🍔';
  if(/σαλάτα|salad/.test(text))return '🥗';
  return '🍽';
}
function renderFilteredProducts() {
  const q=($('productSearch')?.value||'').trim().toLocaleLowerCase('el-GR');
  const visible=products.filter(p=>(selectedCategory==='Όλα'||(p.category||'Μενού')===selectedCategory)&&(!q||[p.name,p.category,p.description].join(' ').toLocaleLowerCase('el-GR').includes(q)));
  $('products').innerHTML=visible.map(p=>`<article class="product product-card"><span class="product-emoji" aria-hidden="true">${productEmoji(p)}</span><div class="product-content"><span class="eyebrow">${FD.esc(p.category||'Μενού')}</span><h3>${FD.esc(p.name)}</h3><p class="hint">${FD.esc(p.description||'Επιλογή από το μενού')}</p><div class="product-bottom"><strong class="price">${FD.money(p.price)}</strong><button data-add="${FD.esc(p.id)}">＋ Προσθήκη</button></div></div></article>`).join('')||'<div class="empty-state">Δεν βρέθηκαν προϊόντα. Δοκίμασε άλλη αναζήτηση.</div>';
  document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>changeQty(b.dataset.add,1));
}
async function loadProducts() {
  const [menu, config] = await Promise.all([FD.api('/api/products'), FD.api('/api/config')]); products = menu.products;
  serviceFee = Number(config.settings.customerServiceFee);
  deliveryFee = Number(config.settings.shopDeliveryFee || 0);
  const categories=['Όλα',...new Set(products.map(p=>p.category||'Μενού'))];
  if($('categoryFilters')) {
    $('categoryFilters').innerHTML=categories.map(c=>`<button type="button" class="category-chip ${c===selectedCategory?'selected':''}" data-category="${FD.esc(c)}">${FD.esc(c)}</button>`).join('');
    document.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{
      selectedCategory=b.dataset.category;
      document.querySelectorAll('[data-category]').forEach(x=>x.classList.toggle('selected',x===b));
      renderFilteredProducts();
    });
  }
  $('productSearch')?.addEventListener('input',renderFilteredProducts);
  renderFilteredProducts();
  $('feeNote').textContent = `Χρέωση Fair Delivery: ${FD.money(serviceFee)} · Διανομή από το κατάστημα: ${FD.money(deliveryFee)} · Πιλοτική δοκιμή χωρίς online πληρωμή.`;
}
$('placeOrder').addEventListener('click', async () => {
  if (submitting) return;
  try {
    const lat = Number($('deliveryCoords').dataset.lat); const lng = Number($('deliveryCoords').dataset.lng);
    if (!$('customerName').value.trim() || !$('customerPhone').value.trim() || !$('deliveryAddress').value.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      FD.notice('notice', 'Συμπλήρωσε όνομα, τηλέφωνο, διεύθυνση και επίλεξε σημείο στον χάρτη.', true); return;
    }
    if (!$('privacyConsent').checked) { FD.notice('notice', 'Χρειάζεται να συμφωνήσεις με τη χρήση των στοιχείων για την πιλοτική παραγγελία.', true); return; }
    const paymentMethod = $('paymentMethod')?.value;
    if (paymentMethod && !window.FDAccount?.current()) { FD.notice('notice','Συνδέσου πρώτα στον λογαριασμό σου.',true); window.FDUI?.show('account'); return; }
    if (paymentMethod && !$('confirmSimulation').checked) { FD.notice('notice','Επιβεβαίωσε ότι η πληρωμή είναι δοκιμαστική.',true); return; }
    submitting = true; renderCart();
    const items = [...cart].map(([productId, qty]) => ({ productId, qty }));
    const result = await FD.api('/api/orders', { method: 'POST', body: JSON.stringify({ items, customerName: $('customerName').value.trim(), customerPhone: $('customerPhone').value.trim(), deliveryAddress: $('deliveryAddress').value.trim(), deliveryLocation: { lat, lng }, privacyConsent: true, ...(paymentMethod ? {paymentMethod, confirmPaymentSimulation: true} : {}) }) });
    cart.clear(); renderCart(); FD.notice('notice', 'Η πιλοτική παραγγελία καταχωρίστηκε. Δεν έγινε χρέωση.'); window.FDAccount?.refreshOrders().catch(()=>{}); showTracking(result.order.id);
  } catch (e) { FD.notice('notice', e.message, true); }
  finally { submitting = false; renderCart(); }
});
$('clearCart').addEventListener('click', () => { cart.clear(); renderCart(); FD.notice('notice', 'Το καλάθι καθαρίστηκε.'); });
$('useLocation').onclick = () => {
  if (!navigator.geolocation) { $('locationNote').textContent = 'Ο browser δεν υποστηρίζει γεωεντοπισμό.'; return; }
  $('locationNote').textContent = 'Αναμονή άδειας τοποθεσίας…';
  navigator.geolocation.getCurrentPosition(pos => { const { latitude, longitude } = pos.coords; setDeliveryPoint(latitude, longitude); if (deliveryMap) deliveryMap.setView([latitude, longitude], 16); $('locationNote').textContent = 'Η θέση επιλέχθηκε. Έλεγξε ότι το σημείο είναι σωστό.'; }, err => { $('locationNote').textContent = 'Δεν δόθηκε άδεια τοποθεσίας: ' + err.message; }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 15000 });
};
function renderTrackingMap(order) {
  if (!window.L) return;
  if (!trackingMap) { trackingMap = L.map('trackingMap').setView(DEFAULT_CENTER, 13); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(trackingMap); }
  trackingLayers.forEach(layer => trackingMap.removeLayer(layer)); trackingLayers = [];
  const points = [];
  if (order.deliveryLocation) { const p = [order.deliveryLocation.lat, order.deliveryLocation.lng]; points.push(p); trackingLayers.push(L.marker(p).addTo(trackingMap).bindPopup('Προορισμός παράδοσης')); }
  if (order.riderLocation) { const p = [order.riderLocation.lat, order.riderLocation.lng]; points.push(p); trackingLayers.push(L.marker(p).addTo(trackingMap).bindPopup('Τελευταία θέση διανομέα')); }
  if (points.length === 2) trackingLayers.push(L.polyline(points, { color: '#17b890', weight: 5, opacity: .85, dashArray: '8 8' }).addTo(trackingMap));
  if (points.length) trackingMap.fitBounds(L.latLngBounds(points).pad(.25));
  setTimeout(() => trackingMap.invalidateSize(), 120);
}
async function showTracking(id) { currentOrderId = id; $('trackingEmpty')?.classList.add('hidden'); if (window.FDUI?.show) window.FDUI.show('tracking'); $('tracking').classList.remove('hidden'); $('orderId').textContent = id; $('trackingInfo').textContent = 'Γίνεται έλεγχος κατάστασης…'; if (trackingTimer) clearInterval(trackingTimer); trackingTimer = setInterval(refreshTracking, 7000); await refreshTracking(); }
async function refreshTracking() {
  if (!currentOrderId) return;
  try {
    const r = await FD.api(`/api/orders/${encodeURIComponent(currentOrderId)}`); const o = r.order;
    $('orderStatus').textContent = FD.status(o.status); $('orderStatus').className = 'status ' + (o.status === 'delivered' ? 'good' : o.status === 'cancelled' ? 'bad' : 'wait');
    $('trackingInfo').textContent = `Σύνολο ${FD.money(o.total)} · Δημιουργήθηκε ${new Date(o.createdAt).toLocaleString('el-GR')}${o.paymentMethod ? ' · '+({cash:'Μετρητά',card:'Κάρτα',iris:'IRIS'}[o.paymentMethod]||'—')+' · Δοκιμή χωρίς πληρωμή' : ''}`;
    $('trackingCoords').textContent = o.riderLocation ? 'Εμφανίζεται η τελευταία θέση που κοινοποίησε ο διανομέας.' : 'Δεν έχει κοινοποιηθεί ακόμη θέση διανομέα.';
    renderTrackingMap(o);
    if (['delivered', 'cancelled'].includes(o.status) && trackingTimer) { clearInterval(trackingTimer); trackingTimer = null; }
  } catch (e) { $('trackingInfo').textContent = e.message; }
}
(async () => { initDeliveryMap(); await loadProducts(); renderCart(); const id = new URLSearchParams(location.search).get('order'); if (id) showTracking(id); })().catch(e => FD.notice('notice', e.message, true));
