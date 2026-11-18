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
    const interest=app.kind==='interest';
    return `<article class="candidate-card" data-candidate="${FD.esc(app.id)}">
      <div class="row"><h3>${FD.esc(interest?'Νέα εκδήλωση ενδιαφέροντος':app.fullName)}</h3><span class="status ${ready?'good':'wait'}">${interest?'Λίστα ενδιαφέροντος':ready?'Προέλεγχος πλήρης':'Εκκρεμότητες'}</span></div>
      <p class="candidate-contact"><a href="mailto:${FD.esc(app.email)}">${FD.esc(app.email)}</a>${interest?'':` · <a href="tel:${FD.esc(app.phone)}">${FD.esc(app.phone)}</a>`}</p>
      ${interest?`<p class="small muted">Περιοχή: ${FD.esc(app.region||'—')} · Δήλωση: ${new Date(app.createdAt).toLocaleString('el-GR')}</p><p class="hint">Δεν ζητήθηκαν δικαιολογητικά. Δεν έχει δημιουργηθεί λογαριασμός.</p>`:`<p class="small muted">Περιοχή: ${FD.esc(app.region)} · Μέσο: ${FD.esc(({bicycle:'Ποδήλατο',moped:'Μοτοποδήλατο',motorcycle:'Μοτοσικλέτα',car:'Αυτοκίνητο'})[app.vehicle]||app.vehicle)} · Κατηγορία: ${FD.esc(app.licenseCategory)}</p>
      <p class="small muted">Δηλώθηκε: ${new Date(app.createdAt).toLocaleString('el-GR')} · Ασφάλιση έως: ${FD.esc(app.insuranceUntil||'—')}</p>
      <p class="small muted">Δηλώνει επαγγελματική δραστηριότητα: ${app.businessActive?'Ναι':'Όχι'} · Παραστατικά: ${app.canInvoice?'Ναι':'Όχι'} · Εξοπλισμός: ${app.equipmentReady?'Ναι':'Όχι'}</p>
      ${findings.length?`<strong class="warning">Σημεία προς επαλήθευση</strong><ul class="candidate-issues">${findings.map(issue=>`<li>${FD.esc(issue)}</li>`).join('')}</ul>`:'<p class="small muted">Δεν εντοπίστηκαν ελλείψεις στα δηλωμένα στοιχεία. Απαιτείται εξέταση εγγράφων.</p>'}`}
      <div class="field"><label>Κατάσταση ανθρώπινου ελέγχου</label><select data-candidate-status>${Object.entries(COURIER_STATUS_LABELS).map(([value,label])=>`<option value="${value}" ${value===app.status?'selected':''}>${label}</option>`).join('')}</select></div>
      <div class="field"><label>Σημειώσεις διαχειριστή (έως 500 χαρακτήρες)</label><textarea data-candidate-notes maxlength="500" rows="2">${FD.esc(app.reviewNotes||'')}</textarea></div>
      <div class="actions"><button type="button" data-candidate-save>Αποθήκευση ελέγχου</button><button type="button" class="secondary" data-candidate-delete>Διαγραφή αίτησης</button></div>
    </article>`;
  }).join(''):'<p class="hint">Δεν υπάρχουν ακόμη δηλώσεις ενδιαφέροντος ή αιτήσεις.</p>';
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

let billingStore='default';
async function loadStoreAdmin(){
  const {stores}=await FD.api('/api/admin/stores');
  $('billingStore').innerHTML=stores.map(s=>`<option value="${FD.esc(s.id)}">${FD.esc(s.name)}${s.active?'':' — προετοιμασία'}</option>`).join('');
  $('billingStore').value=billingStore;
  $('storeList').innerHTML=stores.map(s=>`<article class="order"><b>${FD.esc(s.name)}</b><p class="hint">ID: ${FD.esc(s.id)} · ${s.active?'Ορατό στο πιλοτικό μενού':'Προετοιμασία'}</p><button type="button" class="secondary" data-store-rename="${FD.esc(s.id)}">Μετονομασία</button> <button type="button" class="secondary" data-store-code="${FD.esc(s.id)}">Νέος κωδικός</button> ${s.id==='default'?'':`<button type="button" class="secondary" data-store-toggle="${FD.esc(s.id)}" data-active="${s.active}">${s.active?'Απόκρυψη':'Εμφάνιση στο πιλοτικό μενού'}</button>`}</article>`).join('');
  document.querySelectorAll('[data-store-code]').forEach(b=>b.onclick=async()=>{if(!confirm('Να ακυρωθεί ο προηγούμενος κωδικός και να αποσυνδεθεί το συγκεκριμένο κατάστημα;'))return;try{const r=await FD.api('/api/admin/shop-code',{method:'POST',body:JSON.stringify({storeId:b.dataset.storeCode})});FD.notice('storesNotice','ID: '+b.dataset.storeCode+' · Νέος κωδικός (μία φορά): '+r.accessCode);}catch(e){FD.notice('storesNotice',e.message,true);}});
  document.querySelectorAll('[data-store-toggle]').forEach(b=>b.onclick=async()=>{try{await FD.api('/api/admin/stores',{method:'PATCH',body:JSON.stringify({storeId:b.dataset.storeToggle,active:b.dataset.active!=='true'})});await loadStoreAdmin();await loadBilling();}catch(e){FD.notice('storesNotice',e.message,true);}});
  document.querySelectorAll('[data-store-rename]').forEach(b=>b.onclick=async()=>{const name=prompt('Νέο όνομα καταστήματος');if(!name)return;try{await FD.api('/api/admin/stores',{method:'PATCH',body:JSON.stringify({storeId:b.dataset.storeRename,name})});await loadStoreAdmin();}catch(e){FD.notice('storesNotice',e.message,true);}});
}
$('billingStore').onchange=()=>{billingStore=$('billingStore').value;loadBilling().catch(e=>FD.notice('billingNotice',e.message,true));};
$('createStore').onclick=async()=>{const button=$('createStore');button.disabled=true;try{const r=await FD.api('/api/admin/stores',{method:'POST',body:JSON.stringify({name:$('newStoreName').value})});$('newStoreName').value='';FD.notice('storesNotice','ID: '+r.store.id+' · Κωδικός (μία φορά): '+r.accessCode);await loadStoreAdmin();}catch(e){FD.notice('storesNotice',e.message,true);}finally{button.disabled=false;}};
async function loadBilling(){
  const selected=billingStore;
  const data=await FD.api('/api/shop/billing?storeId='+encodeURIComponent(selected));
  if(selected!==billingStore)return;
  $('billingOutstanding').textContent=FD.money(data.outstandingCents/100);
  $('payoutBeneficiary').value=data.payout?.beneficiary||'';
  $('payoutIban').value=data.payout?.iban||'';
  $('payoutPhone').value=data.payout?.irisPhone||data.payout?.pendingIrisPhone||'';
  $('payoutIrisConfirmed').checked=Boolean(data.payout?.irisPhone);
  $('holdStatus').textContent=data.hold.suspended?'Σε αναμονή: '+data.hold.reason:'Χωρίς αναστολή οφειλών — ισχύει το ωράριο καταστήματος';
  $('holdSuspend').disabled=data.hold.suspended||!data.outstandingCents;
  $('holdResume').disabled=!data.hold.suspended;
  $('holdHistory').innerHTML=data.holdHistory.slice().reverse().map(h=>`<p class="hint">${FD.esc(new Date(h.changedAt).toLocaleString('el-GR'))} · ${h.suspended?'Αναστολή':'Επανενεργοποίηση'} · ${FD.esc(h.reason)}</p>`).join('');
  $('billingDays').innerHTML=data.days.map(d=>`<article class="order"><b>${FD.esc(d.day)}</b><p class="hint">${d.completed} ολοκληρωμένες · Σύνολο ${FD.money(d.feeCents/100)} · Καταχωρισμένες εξοφλήσεις ${FD.money(d.settledCents/100)}</p><b>Εκκρεμούν ${FD.money(d.outstandingCents/100)}</b>${d.outstandingCents?`<div class="actions"><button type="button" data-bill-day="${FD.esc(d.day)}" data-bill-cents="${d.outstandingCents}">Καταχώριση δοκιμαστικής εξόφλησης</button></div>`:''}</article>`).join('')||'<p class="hint">Καμία ολοκληρωμένη παραγγελία στο νέο μοντέλο.</p>';
  $('billingHistory').innerHTML=data.history.map(x=>`<div class="product"><div><b>${FD.esc(x.day)} · ${FD.money(x.amountCents/100)}</b><p class="hint">Δοκιμαστική καταχώριση · ${new Date(x.recordedAt).toLocaleString('el-GR')}</p></div></div>`).join('')||'<p class="hint">Καμία καταχώριση ακόμα.</p>';
  document.querySelectorAll('[data-bill-day]').forEach(b=>b.onclick=async()=>{
    if(!confirm('Να καταχωριστεί δοκιμαστική εξόφληση '+FD.money(Number(b.dataset.billCents)/100)+'; Δεν γίνεται είσπραξη.'))return;
    b.disabled=true;
    try{await FD.api('/api/admin/shop-settlements',{method:'POST',body:JSON.stringify({storeId:selected,day:b.dataset.billDay,expectedCents:Number(b.dataset.billCents),confirmPilot:true})});FD.notice('billingNotice','Η δοκιμαστική εξόφληση καταχωρίστηκε.');}
    catch(e){FD.notice('billingNotice',e.message,true);}
    finally{await loadBilling().catch(e=>FD.notice('billingNotice',e.message,true));}
  });
}
$('billingRefresh').onclick=()=>loadBilling().catch(e=>FD.notice('billingNotice',e.message,true));
async function changeShopControl(path,body){
  const adminCode=prompt('Επιβεβαίωσε με τον κωδικό Admin.');
  if(!adminCode)return;
  try{await FD.api('/api/admin/'+path,{method:'PATCH',body:JSON.stringify({...body,storeId:billingStore,adminCode})});FD.notice('billingNotice','Η αλλαγή αποθηκεύτηκε.');await loadBilling();}
  catch(e){FD.notice('billingNotice',e.message,true);}
}
$('payoutSave').onclick=()=>changeShopControl('shop-payout',{beneficiary:$('payoutBeneficiary').value,iban:$('payoutIban').value,irisPhone:$('payoutPhone').value,irisBusinessConfirmed:$('payoutIrisConfirmed').checked});
$('holdSuspend').onclick=()=>changeShopControl('shop-hold',{suspended:true,reason:$('holdReason').value,noticeConfirmed:$('holdNoticeConfirmed').checked});
$('holdResume').onclick=()=>changeShopControl('shop-hold',{suspended:false,reason:$('holdReason').value,correctionConfirmed:$('holdCorrection').checked});

async function loadDashboard() {
  await loadStoreAdmin();
  await loadBilling();
  const [stats, orders, config] = await Promise.all([FD.api('/api/stats'), FD.api('/api/orders'), FD.api('/api/config')]);
  $('active').textContent = stats.activeOrders; $('today').textContent = stats.ordersToday; $('delivered').textContent = stats.deliveredToday;
  $('gross').textContent = FD.money(stats.grossValueToday); $('platformFee').textContent = FD.money(stats.platformFeeToday); $('online').textContent = stats.riderCountOnline;
  $('orders').innerHTML = orders.orders.length ? `<table><thead><tr><th>Κωδικός</th><th>Κατάστημα</th><th>Κατάσταση</th><th>Ποσό</th><th>Πληρωμή (δοκιμή)</th><th>Χρέωση καταστήματος</th><th>Απόσταση</th><th>Δημιουργήθηκε</th></tr></thead><tbody>${orders.orders.map(o=>`<tr><td>${FD.esc(o.id.slice(0,8))}</td><td>${FD.esc(o.storeName||'Πρώτο κατάστημα')}</td><td>${FD.esc(FD.status(o.status))}</td><td>${FD.money(o.total)}</td><td>${FD.esc(({cash:'Μετρητά',card:'Κάρτα',iris:'IRIS'})[o.paymentMethod]||'—')} · Χωρίς χρέωση</td><td>${FD.money(o.status==='delivered'?(o.shopFeeCents||0)/100:0)}</td><td>${o.estimatedKm == null ? '—' : FD.esc(o.estimatedKm+' km')}</td><td>${new Date(o.createdAt).toLocaleString('el-GR')}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Δεν υπάρχουν ακόμη παραγγελίες.</p>';
  for (const key of ['customerServiceFee','shopDeliveryFee','shopCommissionPercent','riderBaseAmount','riderPerKm','badWeatherBonus']) $(key).value = config.settings[key];
  await loadCourierApplications();
}
async function boot() {
  const health = await FD.api('/api/health'); $('mode').textContent = `Server online · v${health.version} · ${health.mode === 'local-demo' ? 'Τοπική δοκιμή' : 'Πιλοτικό περιβάλλον'}`;
  $('aiMode').textContent = health.aiConfigured ? 'GPT-OSS 120B · συνδεδεμένο' : 'Τοπικές αναφορές · αναμονή κλειδιού AI'; $('askAi').disabled=!health.aiConfigured; $('aiSetup').hidden=health.aiConfigured;
  $('storageWarning').textContent = health.storage === 'postgres' ? 'Η μόνιμη βάση PostgreSQL είναι συνδεδεμένη.' : 'ΠΡΟΣΟΧΗ: προσωρινή αποθήκευση. Τα στοιχεία μπορεί να χαθούν σε επανεκκίνηση ή νέο deployment.';
  const me = await FD.me('admin'); if (me.authenticated && me.role === 'admin') { $('login').classList.add('hidden'); $('dashboard').classList.remove('hidden'); await loadDashboard(); }
}
$('loginBtn').addEventListener('click', async()=>{ try { await FD.login('admin',$('code').value); $('login').classList.add('hidden'); $('dashboard').classList.remove('hidden'); await loadDashboard(); } catch(e){FD.notice('loginMsg',e.message,true);} });
$('refresh').addEventListener('click',()=>loadDashboard().catch(e=>FD.notice('settingsMsg',e.message,true)));
$('saveSettings').addEventListener('click',async()=>{try{const body={};for(const key of ['customerServiceFee','shopDeliveryFee','shopCommissionPercent','riderBaseAmount','riderPerKm','badWeatherBonus'])body[key]=Number($(key).value);await FD.api('/api/settings',{method:'PATCH',body:JSON.stringify(body)});FD.notice('settingsMsg','Οι ρυθμίσεις αποθηκεύτηκαν.');await loadDashboard();}catch(e){FD.notice('settingsMsg',e.message,true);}});
$('resetShopCode').addEventListener('click',async()=>{if(!confirm('Ο προηγούμενος κωδικός καταστήματος θα ακυρωθεί. Συνέχεια;'))return;try{const result=await FD.api('/api/admin/shop-code',{method:'POST',body:'{}'});FD.notice('shopCodeNotice',`ΝΕΟΣ ΚΩΔΙΚΟΣ ΚΑΤΑΣΤΗΜΑΤΟΣ (εμφανίζεται μόνο τώρα):\n${result.accessCode}\n\nΑποθήκευσέ τον σε ασφαλές μέρος. ${result.warning || ''}`);}catch(e){FD.notice('shopCodeNotice',e.message,true);}});
$('logout').addEventListener('click',async()=>{await FD.logout('admin');location.reload();});
$('askAi').addEventListener('click',async()=>{
  const message=$('question').value.trim();if(!message)return;
  if(!$('externalAiConsent').checked){FD.notice('aiMsg','Επιβεβαίωσε ότι η ερώτηση δεν έχει προσωπικά ή εμπιστευτικά στοιχεία.',true);return;}
  appendBubble('me',message);$('question').value='';$('askAi').disabled=true;FD.notice('aiMsg','Το GPT-OSS 120B επεξεργάζεται την ερώτηση…');
  try{const r=await FD.api('/api/assistant',{method:'POST',body:JSON.stringify({message,externalConfirmed:true})});appendBubble('assistant',r.answer,true);FD.notice('aiMsg',r.truncated?'Η απάντηση έφτασε στο όριο. Ζήτησε πιο σύντομη απάντηση ή το επόμενο μέρος.':'Απάντηση AI · μπορεί να περιέχει λάθη.',r.truncated===true);}
  catch(e){FD.notice('aiMsg',e.message,true);}finally{$('askAi').disabled=false;}
});
document.querySelectorAll('[data-local-report]').forEach(button=>button.onclick=async()=>{
  button.disabled=true;appendBubble('me',button.textContent.trim());
  try{const r=await FD.api('/api/assistant',{method:'POST',body:JSON.stringify({report:button.dataset.localReport})});appendBubble('assistant',r.answer);FD.notice('aiMsg','Τοπική αναφορά από τα δεδομένα του Fair Delivery.');}catch(e){FD.notice('aiMsg',e.message,true);}finally{button.disabled=false;}
});
$('clearAiChat').onclick=()=>{$('chatLog').replaceChildren();appendBubble('assistant','Τι θέλεις να δούμε;');FD.notice('aiMsg','');};

function appendBubble(role,text,formatted=false){const node=document.createElement('div');node.className='bubble'+(role==='me'?' me':'');if(formatted){node.classList.add('ai-formatted');renderAiText(node,text);}else node.textContent=text;$('chatLog').appendChild(node);$('chatLog').scrollTop=$('chatLog').scrollHeight;}
$('reloadCourierApplications').addEventListener('click',()=>loadCourierApplications().catch(e=>FD.notice('courierApplicationNotice',e.message,true)));
boot().catch(e=>{$('mode').textContent='Σφάλμα σύνδεσης: '+e.message;});

 // Render only safe text nodes and a small Markdown subset. No HTML, links or scripts from AI.
function aiInline(node,text){
 const parts=String(text).split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
 for(const part of parts){if(part.startsWith('**')&&part.endsWith('**')&&part.length>4){const el=document.createElement('strong');el.textContent=part.slice(2,-2);node.appendChild(el);}else if(part.startsWith('`')&&part.endsWith('`')&&part.length>2){const el=document.createElement('code');el.textContent=part.slice(1,-1);node.appendChild(el);}else node.appendChild(document.createTextNode(part));}
}
function renderAiText(root,text){
 const lines=String(text||'').split(/\r?\n/);
 let list=null;
 const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
 const separator=line=>/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line||'');
 for(let i=0;i<lines.length;i++){
  const line=lines[i].trim();if(!line){list=null;continue;}
  if(line.includes('|')&&separator(lines[i+1])){
   list=null;const wrap=document.createElement('div');wrap.className='ai-table-wrap';const table=document.createElement('table');
   const row=(value,header)=>{const tr=document.createElement('tr');for(const cell of cells(value)){const td=document.createElement(header?'th':'td');aiInline(td,cell);tr.appendChild(td);}return tr;};
   const head=document.createElement('thead');head.appendChild(row(line,true));table.appendChild(head);const body=document.createElement('tbody');i++;
   while(i+1<lines.length&&lines[i+1].trim().includes('|')&&lines[i+1].trim()){body.appendChild(row(lines[++i],false));}
   table.appendChild(body);wrap.appendChild(table);root.appendChild(wrap);continue;
  }
  const heading=line.match(/^#{1,6}\s+(.+)$/);if(heading){list=null;const el=document.createElement('h4');aiInline(el,heading[1]);root.appendChild(el);continue;}
  if(/^[-*_]{3,}$/.test(line)){list=null;root.appendChild(document.createElement('hr'));continue;}
  const item=line.match(/^([-*]|\d+\.)\s+(.+)$/);if(item){const tag=/\d/.test(item[1])?'ol':'ul';if(!list||list.tagName.toLowerCase()!==tag){list=document.createElement(tag);root.appendChild(list);}const li=document.createElement('li');aiInline(li,item[2]);list.appendChild(li);continue;}
  list=null;const el=document.createElement('p');aiInline(el,line);root.appendChild(el);
 }
}
