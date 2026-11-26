'use strict';
(()=>{
 const el=id=>document.getElementById(id);
 const cats={missing_item:'Λείπει προϊόν',wrong_item:'Λάθος προϊόν',late:'Καθυστέρηση',cancellation:'Ακύρωση',fee_question:'Ερώτηση χρέωσης',other:'Άλλο'};
 const decisions={reviewed:'Εξετάστηκε',refund_review:'Προς εξέταση επιστροφής (χωρίς πληρωμή)',not_upheld:'Δεν εγκρίθηκε'};
 const note=message=>{el('supportMsg').textContent=message;};
 const container=el('supportList');
 if(!container)return;
 function render(items,admin=false){
  container.replaceChildren();
  if(!items.length){container.textContent='Δεν υπάρχουν αιτήματα.';return;}
  for(const t of items){
   const row=document.createElement('div');row.className='order';
   const p=document.createElement('p');p.textContent=(admin?t.orderId.slice(0,8)+' · '+t.storeId+' · ':'')+(cats[t.category]||'Αίτημα')+' · '+(t.status==='open'?'Εκκρεμεί':decisions[t.decision]||'Εξετάστηκε')+' · '+new Date(t.createdAt).toLocaleString('el-GR');row.appendChild(p);
   if(admin&&t.status==='open'){
    const select=document.createElement('select');select.setAttribute('aria-label','Απόφαση διαχειριστή');
    for(const [key,label] of Object.entries(decisions)){const option=document.createElement('option');option.value=key;option.textContent=label;select.appendChild(option);}
    const button=document.createElement('button');button.type='button';button.textContent='Καταχώριση απόφασης';
    button.onclick=async()=>{button.disabled=true;try{await FD.api('/api/admin/order-support/'+encodeURIComponent(t.orderId)+'/'+encodeURIComponent(t.id),{method:'PATCH',body:JSON.stringify({decision:select.value})});await adminLoad();}catch(e){note(e.message);}finally{button.disabled=false;}};
    row.append(select,button);
   }container.appendChild(row);
  }
 }
 async function adminLoad(){try{const data=await FD.api('/api/admin/order-support');render(data.tickets,true);note('Εμφανίζονται '+data.tickets.length+' από '+data.total+' αιτήματα.');}catch(e){note(e.message);}}
 async function customerAction(send){
  const id=el('orderId').textContent.trim();
  if(!id){note('Επίλεξε παραγγελία.');return;}
  const path='/api/customer/orders/'+encodeURIComponent(id)+'/support';
  const button=el(send?'supportSend':'supportRefresh');button.disabled=true;
  try{
   if(send)await FD.api(path,{method:'POST',body:JSON.stringify({category:el('supportCategory').value})});
   const data=await FD.api(path);
   if(el('orderId').textContent.trim()!==id){container.replaceChildren();return;}
   render(data.tickets);note(send?'Το αίτημα καταχωρίστηκε για ανθρώπινη εξέταση.':'');
  }catch(e){container.replaceChildren();note(e.status===401?'Συνδέσου στον δοκιμαστικό λογαριασμό σου.':e.message);}finally{button.disabled=false;}
 }
 if(el('adminSupportRefresh'))el('adminSupportRefresh').onclick=adminLoad;
 if(el('supportSend')){
  el('supportSend').onclick=()=>customerAction(true);el('supportRefresh').onclick=()=>customerAction(false);
  new MutationObserver(()=>{container.replaceChildren();note('');}).observe(el('orderId'),{childList:true,characterData:true,subtree:true});
 }
})();
