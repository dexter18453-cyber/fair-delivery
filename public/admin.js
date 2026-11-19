'use strict';
const $ = id => document.getElementById(id);
let chatHistory = [];
const COURIER_STATUS_LABELS={
  'new':'Νέα αίτηση','contacted':'Έγινε επικοινωνία','needs-documents':'Εκκρεμούν δικαιολογητικά',
  'reviewing':'Εξετάζεται','not-suitable':'Δεν προχωρά (απόφαση διαχειριστή)','resolved':'Ολοκληρώθηκε'
};
async function loadCourierApplications(){
  const data=await FD.api('/api/admin/courier-applications');
  const applications=data.applications||[];
  if(appSeenIds===null)appSeenIds=new Set(applications.slice(0,50).map(a=>a.id));
  renderApplicationBadge(applications.filter(a=>a.status==='new').length);
  const node=$('courierApplications');
  if(!node)return;
  node.innerHTML=applications.length?applications.map(app=>{
    const findings=app.screening?.issues||[];
    const ready=app.screening?.status==='ready-for-review';
    const interest=app.kind==='interest';
    const privacy=app.kind==='privacy-request';
    const rightsLabels={withdraw:'Ανάκληση συγκατάθεσης',erase:'Διαγραφή',access:'Πρόσβαση',rectify:'Διόρθωση'};
    const choices=privacy?Object.fromEntries(Object.entries(COURIER_STATUS_LABELS).filter(([key])=>['new','reviewing','contacted','resolved'].includes(key))):COURIER_STATUS_LABELS;
    return `<article class="candidate-card" data-candidate="${FD.esc(app.id)}">
      <div class="row"><h3>${FD.esc(privacy?'Αίτημα προστασίας δεδομένων':interest?'Νέα εκδήλωση ενδιαφέροντος':app.fullName)}</h3><span class="status ${ready?'good':'wait'}">${privacy?'Αίτημα δικαιωμάτων':interest?'Λίστα ενδιαφέροντος':ready?'Προέλεγχος πλήρης':'Εκκρεμότητες'}</span></div>
      <p class="candidate-contact"><a href="mailto:${FD.esc(app.email)}">${FD.esc(app.email)}</a>${interest||privacy?'':` · <a href="tel:${FD.esc(app.phone)}">${FD.esc(app.phone)}</a>`}</p>
      ${privacy?`<p class="small muted">Αίτημα: ${FD.esc(rightsLabels[app.requestType]||'Διαχείριση δεδομένων')} · Υποβλήθηκε: ${new Date(app.createdAt).toLocaleString('el-GR')}</p><p class="hint">Πριν από διαγραφή/αλλαγή/χορήγηση στοιχείων πρέπει να επιβεβαιωθεί η ταυτότητα του αιτούντος. Η διαγραφή αυτού του αιτήματος δεν διαγράφει αυτομάτως προηγούμενη εκδήλωση ενδιαφέροντος.</p>`:interest?`<p class="small muted">Περιοχή: ${FD.esc(app.region||'—')} · Δήλωση: ${new Date(app.createdAt).toLocaleString('el-GR')}</p><p class="hint">Δεν ζητήθηκαν δικαιολογητικά. Δεν έχει δημιουργηθεί λογαριασμός.</p>`:`<p class="small muted">Περιοχή: ${FD.esc(app.region)} · Μέσο: ${FD.esc(({bicycle:'Ποδήλατο',moped:'Μοτοποδήλατο',motorcycle:'Μοτοσικλέτα',car:'Αυτοκίνητο'})[app.vehicle]||app.vehicle)} · Κατηγορία: ${FD.esc(app.licenseCategory)}</p>
      <p class="small muted">Δηλώθηκε: ${new Date(app.createdAt).toLocaleString('el-GR')} · Ασφάλιση έως: ${FD.esc(app.insuranceUntil||'—')}</p>
      <p class="small muted">Δηλώνει επαγγελματική δραστηριότητα: ${app.businessActive?'Ναι':'Όχι'} · Παραστατικά: ${app.canInvoice?'Ναι':'Όχι'} · Εξοπλισμός: ${app.equipmentReady?'Ναι':'Όχι'}</p>
      ${findings.length?`<strong class="warning">Σημεία προς επαλήθευση</strong><ul class="candidate-issues">${findings.map(issue=>`<li>${FD.esc(issue)}</li>`).join('')}</ul>`:'<p class="small muted">Δεν εντοπίστηκαν ελλείψεις στα δηλωμένα στοιχεία. Απαιτείται εξέταση εγγράφων.</p>'}`}
      <div class="field"><label>Κατάσταση ανθρώπινου ελέγχου</label><select data-candidate-status>${Object.entries(choices).map(([value,label])=>`<option value="${value}" ${value===app.status?'selected':''}>${label}</option>`).join('')}</select></div>
      <div class="field"><label>Σημειώσεις διαχειριστή (έως 500 χαρακτήρες)</label><textarea data-candidate-notes maxlength="500" rows="2">${FD.esc(app.reviewNotes||'')}</textarea></div>
      <div class="actions"><button type="button" data-candidate-save>Αποθήκευση ελέγχου</button><button type="button" class="secondary" data-candidate-delete>${privacy?'Διαγραφή αιτήματος':'Διαγραφή αίτησης'}</button></div>
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
  const me = await FD.me('admin'); if (me.authenticated && me.role === 'admin') { $('login').classList.add('hidden'); $('dashboard').classList.remove('hidden'); await loadDashboard(); startApplicationMonitoring(); }
}
$('adminLoginForm').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('loginBtn');button.disabled=true;
  try{
    await FD.login('admin',$('code').value,{email:$('adminEmail').value.trim()});
    $('code').value='';
    FD.notice('loginMsg','');
    $('login').classList.add('hidden');$('dashboard').classList.remove('hidden');
    await loadDashboard();startApplicationMonitoring();
  }catch(e){FD.notice('loginMsg',e.message,true);}
  finally{button.disabled=false;}
});
$('adminChangePassword').addEventListener('click',async()=>{
  const currentCode=$('adminCurrentCode').value,newCode=$('adminNewCode').value,again=$('adminNewCodeAgain').value;
  if(newCode.length<12||newCode!==again){FD.notice('adminPasswordNotice','Ο νέος κωδικός πρέπει να έχει τουλάχιστον 12 χαρακτήρες και να ταιριάζει με την επανάληψη.',true);return;}
  if(!confirm('Η αλλαγή θα αποσυνδέσει όλες τις συσκευές σου. Θέλεις να συνεχίσεις;'))return;
  const button=$('adminChangePassword');button.disabled=true;
  try{
    await FD.api('/api/admin/change-password',{method:'POST',body:JSON.stringify({currentCode,newCode})});
    for(const id of ['adminCurrentCode','adminNewCode','adminNewCodeAgain'])$(id).value='';
    alert('Ο προσωπικός κωδικός άλλαξε. Θα συνδεθείς ξανά με το email σου και τον νέο κωδικό.');
    location.href='/app/admin/';
    location.reload();
  }catch(e){FD.notice('adminPasswordNotice',e.message,true);}
  finally{button.disabled=false;}
});
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
let migrationReady=false;
$('migrationPreflight').onclick=async()=>{
 const b=$('migrationPreflight');b.disabled=true;migrationReady=false;$('migrationCopy').disabled=true;FD.notice('migrationStatus','Έλεγχος παλιάς και νέας βάσης…');
 try{
  const data=await FD.api('/api/admin/migration/preflight');
  migrationReady=data.copyAvailable;
  $('migrationDigest').value=data.source.digest;
  FD.notice('migrationStatus','Παλιά βάση: '+Object.entries(data.source.counts).map(([k,v])=>k+' '+v).join(' · ')+' · SHA-256: '+data.source.digest+' · Νέα βάση: '+data.destination.recordCount+' εγγραφές · Συντήρηση: '+(data.maintenance?'ενεργή':'ανενεργή')+'. '+(data.copyAvailable?'Η αντιγραφή μπορεί να γίνει μετά τον έλεγχο του τελικού backup.':'Απαιτείται συντήρηση και κενή βάση.'));
  $('migrationCopy').disabled=!migrationReady;
 }catch(e){FD.notice('migrationStatus',e.message,true);}
 finally{b.disabled=false;}
};
$('migrationCopy').onclick=async()=>{
 if(!migrationReady)return;
 if(!confirm('Έχεις ελέγξει το τελικό backup και τη φράση του; Θα γίνει μόνο αντιγραφή στην κενή Neon, χωρίς αλλαγή της παλιάς βάσης.'))return;
 const b=$('migrationCopy');b.disabled=true;
 try{
  const result=await FD.api('/api/admin/migration/copy',{method:'POST',body:JSON.stringify({adminCode:$('migrationAdminCode').value,expectedDigest:$('migrationDigest').value.trim(),confirmDownloadedBackup:$('migrationBackupConfirmed').checked,confirmNewDatabase:$('migrationDestinationConfirmed').checked})});
  migrationReady=false;FD.notice('migrationStatus','Η αντιγραφή και επαλήθευση ολοκληρώθηκαν. SHA-256: '+result.integritySha256+'. Η εφαρμογή χρησιμοποιεί ακόμη την παλιά βάση μέχρι την ελεγχόμενη αλλαγή σύνδεσης.');
 }catch(e){FD.notice('migrationStatus',e.message,true);}
 finally{for(const id of ['migrationAdminCode'])$(id).value='';}
};
$('storageVerify').onclick=async()=>{
 const b=$('storageVerify');b.disabled=true;FD.notice('storageVerifyStatus','Γίνεται έλεγχος της αποθηκευμένης βάσης…');
 try{
 const r=await FD.api('/api/admin/storage/verify');
 const rows=Object.entries(r.counts).map(([k,v])=>k+': '+v).join(' · ');
 const expiry=r.expiresAt?new Date(r.expiresAt).toLocaleDateString('el-GR'):'δεν έχει οριστεί στο Render';
 FD.notice('storageVerifyStatus','Αποθήκευση: '+r.storage+' · Εγγραφές: '+rows+' · SHA-256: '+r.integritySha256+' · Ημερομηνία λήξης: '+expiry);
 }catch(e){FD.notice('storageVerifyStatus','Ο έλεγχος απέτυχε: '+e.message,true);}
 finally{b.disabled=false;}
};
$('backupDownload').onclick=async()=>{
 const button=$('backupDownload'),passphrase=$('backupPhrase').value;
 if(passphrase.length<20||passphrase!==$('backupRepeat').value){FD.notice('backupNotice','Η φράση πρέπει να έχει τουλάχιστον 20 χαρακτήρες και να συμφωνεί με την επανάληψη.',true);return;}
 if(!confirm('Το κρυπτογραφημένο αρχείο περιλαμβάνει το αποθηκευμένο μητρώο. Θα το φυλάξεις ιδιωτικά;'))return;
 button.disabled=true;FD.notice('backupNotice','Δημιουργία κρυπτογραφημένου αντιγράφου…');
 try{
 const envelope=await FD.api('/api/admin/backup',{method:'POST',body:JSON.stringify({adminCode:$('backupAdminCode').value,passphrase,confirm:true})});
 const blob=new Blob([JSON.stringify(envelope)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
 link.href=url;link.download='fair-delivery-backup-'+new Date().toISOString().slice(0,10)+'.encrypted.json';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
 FD.notice('backupNotice','Το αντίγραφο δημιουργήθηκε. Έλεγξε ότι αποθηκεύτηκε στη συσκευή σου.');
 }catch(e){FD.notice('backupNotice',e.message,true);}
 finally{button.disabled=false;for(const id of ['backupPhrase','backupRepeat','backupAdminCode'])$(id).value='';}
};

let appSeenIds=null,appTimer=null,appAudio=null,appSoundOn=false;
let appNotificationBusy=false,appPushPreparing=false,appPushState=null;
function renderApplicationBadge(count){
 const badge=$('applicationTabCount'),label=$('applicationCounter');
 if(badge)badge.textContent=count?'('+count+')':'';
 if(label)label.textContent=count===0?'Δεν υπάρχουν νέα αιτήματα.':'Νέα αιτήματα προς έλεγχο: '+count;
 try{if('setAppBadge' in navigator){if(count)navigator.setAppBadge(count).catch(()=>{});else navigator.clearAppBadge?.().catch(()=>{});}}catch{}
}
function playApplicationSound(){
 if(!appSoundOn||!appAudio||appAudio.state!=='running')return;
 const base=appAudio.currentTime;
 for(const [delay,hz] of [[0,660],[.18,880],[.36,1175]]){
   const o=appAudio.createOscillator(),gain=appAudio.createGain();
   o.type='sine';o.frequency.value=hz;gain.gain.setValueAtTime(.085,base+delay);
   gain.gain.exponentialRampToValueAtTime(.001,base+delay+.15);
   o.connect(gain);gain.connect(appAudio.destination);o.start(base+delay);o.stop(base+delay+.16);
 }
}
$('applicationSoundButton').onclick=async()=>{
 const button=$('applicationSoundButton');
 try{
  if(appSoundOn){appSoundOn=false;await appAudio?.suspend();}
  else{
   const Audio=window.AudioContext||window.webkitAudioContext;
   if(!Audio)throw Error('Ο browser δεν υποστηρίζει ήχο.');
   appAudio=appAudio||new Audio();
   await appAudio.resume();
   if(appAudio.state!=='running')throw Error('Ο browser δεν επέτρεψε ήχο.');
   appSoundOn=true;playApplicationSound();
  }
  button.setAttribute('aria-pressed',String(appSoundOn));
  button.textContent=appSoundOn?'Απενεργοποίηση ήχου':'Ενεργοποίηση ήχου';
  FD.notice('applicationNotificationStatus',appSoundOn?'Ο ήχος είναι ενεργός όσο η εφαρμογή παραμένει ανοιχτή.':'Ο ήχος απενεργοποιήθηκε.');
 }catch(e){appSoundOn=false;FD.notice('applicationNotificationStatus',e.message,true);}
};
async function refreshApplicationSummary(){
 try{
  const summary=await FD.api('/api/admin/courier-applications/summary');
  const ids=summary.recentIds||[];
  if(appSeenIds!==null){
   const newIds=ids.filter(id=>!appSeenIds.has(id));
   if(newIds.length){
    playApplicationSound();
    FD.notice('applicationNotificationStatus',newIds.length===1?'Έφτασε νέο αίτημα! Άνοιξε τις Αιτήσεις.':'Έφτασαν '+newIds.length+' νέα αιτήματα. Άνοιξε τις Αιτήσεις.');
    if(document.querySelector('[data-tab="applications"].active')&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))loadCourierApplications().catch(()=>{});
   }
  }
  appSeenIds=new Set(ids);
  renderApplicationBadge(summary.newCount);
 }catch(e){
  if(e.status===401&&appTimer){clearInterval(appTimer);appTimer=null;}
 }
}
function startApplicationMonitoring(){
 if(appTimer)return;
 refreshApplicationSummary().catch(()=>{});
 prepareApplicationPush();
 appTimer=setInterval(refreshApplicationSummary,12000);
}
function toApplicationServerKey(b64){
 const normalized=b64.replace(/-/g,'+').replace(/_/g,'/');
 const raw=atob(normalized.padEnd(Math.ceil(normalized.length/4)*4,'='));
 return Uint8Array.from(raw,x=>x.charCodeAt(0));
}
function checkApplicationPushSupport(){
 if(!location.pathname.startsWith('/app/admin/'))throw Error('Άνοιξε το Fair Delivery από /app/admin/ και εγκατάστησέ το στην αρχική οθόνη για ειδοποιήσεις στο iPhone.');
 if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))throw Error('Οι ειδοποιήσεις δεν υποστηρίζονται σε αυτή την προβολή. Στο iPhone εγκατάστησε την εφαρμογή από Safari → Κοινή χρήση → Προσθήκη στην οθόνη Αφετηρίας.');
}
async function prepareApplicationPush(){
 if(appPushPreparing||appNotificationBusy)return;
 const button=$('applicationPushButton');appPushPreparing=true;appPushState=null;button.disabled=true;
 button.textContent='Προετοιμασία ειδοποιήσεων…';
 try{
  checkApplicationPushSupport();
  const cfg=await FD.api('/api/admin/push/config');
  if(!cfg.enabled||!cfg.publicKey)throw Error('Οι ειδοποιήσεις κινητού δεν έχουν ενεργοποιηθεί στον server.');
  let timeout;
  const registration=await Promise.race([
   navigator.serviceWorker.ready,
   new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Η προετοιμασία καθυστέρησε. Πάτησε ξανά για επανάληψη.')),10000);})
  ]).finally(()=>clearTimeout(timeout));
  const subscription=await registration.pushManager.getSubscription();
  // Restore an already-authorized device after a reload without asking again.
  if(subscription)await FD.api('/api/admin/push/subscription',{method:'POST',body:JSON.stringify({subscription:subscription.toJSON()})});
  appPushState={registration,publicKey:toApplicationServerKey(cfg.publicKey),subscription};
  button.textContent=subscription?'Διακοπή ειδοποιήσεων':'Ειδοποιήσεις στο κινητό';
 }catch(e){
  button.textContent='Ειδοποιήσεις στο κινητό';
  FD.notice('applicationNotificationStatus',e.message,true);
 }finally{appPushPreparing=false;button.disabled=false;}
}
async function toggleApplicationPush(){
 if(appNotificationBusy||appPushPreparing)return;
 if(!appPushState){
  await prepareApplicationPush();
  if(appPushState)FD.notice('applicationNotificationStatus','Η προετοιμασία ολοκληρώθηκε. Πάτησε ξανά για να αλλάξεις τις ειδοποιήσεις.');
  return;
 }
 const button=$('applicationPushButton'),setup=appPushState;appNotificationBusy=true;button.disabled=true;
 try{
  checkApplicationPushSupport();
  if(setup.subscription){
    await FD.api('/api/admin/push/subscription',{method:'DELETE',body:JSON.stringify({endpoint:setup.subscription.endpoint})});
    await setup.subscription.unsubscribe();
    setup.subscription=null;
    button.textContent='Ειδοποιήσεις στο κινητό';
    FD.notice('applicationNotificationStatus','Οι ειδοποιήσεις σε αυτή τη συσκευή απενεργοποιήθηκαν.');
    return;
  }
  if(Notification.permission==='denied')throw Error('Χρειάζεται να επιτρέψεις τις ειδοποιήσεις στις ρυθμίσεις του κινητού.');
  // Safari needs subscribe() inside the tap handler, before any awaited work.
  // The server key and active service worker were prepared after login.
  const subscription=await setup.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:setup.publicKey});
  try{
    await FD.api('/api/admin/push/subscription',{method:'POST',body:JSON.stringify({subscription:subscription.toJSON()})});
  }catch(e){await subscription.unsubscribe().catch(()=>{});throw e;}
  setup.subscription=subscription;
  button.textContent='Διακοπή ειδοποιήσεων';
  FD.notice('applicationNotificationStatus','Οι ειδοποιήσεις ενεργοποιήθηκαν στη συσκευή σου. Θα εμφανίζονται και όταν η εφαρμογή είναι κλειστή, εφόσον το επιτρέπει το iPhone.');
 }catch(e){FD.notice('applicationNotificationStatus',e.message,true);}
 finally{appNotificationBusy=false;button.disabled=false;}
}
$('applicationPushButton').onclick=()=>toggleApplicationPush();
$('applicationPushTest').onclick=async()=>{
 const b=$('applicationPushTest');b.disabled=true;
 try{
  const r=await FD.api('/api/admin/push/test',{method:'POST',body:'{}'});
  FD.notice('applicationNotificationStatus','Αποστολή δοκιμής: '+r.accepted+' από '+r.attempted+' συσκευές αποδέχτηκαν το αίτημα. Αν δεν εμφανίστηκε στο iPhone, έλεγξε την άδεια ειδοποιήσεων.');
 }catch(e){FD.notice('applicationNotificationStatus',e.message,true);}
 finally{b.disabled=false;}
};

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
