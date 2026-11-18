'use strict';
function error(message,statusCode=400){throw Object.assign(new Error(message),{statusCode});}
function normalizeIban(value){
 const iban=String(value||'').replace(/\s+/g,'').toUpperCase();
 if(!iban)return '';
 if(!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/.test(iban)||(iban.startsWith('GR')&&iban.length!==27))error('Μη έγκυρο IBAN.');
 let rem=0;for(const ch of iban.slice(4)+iban.slice(0,4)){const digits=/[A-Z]/.test(ch)?String(ch.charCodeAt(0)-55):ch;for(const d of digits)rem=(rem*10+Number(d))%97;}
 if(rem!==1)error('Ο έλεγχος ψηφίων IBAN απέτυχε.');
 return iban;
}
function paymentDetails(body){
 const iban=normalizeIban(body.iban);
 const beneficiary=String(body.beneficiary||'').trim();
 const irisPhone=String(body.irisPhone||'').replace(/[\s()-]/g,'');
 if(beneficiary.length>120||(iban&&beneficiary.length<2))error('Συμπλήρωσε το όνομα δικαιούχου.');
 if(irisPhone&&!/^(?:\+30)?69\d{8}$/.test(irisPhone))error('Μη έγκυρος αριθμός κινητού IRIS.');
 if(irisPhone&&body.irisBusinessConfirmed!==true)error('Επιβεβαίωσε ότι η τράπεζα υποστηρίζει επαγγελματική είσπραξη IRIS για αυτή τη συναλλαγή.');
 if(irisPhone&&beneficiary.length<2)error('Συμπλήρωσε το όνομα δικαιούχου.');
 return {iban,beneficiary,irisPhone,updatedAt:new Date().toISOString()};
}
function shopHold(body,previous,billing){
 if(typeof body.suspended!=='boolean')error('Μη έγκυρη κατάσταση.');
 if(body.suspended){
  const reason=String(body.reason||'').trim();
  if(reason.length<10||reason.length>600)error('Καταχώρισε συγκεκριμένη αιτιολογία 10–600 χαρακτήρων.');
  if(body.noticeConfirmed!==true)error('Επιβεβαίωσε την προηγούμενη ή ταυτόχρονη γραπτή ενημέρωση του καταστήματος.');
  if(!billing.outstandingCents)error('Δεν υπάρχει ανεξόφλητη οφειλή.',409);
  return {suspended:true,reason,changedAt:new Date().toISOString(),outstandingAtSuspensionCents:billing.outstandingCents};
 }
 if(previous?.suspended&&billing.outstandingCents&&body.correctionConfirmed!==true)error('Υπάρχει ανεξόφλητο υπόλοιπο. Εξόφλησε ή επιβεβαίωσε αιτιολογημένη διόρθωση.',409);
 const reason=String(body.reason||'').trim();
 if(previous?.suspended&&billing.outstandingCents&&(reason.length<10||reason.length>600))error('Απαιτείται αιτιολογία διόρθωσης.');
 return {suspended:false,reason:reason.slice(0,600),changedAt:new Date().toISOString()};
}
// Bootstrap from private runtime configuration only. Existing saved settings take precedence.
function initialPayout(saved,env=process.env){
 if(saved && typeof saved==='object')return saved;
 if(!env.FD_PAYOUT_IBAN)return null;
 const confirmed=env.FD_PAYOUT_IRIS_CONFIRMED==='true';
 const payout=paymentDetails({iban:env.FD_PAYOUT_IBAN,beneficiary:env.FD_PAYOUT_BENEFICIARY,irisPhone:confirmed?env.FD_PAYOUT_PENDING_IRIS:'',irisBusinessConfirmed:confirmed});
 const pending=String(env.FD_PAYOUT_PENDING_IRIS||'').replace(/[\s()-]/g,'');
 if(pending && !/^(?:\+30)?69\d{8}$/.test(pending))error('Μη έγκυρη μορφή εκκρεμούς IRIS.');
 if(env===process.env)console.info('[FairDelivery] Private payout configuration initialized; IRIS '+(confirmed&&pending?'confirmed by operator':'not enabled')+'.');
 return {...payout,pendingIrisPhone:confirmed?'':pending};
}
// Never expose unverified IRIS even to authenticated shops.
function visiblePayout(payout,role){
 if(!payout)return null;
 const {iban='',beneficiary='',irisPhone='',updatedAt=null,pendingIrisPhone=''}=payout;
 return {iban,beneficiary,irisPhone,updatedAt,...(role==='admin'?{pendingIrisPhone}:{})};
}
module.exports={normalizeIban,paymentDetails,shopHold,initialPayout,visiblePayout};