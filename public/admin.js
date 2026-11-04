'use strict';
const $ = id => document.getElementById(id);
let chatHistory = [];
async function loadDashboard() {
  const [stats, orders, config] = await Promise.all([FD.api('/api/stats'), FD.api('/api/orders'), FD.api('/api/config')]);
  $('active').textContent = stats.activeOrders; $('today').textContent = stats.ordersToday; $('delivered').textContent = stats.deliveredToday;
  $('gross').textContent = FD.money(stats.grossValueToday); $('commission').textContent = FD.money(stats.shopsCommissionToday); $('online').textContent = stats.riderCountOnline;
  $('orders').innerHTML = orders.orders.length ? `<table><thead><tr><th>Κωδικός</th><th>Κατάσταση</th><th>Ποσό</th><th>Service fee</th><th>Απόσταση</th><th>Δημιουργήθηκε</th></tr></thead><tbody>${orders.orders.map(o=>`<tr><td>${FD.esc(o.id.slice(0,8))}</td><td>${FD.esc(FD.status(o.status))}</td><td>${FD.money(o.total)}</td><td>${FD.money(o.serviceFee)}</td><td>${o.estimatedKm == null ? '—' : FD.esc(o.estimatedKm+' km')}</td><td>${new Date(o.createdAt).toLocaleString('el-GR')}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Δεν υπάρχουν ακόμη παραγγελίες.</p>';
  for (const key of ['customerServiceFee','shopCommissionPercent','riderBaseAmount','riderPerKm','badWeatherBonus']) $(key).value = config.settings[key];
}
async function boot() {
  const health = await FD.api('/api/health'); $('mode').textContent = `Server online · v${health.version} · ${health.mode === 'local-demo' ? 'Τοπική δοκιμή' : 'Πιλοτικό περιβάλλον'}`;
  const me = await FD.me('admin'); if (me.authenticated && me.role === 'admin') { $('login').classList.add('hidden'); $('dashboard').classList.remove('hidden'); await loadDashboard(); }
}
$('loginBtn').addEventListener('click', async()=>{ try { await FD.login('admin',$('code').value); $('login').classList.add('hidden'); $('dashboard').classList.remove('hidden'); await loadDashboard(); } catch(e){FD.notice('loginMsg',e.message,true);} });
$('refresh').addEventListener('click',()=>loadDashboard().catch(e=>FD.notice('settingsMsg',e.message,true)));
$('saveSettings').addEventListener('click',async()=>{try{const body={};for(const key of ['customerServiceFee','shopCommissionPercent','riderBaseAmount','riderPerKm','badWeatherBonus'])body[key]=Number($(key).value);await FD.api('/api/settings',{method:'PATCH',body:JSON.stringify(body)});FD.notice('settingsMsg','Οι ρυθμίσεις αποθηκεύτηκαν.');await loadDashboard();}catch(e){FD.notice('settingsMsg',e.message,true);}});
$('logout').addEventListener('click',async()=>{await FD.logout('admin');location.reload();});
$('askAi').addEventListener('click',async()=>{const message=$('question').value.trim();if(!message)return;appendBubble('me',message);$('question').value='';$('askAi').disabled=true;FD.notice('aiMsg','Ο βοηθός επεξεργάζεται την ερώτηση…');try{const r=await FD.api('/api/assistant',{method:'POST',body:JSON.stringify({message,history:chatHistory})});appendBubble('assistant',r.answer);chatHistory.push({role:'user',content:message},{role:'assistant',content:r.answer});chatHistory=chatHistory.slice(-8);FD.notice('aiMsg','');}catch(e){FD.notice('aiMsg',e.message,true);}finally{$('askAi').disabled=false;}});
function appendBubble(role,text){const node=document.createElement('div');node.className='bubble'+(role==='me'?' me':'');node.textContent=text;$('chatLog').appendChild(node);$('chatLog').scrollTop=$('chatLog').scrollHeight;}
boot().catch(e=>{$('mode').textContent='Σφάλμα σύνδεσης: '+e.message;});
