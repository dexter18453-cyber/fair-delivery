'use strict';
const $ = id => document.getElementById(id);
let chatHistory = [];
const COURIER_STATUS_LABELS={
  'new':'Νέα αίτηση','contacted':'Έγινε επικοινωνία','needs-documents':'Εκκρεμούν δικαιολογητικά',
  'reviewing':'Εξετάζεται','not-suitable':'Δεν προχωρά (απόφαση διαχειριστή)'
};
async function loadCourierApplications(){
  const data=await FD.api('/api/admin/courier-applications');
  const applications=data.applications||[];
  const node=$('courierApplications');
  if(!node)return;
  node.innerHTML=applications.length?applications.map(app=>{
    const findings=app.screening?.issues||[];
    const ready=app.screening?.status==='ready-for-review';
    return `<article class="candidate-card" data-candidate="${FD.esc(app.id)}">
      <div class="row"><h3>${FD.esc(app.fullName)}</h3><span class="status ${ready?'good':'wait'}">${ready?'Προέλεγχος πλήρης':'Εκκρεμότητες'}</span></div>
      <p class="candidate-contact"><a href="mailto:${FD.esc(app.email)}">${FD.esc(app.email)}</a> · <a href="tel:${FD.esc(app.phone)}">${FD.esc(app.phone)}</a></p>
      <p class="small muted">Περιοχή: ${FD.esc(app.region)} · Μέσο: ${FD.esc(({bicycle:'Ποδήλατο',moped:'Μοτοποδήλατο',motorcycle:'Μοτοσικλέτα',car:'Αυτοκίνητο'})[app.vehicle]||app.vehicle)} · Κατηγορία: ${FD.esc(app.licenseCategory)}</p>
      <p class="small muted">Δηλώθηκε: ${new Date(app.createdAt).toLocaleString('el-GR')} · Ασφάλιση έως: ${FD.esc(app.insuranceUntil||'—')}</p>
      <p class="small muted">Δηλώνει επαγγελματική δραστηριότητα: ${app.businessActive?'Ναι':'Όχι'} · Παραστατικά: ${app.canInvoice?'Ναι':'Όχι'} · Εξοπλισμός: ${app.equipmentReady?'Ναι':'Όχι'}</p>
      ${findings.length?`<strong class="warning">Σημεία προς επαλήθευση</strong><ul class="candidate-issues">${findings.map(issue=>`<li>${FD.esc(issue)}</li>`).join('')}</ul>`:'<p class="small muted">Δεν εντοπίστηκαν ελλείψεις στα δηλωμένα στοιχεία. Απαιτείται εξέταση εγγράφων.</p>'}
      <div class="field"><label>Κατάσταση ανθρώπινου ελέγχου</label><select data-candidate-status>${Object.entries(COURIER_STATUS_LABELS).map(([value,label])=>`<option value="${value}" ${value===app.status?'selected':''}>${label}</option>`).join('')}</select></div>
      <div class="field"><label>Σημειώσεις διαχειριστή (έως 500 χαρακτήρες)</label><textarea data-candidate-notes maxlength="500" rows="2">${FD.esc(app.reviewNotes||'')}</textarea></div>
      <div class="actions"><button type="button" data-candidate-save>Αποθήκευση ελέγχου</button><button type="button" class="secondary" data-candidate-delete>Διαγραφή αίτησης</button></div>
    </article>`;
  }).join(''):'<p class="hint">Δεν υπάρχουν αιτήσεις. Η δημόσια υποβολή παραμένει απενεργοποιημένη μέχρι να ολοκληρωθούν οι απαιτήσεις απορρήτου και συνεργασίας.</p>';
  node.querySelectorAll('[data-candidate-save]').forEach(button=>button.addEventListener('click',async()=>{
    const card=button.closest('[data-candidate]'),id=card.dataset.candidate;
    button.disabled=true;
    try{
      await FD.api('/api/admin/courier-applications/'+encodeURIComponent(id),{
        method:'PATCH',body:JSON.stringify({
          status:card.querySelector('[data-candidate-status]').value,
          reviewNotes:card.querySelector('[data-candidate-notes]').value
        })
      });
      FD.notice('courierApplicationNotice','Ο ανθρώπινος έλεγχος αποθηκεύτηκε.');
      await loadCourierApplications();
    }catch(err){FD.notice('courierApplicationNotice',err.message,true);button.disabled=false;}
  }));
  node.querySelectorAll('[data-candidate-delete]').forEach(button=>button.addEventListener('click',async()=>{
    const id=button.closest('[data-candidate]').dataset.candidate;
    if(!confirm('Οριστική διαγραφή προσωπικών στοιχείων και αίτησης;'))return;
    try{
      await FD.api('/api/admin/courier-applications/'+encodeURIComponent(id),{method:'DELETE'});
      FD.notice('courierApplicationNotice','Η αίτηση διαγράφηκε.');
      await loadCourierApplications();
    }catch(err){FD.notice('courierApplicationNotice',err.message,true);}
  }));
}

async function loadBilling(){
  const data=await FD.api('/api/shop/billing');
  $('billingOutstanding').textContent=FD.money(data.outstandingCents/100);
  $('billingDays').innerHTML=data.days.map(d=>`<article class="order"><b>${FD.esc(d.day)}</b><p class="hint">${d.completed} ολοκληρωμένες · Σύνολο ${FD.money(d.feeCents/100)} · Καταχωρισμένες εξοφλήσεις ${FD.money(d.settledCents/100)}</p><b>Εκκρεμούν ${FD.money(d.outstandingCents/100)}</b>${d.outstandingCents?`<div class="actions"><button type="button" data-bill-day="${FD.esc(d.day)}" data-bill-cents="${d.outstandingCents}">Καταχώριση δοκιμαστικής εξόφλησης</button></div>`:''}</article>`).join('')||'<p class="hint">Καμία ολοκληρωμένη παραγγελία στο νέο μοντέλο.</p>';
  $('billingHistory').innerHTML=data.history.map(x=>`<div class="product"><div><b>${FD.esc(x.day)} · ${FD.money(x.amountCents/100)}</b><p class="hint">Δοκιμαστική καταχώριση · ${new Date(x.recordedAt).toLocaleString('el-GR')}</p></div></div>`).join('')||'<p class="hint">Καμία καταχώριση ακόμα.</p>';
  document.querySelectorAll('[data-bill-day]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Να καταχωριστεί δοκιμαστική εξόφληση '+FD.money(Number(b.dataset.billCents)/100)+'; Δεν γίνεται είσπραξη.'))return;
    b.disabled=true;
    try{await FD.api('/api/admin/shop-settlements',{method:'POST',body:JSON.stringify({day:b.dataset.billDay,expectedCents:Number(b.dataset.billCents),confirmPilot:true})});FD.notice('billingNotice','Η δοκιμαστική εξόφληση καταχωρίστηκε.');}
    catch(e){FD.notice('billingNotice',e.message,true);}
    finally{await loadBilling().catch(e=>FD.notice('billingNotice',e.message,true));}
  });
}
$('billingRefresh').onclick=()=>loadBilling().catch(e=>FD.notice('billingNotice',e.message,true));

async function loadDashboard() {
  await loadBilling();
  const [stats, orders, config] = await Promise.all([FD.api('/api/stats'), FD.api('/api/orders'), FD.api('/api/config')]);
  $('active').textContent = stats.activeOrders; $('today').textContent = stats.ordersToday; $('delivered').textContent = stats.deliveredToday;
  $('gross').textContent = FD.money(stats.grossValueToday); $('platformFee').textContent = FD.money(stats.platformFeeToday); $('online').textContent = stats.riderCountOnline;
  $('orders').innerHTML = orders.orders.length ? `<table><thead><tr><th>Κωδικός</th><th>Κατάσταση</th><th>Ποσό</th><th>Πληρωμή (δοκιμή)</th><th>Χρέωση καταστήματος</th><th>Απόσταση</th><th>Δημιουργήθηκε</th></tr></thead><tbody>${orders.orders.map(o=>`<tr><td>${FD.esc(o.id.slice(0,8))}</td><td>${FD.esc(FD.status(o.status))}</td><td>${FD.money(o.total)}</td><td>${FD.esc(({cash:'Μετρητά',card:'Κάρτα',iris:'IRIS'})[o.paymentMethod]||'—')} · Χωρίς χρέωση</td><td>${FD.money(o.status==='delivered'?(o.shopFeeCents||0)/100:0)}</td><td>${o.estimatedKm == null ? '—' : FD.esc(o.estimatedKm+' km')}</td><td>${new Date(o.createdAt).toLocaleString('el-GR')}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Δεν υπάρχουν ακόμη παραγγελίες.</p>';
  for (const key of ['customerServiceFee','shopDeliveryFee','shopCommissionPercent','riderBaseAmount','riderPerKm','badWeatherBonus']) $(key).value = config.settings[key];
  await loadCourierApplications();
}
async function boot() {
  const health = await FD.api('/api/health'); $('mode').textContent = `Server online · v${health.version} · ${health.mode === 'local-demo' ? 'Τοπική δοκιμή' : 'Πιλοτικό περιβάλλον'}`;
  $('aiMode').textContent = health.aiConfigured ? 'Πραγματικό AI ενεργό' : 'Περιορισμένος οδηγός · χωρίς AI';
  $('storageWarning').textContent = health.storage === 'postgres' ? 'Η μόνιμη βάση PostgreSQL είναι συνδεδεμένη.' : 'ΠΡΟΣΟΧΗ: προσωρινή αποθήκευση. Τα στοιχεία μπορεί να χαθούν σε επανεκκίνηση ή νέο deployment.';
  const me = await FD.me('admin'); if (me.authenticated && me.role === 'admin') { $('login').classList.add('hidden'); $('dashboard').classList.remove('hidden'); await loadDashboard(); }
}
$('loginBtn').addEventListener('click', async()=>{ try { await FD.login('admin',$('code').value); $('login').classList.add('hidden'); $('dashboard').classList.remove('hidden'); await loadDashboard(); } catch(e){FD.notice('loginMsg',e.message,true);} });
$('refresh').addEventListener('click',()=>loadDashboard().catch(e=>FD.notice('settingsMsg',e.message,true)));
$('saveSettings').addEventListener('click',async()=>{try{const body={};for(const key of ['customerServiceFee','shopDeliveryFee','shopCommissionPercent','riderBaseAmount','riderPerKm','badWeatherBonus'])body[key]=Number($(key).value);await FD.api('/api/settings',{method:'PATCH',body:JSON.stringify(body)});FD.notice('settingsMsg','Οι ρυθμίσεις αποθηκεύτηκαν.');await loadDashboard();}catch(e){FD.notice('settingsMsg',e.message,true);}});
$('resetShopCode').addEventListener('click',async()=>{if(!confirm('Ο προηγούμενος κωδικός καταστήματος θα ακυρωθεί. Συνέχεια;'))return;try{const result=await FD.api('/api/admin/shop-code',{method:'POST',body:'{}'});FD.notice('shopCodeNotice',`ΝΕΟΣ ΚΩΔΙΚΟΣ ΚΑΤΑΣΤΗΜΑΤΟΣ (εμφανίζεται μόνο τώρα):\n${result.accessCode}\n\nΑποθήκευσέ τον σε ασφαλές μέρος. ${result.warning || ''}`);}catch(e){FD.notice('shopCodeNotice',e.message,true);}});
$('logout').addEventListener('click',async()=>{await FD.logout('admin');location.reload();});
$('askAi').addEventListener('click',async()=>{const message=$('question').value.trim();if(!message)return;appendBubble('me',message);$('question').value='';$('askAi').disabled=true;FD.notice('aiMsg','Ο βοηθός επεξεργάζεται την ερώτηση…');try{const r=await FD.api('/api/assistant',{method:'POST',body:JSON.stringify({message,history:chatHistory})});appendBubble('assistant',r.answer);chatHistory.push({role:'user',content:message},{role:'assistant',content:r.answer});chatHistory=chatHistory.slice(-8);FD.notice('aiMsg',r.mode==='guide'?'Απάντηση από τον βασικό οδηγό, όχι από μοντέλο AI.':'');}catch(e){FD.notice('aiMsg',e.message,true);}finally{$('askAi').disabled=false;}});
function appendBubble(role,text){const node=document.createElement('div');node.className='bubble'+(role==='me'?' me':'');node.textContent=text;$('chatLog').appendChild(node);$('chatLog').scrollTop=$('chatLog').scrollHeight;}
$('reloadCourierApplications').addEventListener('click',()=>loadCourierApplications().catch(e=>FD.notice('courierApplicationNotice',e.message,true)));
boot().catch(e=>{$('mode').textContent='Σφάλμα σύνδεσης: '+e.message;});
