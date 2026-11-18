'use strict';
(() => {
  const $=id=>document.getElementById(id);
  let account=null,busy=false;
  const labels={cash:'Μετρητά',card:'Κάρτα',iris:'IRIS'};
  function message(msg,error=false){FD.notice('accountMessage',msg,error);}
  function display(){
    $('accountGuest').classList.toggle('hidden',Boolean(account));
    $('accountSignedIn').classList.toggle('hidden',!account);
    $('accountName').textContent=account?.alias||'—';
    $('checkoutAccountText').textContent=account?'Συνδεδεμένος: '+account.alias:'Συνδέσου ή δημιούργησε δοκιμαστικό λογαριασμό.';
    if(!account)$('accountOrders').textContent='';
  }
  async function refreshOrders(){
    if(!account)return;
    const {orders}=await FD.api('/api/customer/orders');
    if(!account)return;
    const root=$('accountOrders'); root.replaceChildren();
    if(!orders.length){root.textContent='Δεν υπάρχουν ακόμα παραγγελίες.';return;}
    for(const order of orders){
      const row=document.createElement('div');row.className='product';
      const info=document.createElement('div');const title=document.createElement('b');title.textContent='Παραγγελία '+order.id.slice(0,8);
      const desc=document.createElement('p');desc.className='hint';desc.textContent=FD.money(order.total)+' · '+FD.status(order.status)+' · '+(labels[order.paymentMethod]||'—')+' (δοκιμή)';
      const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='Πορεία';button.onclick=()=>showTracking(order.id);
      info.append(title,desc);row.append(info,button);root.append(row);
    }
  }
  async function load(){const data=await FD.api('/api/customer/account');account=data.account;display();if(account)await refreshOrders();}
  async function auth(action){
    if(busy)return;busy=true;message('');
    try{const data=await FD.api('/api/customer/'+action,{method:'POST',body:JSON.stringify({alias:$('accountAlias').value,password:$('accountPassword').value,pilotAcknowledged:$('accountPilotAck').checked})});account=data.account;$('accountPassword').value='';display();message('Συνδέθηκες στον δοκιμαστικό λογαριασμό.');await refreshOrders();}
    catch(e){message(e.message,true);}finally{busy=false;}
  }
  $('accountRegister').onclick=()=>auth('register');$('accountLogin').onclick=()=>auth('login');
  $('accountLogout').onclick=async()=>{try{await FD.api('/api/customer/logout',{method:'POST'});location.href=location.pathname+'#account';location.reload();}catch(e){message(e.message,true);}};
  $('accountDelete').onclick=async()=>{if(!confirm('Να διαγραφεί ο δοκιμαστικός λογαριασμός;'))return;try{await FD.api('/api/customer/account',{method:'DELETE',body:JSON.stringify({password:$('accountDeletePassword').value,confirmDelete:true})});location.href=location.pathname+'#account';location.reload();}catch(e){message(e.message,true);}};
  $('accountRefresh').onclick=()=>refreshOrders().catch(e=>message(e.message,true));
  function paymentHint(){const method=$('paymentMethod').value;$('paymentHint').textContent=method==='card'?'Δοκιμή επιλογής κάρτας. Δεν ανοίγει ακόμη πάροχος και δεν γίνεται χρέωση.':method==='iris'?'Δοκιμή επιλογής IRIS. Δεν γίνεται σύνδεση με τράπεζα ούτε μεταφορά χρημάτων.':'Δοκιμή μετρητών. Δεν εισπράττονται χρήματα.';}
  $('paymentMethod').onchange=paymentHint;paymentHint();
  window.FDAccount={current:()=>account,refreshOrders};
  load().catch(e=>message(e.message,true));
})();
