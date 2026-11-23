'use strict';
const $ = id => document.getElementById(id);
const euro = value => new Intl.NumberFormat('el-GR',{style:'currency',currency:'EUR'}).format((value || 0)/100);
const SESSION = key => sessionStorage.getItem('fd_'+key) || '';
const setSession = (key,value) => value ? sessionStorage.setItem('fd_'+key,value) : sessionStorage.removeItem('fd_'+key);
let shops = [], intake = false, selectedShop = '', cart = new Map(), refreshTimer = null, lastShopIds = new Set();
const statusText = {new:'Νέα παραγγελία',accepted:'Αποδεκτή',preparing:'Προετοιμάζεται',ready:'Έτοιμη',picked_up:'Παρελήφθη από διανομέα',delivered:'Παραδόθηκε',cancelled:'Ακυρώθηκε'};
const nextStatus = {new:'accepted',accepted:'preparing',preparing:'ready',ready:'picked_up',picked_up:'delivered'};
const actionText = {accepted:'Αποδοχή',preparing:'Έναρξη προετοιμασίας',ready:'Έτοιμη για παραλαβή',picked_up:'Παραλαβή',delivered:'Ολοκλήρωση'};
function node(tag,text,className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = String(text);
  if (className) el.className = className;
  return el;
}
function clear(el) { el.replaceChildren(); }
function message(text,isError=false) {
  const bar = $('banner'); bar.textContent = text; bar.className = 'notice' + (isError ? ' error' : '');
  bar.hidden = false;
  window.scrollTo({top:0,behavior:'smooth'});
}
async function api(method, url, data, token) {
  const headers = {};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url,{method,headers,body:data === undefined ? undefined : JSON.stringify(data),cache:'no-store'});
  let json; try { json = await res.json(); } catch { json = {}; }
  if (!res.ok) throw new Error(json.error || 'Σφάλμα επικοινωνίας (' + res.status + ')');
  return json;
}
function payload(form) { return Object.fromEntries(new FormData(form)); }
function selected() { return shops.find(s => s.id === selectedShop); }
function formatOrder(order, role, token) {
  const box = node('article',undefined,'order');
  const info = node('div');
  info.append(node('strong','#'+order.id.slice(0,8)+' · '+(order.shopName||order.shopId)));
  info.append(node('small',(statusText[order.status]||order.status)+' · '+new Date(order.createdAt).toLocaleString('el-GR')));
  const money = order.pricing || {};
  info.append(node('small','Προϊόντα: '+euro(money.subtotalCents)+' · Πελάτης: '+euro(money.customerTotalCents)));
  const lines = (money.lines || []).map(x => x.quantity+'× '+x.name).join(', ');
  if (lines) info.append(node('small',lines));
  if (order.customerName) info.append(node('small','Πελάτης: '+order.customerName+' · '+order.customerPhone));
  if (order.deliveryAddress) info.append(node('small','Διεύθυνση: '+order.deliveryAddress));
  if (order.notes) info.append(node('small','Σχόλιο: '+order.notes));
  box.append(info);
  const actions = node('div',undefined,'actions');
  let next = nextStatus[order.status];
  const allowed = role === 'admin' || (role === 'shop' && ['new','accepted','preparing'].includes(order.status)) || (role === 'rider' && ['ready','picked_up'].includes(order.status));
  if (next && allowed) {
    const b = node('button',actionText[next],'primary');
    b.type = 'button';
    b.addEventListener('click',async () => {
      try { b.disabled=true; await api('POST','/api/ops/orders/'+order.id+'/status',{status:next},token); message('Ενημερώθηκε η κατάσταση παραγγελίας.'); await refreshWork(role); }
      catch(e){message(e.message,true);b.disabled=false;}
    });
    actions.append(b);
  }
  if ((role === 'admin' || role === 'shop') && ['new','accepted'].includes(order.status)) {
    const b = node('button','Ακύρωση','secondary'); b.type='button';
    b.addEventListener('click',async () => {
      if (!window.confirm('Να ακυρωθεί η παραγγελία;')) return;
      try { await api('POST','/api/ops/orders/'+order.id+'/status',{status:'cancelled'},token);await refreshWork(role); }
      catch(e){message(e.message,true);}
    }); actions.append(b);
  }
  box.append(actions); return box;
}
function labelValue(parent,label,value,final=false) {
  const row=node('div',undefined,'total-row'+(final?' final':''));
  row.append(node('span',label),node('strong',value));parent.append(row);
}
async function loadShops() {
  const info=await api('GET','/api/shops');
  shops=info.shops; intake=info.orderIntake;
  const select=$('customerShop');clear(select);
  if (!shops.length) select.append(node('option','Δεν υπάρχουν ακόμη ενεργά καταστήματα.'));
  shops.forEach(s => { const opt=node('option',s.name+' · '+s.area);opt.value=s.id;select.append(opt); });
  if (!shops.some(s=>s.id===selectedShop)) selectedShop=shops[0]?.id||'';
  select.value=selectedShop;
  if (!intake) { $('sendOrder').textContent='Παραγγελίες προσωρινά απενεργοποιημένες'; }
  renderProducts();await renderCart();
}
function renderProducts() {
  clear($('products'));
  const s=selected();
  if (!s) { $('products').append(node('p','Ο κατάλογος θα εμφανιστεί όταν ενεργοποιηθεί το πρώτο κατάστημα.','muted'));return; }
  if (!s.products.length) $('products').append(node('p','Δεν υπάρχουν διαθέσιμα προϊόντα.','muted'));
  for(const p of s.products) {
    const box=node('div',undefined,'product'); const d=node('div');
    d.append(node('strong',p.name),node('small',euro(p.priceCents)));
    const button=node('button','Προσθήκη');button.type='button';
    button.addEventListener('click',()=>{cart.set(p.id,Math.min(20,(cart.get(p.id)||0)+1));renderCart();});
    box.append(d,button);$('products').append(box);
  }
}
async function renderCart() {
  const s=selected(); const cartItems=$('cartItems'),totals=$('checkoutTotals');
  clear(cartItems); clear(totals);
  const items=Array.from(cart,([productId,quantity])=>({productId,quantity})).filter(item=>s?.products.some(p=>p.id===item.productId));
  if (!s || items.length===0) {
    cartItems.append(node('p','Δεν έχεις προσθέσει προϊόντα.','muted'));
    labelValue(totals,'Service fee',euro(230));
    $('sendOrder').disabled=true;return;
  }
  for (const item of items) {
    const p=s.products.find(p=>p.id===item.productId);
    const row=node('div',undefined,'cart-line');const text=node('div');
    text.append(node('strong',p.name),node('small',euro(p.priceCents*item.quantity)));
    const qty=node('div',undefined,'qty');
    const minus=node('button','−');minus.type='button';minus.setAttribute('aria-label','Αφαίρεση '+p.name);
    minus.addEventListener('click',()=>{const next=item.quantity-1;if(next)cart.set(p.id,next);else cart.delete(p.id);renderCart();});
    qty.append(minus,node('span',item.quantity));
    row.append(text,qty);cartItems.append(row);
  }
  try {
    const reply=await api('POST','/api/quote',{shopId:s.id,items});
    if (selectedShop !== s.id) return;
    labelValue(totals,'Προϊόντα',euro(reply.pricing.subtotalCents));
    labelValue(totals,'Μεταφορικά καταστήματος',euro(reply.pricing.deliveryFeeCents));
    labelValue(totals,'Service fee (με ΦΠΑ)',euro(reply.pricing.serviceFeeGrossCents));
    labelValue(totals,'Σύνολο',euro(reply.pricing.customerTotalCents),true);
    $('sendOrder').disabled=!intake;
  } catch(e) {$('sendOrder').disabled=true;message(e.message,true);}
}
async function sendOrder(e) {
  e.preventDefault();const s=selected();
  if (!s || !cart.size || !intake) return;
  const data=payload($('checkoutForm'));
  data.shopId=s.id;
  data.items=Array.from(cart,([productId,quantity])=>({productId,quantity}));
  let key=SESSION('pendingKey');
  if (!key) { key=crypto.randomUUID();setSession('pendingKey',key); }
  data.idempotencyKey=key;
  $('sendOrder').disabled=true;
  try {
    const reply=await api('POST','/api/orders',data);
    if (reply.trackingToken) {
      setSession('tracking',JSON.stringify({orderId:reply.id,trackingToken:reply.trackingToken}));
      setSession('pendingKey','');
      cart.clear(); $('checkoutForm').reset(); await renderCart();
      message('Η παραγγελία καταχωρίστηκε. Παρακολούθησέ την παρακάτω.');
      await track();
    } else {
      throw new Error('Η παραγγελία είχε ήδη καταχωριστεί. Επικοινώνησε με το κατάστημα αν δεν έχεις αναγνωριστικό παρακολούθησης.');
    }
  } catch(error) {message(error.message,true); $('sendOrder').disabled=!intake;}
}
async function track() {
  const record=SESSION('tracking');
  if (!record) {$('trackingInfo').textContent='Δεν υπάρχει ενεργή παραγγελία.';return;}
  try {
    const {orderId,trackingToken}=JSON.parse(record);
    const result=await api('POST','/api/track',{orderId,trackingToken});
    const o=result.order;
    $('trackingInfo').textContent='#'+o.id.slice(0,8)+' · '+o.shopName+' · '+(statusText[o.status]||o.status)+' · '+new Date(o.updatedAt).toLocaleString('el-GR');
  } catch(error) {$('trackingInfo').textContent='Αδυναμία παρακολούθησης: '+error.message;}
}
async function login(role) {
  const token=$(role+'Key').value.trim();
  try {
    const me=await api('GET','/api/ops/me',undefined,token);
    if (me.role.type !== role) throw new Error('Το κλειδί δεν αντιστοιχεί σε αυτόν τον ρόλο.');
    setSession(role,token);$(role+'Key').value='';
    $(role+'Work').hidden=false;
    message('Επιτυχής σύνδεση '+role+'.');
    await refreshWork(role);
  } catch(e){message(e.message,true);}
}
function logout(role) {
  setSession(role,'');$(role+'Work').hidden=true;
  message('Έγινε αποσύνδεση.');
}
async function refreshWork(role) {
  const token=SESSION(role);if (!token) return;
  if (role==='shop' || role==='rider' || role==='admin') {
    const reply=await api('GET','/api/ops/orders',undefined,token);
    const list=$(role+'Orders');clear(list);
    if (!reply.orders.length) list.append(node('p','Καμία παραγγελία αυτή τη στιγμή.','muted'));
    const current=new Set(reply.orders.filter(o=>o.status==='new').map(o=>o.id));
    if (role==='shop' && lastShopIds.size && [...current].some(id=>!lastShopIds.has(id))) message('Έφτασε νέα παραγγελία στο κατάστημα.');
    if (role==='shop') lastShopIds=current;
    reply.orders.forEach(order=>list.append(formatOrder(order,role,token)));
  }
  if (role==='admin') await refreshAdmin(token);
}
async function refreshAdmin(token) {
  const [s,stores,requests]=await Promise.all([
    api('GET','/api/admin/summary',undefined,token),
    api('GET','/api/admin/shops',undefined,token),
    api('GET','/api/admin/interests',undefined,token)
  ]);
  const stats=$('adminStats'); clear(stats);
  const entries=[['Παραγγελίες μήνα',String(s.totalOrders)],['Ολοκληρωμένες',String(s.deliveredOrders)],
    ['Έσοδα προ ΦΠΑ',euro(s.totals.platformRevenueNetCents)],['Καταγεγραμμένα έξοδα',euro(s.recordedExpensesCents)],
    ['Ενδεικτικό υπόλοιπο',euro(s.estimatedOperatingBalanceCents)],['Ενεργά καταστήματα',String(s.activeShops)]];
  entries.forEach(([label,value])=>{const c=node('div',undefined,'stat');c.append(node('small',label),node('strong',value));stats.append(c);});
  const b=$('adminBreakdown');clear(b);
  labelValue(b,'Μικτά service fees',euro(s.totals.serviceFeeGrossCents));
  labelValue(b,'Μικτές προμήθειες',euro(s.totals.commissionGrossCents));
  labelValue(b,'Υπολογισμένος ΦΠΑ υπηρεσιών',euro(s.totals.platformCollectedVatCents));
  labelValue(b,'Έσοδα πλατφόρμας χωρίς ΦΠΑ',euro(s.totals.platformRevenueNetCents),true);
  b.append(node('p',s.disclaimer,'muted small'));
  const shopsEl=$('adminShops');clear(shopsEl);
  stores.shops.forEach(shop=>{
    const item=node('div',undefined,'shop-admin');
    item.append(node('strong',shop.name+' · '+shop.area),node('small',shop.active?'Ενεργό':'Ανενεργό'));
    const a=node('div',undefined,'actions');
    const createBtn=(label,fn)=>{const button=node('button',label,'secondary');button.type='button';button.addEventListener('click',async()=>{try{await fn();await refreshWork('admin');}catch(e){message(e.message,true);}});a.append(button);};
    createBtn(shop.active?'Απενεργοποίηση':'Ενεργοποίηση',async()=>{
      await api('POST','/api/admin/shops/'+shop.id+'/activate',{active:!shop.active},token);
    });
    createBtn('Νέο κλειδί καταστήματος',async()=>{
      if (!window.confirm('Το προηγούμενο κλειδί θα πάψει να λειτουργεί. Συνέχεια;')) return;
      const result=await api('POST','/api/admin/shops/'+shop.id+'/key',undefined,token);
      window.prompt('Αντέγραψε το κλειδί τώρα. Δεν εμφανίζεται ξανά:',result.key);
    });
    createBtn('Προσθήκη προϊόντος',async()=>{
      const id=window.prompt('Κωδικός στα λατινικά (π.χ. souvlaki):');
      if (!id) return;const name=window.prompt('Όνομα προϊόντος:');if(!name)return;
      const price=window.prompt('Τιμή σε ευρώ, π.χ. 3.50:');if(!price)return;
      const priceCents=Math.round(Number(price.replace(',','.'))*100);
      await api('POST','/api/admin/shops/'+shop.id+'/products',{id,name,priceCents,active:true},token);
    });
    createBtn('Μεταφορικά',async()=>{
      const input=window.prompt('Μεταφορικά καταστήματος σε ευρώ:',String(shop.deliveryFeeCents/100));
      if (input===null)return;
      const deliveryFeeCents=Math.round(Number(input.replace(',','.'))*100);
      await api('POST','/api/admin/shops/'+shop.id+'/settings',{deliveryFeeCents},token);
    });
    item.append(a);shopsEl.append(item);
  });
  const interests=$('interests');clear(interests);
  if(!requests.interests.length) interests.append(node('p','Δεν υπάρχουν νέες αιτήσεις.','muted'));
  requests.interests.forEach(x=>{const box=node('div',undefined,'order');const info=node('div');info.append(node('strong',x.businessName+' · '+x.area),node('small',x.contactName+' · '+x.phone+' · '+new Date(x.createdAt).toLocaleString('el-GR')));box.append(info);interests.append(box);});
}
async function submitInterest(e) {
  e.preventDefault();const f=e.target;
  try {await api('POST','/api/interest',payload(f));f.reset();message('Λάβαμε το αίτημά σου. Θα επικοινωνήσουμε μαζί σου.');}
  catch(error){message(error.message,true);}
}
async function submitProduct(e) {
  e.preventDefault();
  const token=SESSION('shop');
  try {
    const me=await api('GET','/api/ops/me',undefined,token);
    const d=payload(e.target);const priceCents=Math.round(Number(d.price)*100);
    await api('POST','/api/ops/shops/'+me.role.shopId+'/products',{id:d.id,name:d.name,priceCents},token);
    e.target.reset();message('Το προϊόν αποθηκεύτηκε.');
  } catch(error){message(error.message,true);}
}
async function submitNewShop(e) {
  e.preventDefault();try{await api('POST','/api/admin/shops',payload(e.target),SESSION('admin'));e.target.reset();await refreshWork('admin');message('Δημιουργήθηκε κατάστημα. Πρόσθεσε προϊόντα πριν την ενεργοποίηση.');}
  catch(error){message(error.message,true);}
}
async function submitExpense(e) {
  e.preventDefault();
  try {const d=payload(e.target);await api('POST','/api/admin/expenses',{label:d.label,amountCents:Math.round(Number(d.amount)*100)},SESSION('admin'));e.target.reset();await refreshWork('admin');message('Το έξοδο αποθηκεύτηκε.');}
  catch(error){message(error.message,true);}
}
function showView(view) {
  for(const role of ['customer','shop','rider','admin']) $(role+'-view').hidden=role!==view;
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  if(refreshTimer) clearInterval(refreshTimer);
  if(view==='customer') {
    loadShops().catch(e=>message(e.message,true));track();
    refreshTimer=setInterval(()=>track(),15000);
  } else {
    const token=SESSION(view);
    $(view+'Work').hidden=!token;
    if(token) refreshWork(view).catch(e=>message(e.message,true));
    refreshTimer=setInterval(()=>{if(SESSION(view))refreshWork(view).catch(()=>{});},12000);
  }
  window.scrollTo({top:0});
}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>showView(button.dataset.view)));
$('customerShop').addEventListener('change',e=>{selectedShop=e.target.value;cart.clear();renderProducts();renderCart();});
$('checkoutForm').addEventListener('submit',sendOrder);
$('refreshTracking').addEventListener('click',track);
$('interestForm').addEventListener('submit',submitInterest);
$('productForm').addEventListener('submit',submitProduct);
$('newShopForm').addEventListener('submit',submitNewShop);
$('expenseForm').addEventListener('submit',submitExpense);
for(const role of ['shop','rider','admin']) {
  $(role+'Login').addEventListener('click',()=>login(role));
  $(role+'Logout').addEventListener('click',()=>logout(role));
  $(role+'Refresh').addEventListener('click',()=>refreshWork(role).catch(e=>message(e.message,true)));
}
showView('customer');
