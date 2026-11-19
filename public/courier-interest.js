'use strict';
(()=>{
 const $=id=>document.getElementById(id);
 let config=null;
 const msg=(id,text,error=false)=>{const n=$(id);n.textContent=text;n.className='apply-message'+(error?' error':'');n.hidden=false;};
 async function load(){
  const response=await fetch('/api/courier-interest/config',{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)throw Error('Οι ρυθμίσεις της φόρμας δεν είναι διαθέσιμες.');
  config=await response.json();
  if(!config.open)return;
  $('interestController').textContent='Υπεύθυνος επεξεργασίας: '+config.controller;
  $('interestContact').textContent='Επικοινωνία και άσκηση δικαιωμάτων: '+config.contact;
  $('interestNotice').textContent=config.notice;
  $('interestClosed').hidden=true;$('interestForm').hidden=false;$('interestFields').disabled=false;
  $('privacyRequestForm').hidden=false;$('privacyRequestFields').disabled=false;
  $('privacyRequestClosed').hidden=true;
 }
 load().catch(()=>{/* Μην εμφανίζεις φόρμα εάν δεν έχει δημοσιευθεί η ενημέρωση. */});
 $('interestForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!config?.open||!$('interestForm').reportValidity())return;
  const button=$('interestSend');button.disabled=true;
  try{
   const body={email:$('interestEmail').value,region:$('interestRegion').value,consent:$('interestConsent').checked,noticeVersion:config.version};
   const r=await fetch('/api/courier-interest',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   const data=await r.json();if(!r.ok)throw Error(data.error||'Η καταχώριση απέτυχε.');
   $('interestForm').reset();
   msg('interestResponse',data.message);
  }catch(error){msg('interestResponse',error.message,true);}
  finally{button.disabled=false;}
 });
 $('privacyRequestForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!config?.open||!$('privacyRequestForm').reportValidity())return;
  const button=$('privacyRequestSend');button.disabled=true;
  try{
   const body={email:$('privacyRequestEmail').value,requestType:$('privacyRequestType').value,acknowledged:$('privacyRequestAck').checked,noticeVersion:config.version};
   const r=await fetch('/api/courier-interest/privacy-request',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
   const data=await r.json();if(!r.ok)throw Error(data.error||'Το αίτημα δεν καταχωρίστηκε.');
   $('privacyRequestForm').reset();
   msg('privacyRequestResponse',data.message);
  }catch(error){msg('privacyRequestResponse',error.message,true);}
  finally{button.disabled=false;}
 });
})();
