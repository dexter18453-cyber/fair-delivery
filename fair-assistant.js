'use strict';
const {athensDay,settlementSummary}=require('./shop-billing');
const {allStores}=require('./stores');
const MODEL='openai/gpt-oss-120b';
const INSTRUCTIONS=[
 'Είσαι ο AI βοηθός Fair Delivery. Απαντάς καθαρά στα ελληνικά με συγκεκριμένα, εφαρμόσιμα βήματα.',
 'Το Fair Delivery είναι πιλοτική ελληνική πλατφόρμα παραγγελιών πολλών καταστημάτων. Το κατάστημα εισπράττει απευθείας από τον πελάτη και αναλαμβάνει τη διανομή. Ο πελάτης δεν πληρώνει service fee. Η σταθερή προβλεπόμενη χρέωση του καταστήματος είναι 1 ευρώ ανά ολοκληρωμένη παραγγελία, χωρίς ποσοστιαία προμήθεια. Ακυρώσεις δεν χρεώνονται. Η εκκαθάριση καταχωρίζεται χειροκίνητα. Πραγματικές πληρωμές δεν εκτελούνται από την πλατφόρμα.',
 'Αρχικός στόχος: Νίκαια, Κερατσίνι και Πειραιάς, καταστήματα εστίασης με δικό τους νόμιμο δίκτυο διανομής. Προτείνε σταδιακό πιλοτικό onboarding. Το 1€ είναι έσοδο της πλατφόρμας πριν φόρους/έξοδα και κόστος του καταστήματος. Για 30 ολοκληρωμένες παραγγελίες η προβλεπόμενη χρέωση είναι 30€· το κέρδος του καταστήματος δεν προκύπτει από αυτό. Μην παρουσιάζεις υποθετικές εκπτώσεις, δωρεάν εμπορικές περιόδους, referral, dedicated account manager, τηλεφωνική υποστήριξη ή εγγυήσεις ως διαθέσιμες λειτουργίες. Μπορείς να συζητήσεις νέες ιδέες μόνο ως προτάσεις που απαιτούν έγκριση του ιδιοκτήτη, αν σε ρωτήσει. Δεν έχουν ενεργοποιηθεί πραγματικές παραγγελίες ή ελεύθερη εγγραφή πελατών. Μη συστήνεις μαζικά ανεπιθύμητα μηνύματα.',
 'Απάντησε κατά προτίμηση σε 150–300 λέξεις, με 3–5 πρακτικά βήματα, σύντομες επικεφαλίδες και απλές λίστες. Απόφυγε μεγάλους πίνακες, επαναλήψεις και περιττά εισαγωγικά. Αν ζητηθεί αναλυτική απάντηση, έως 500 λέξεις. Ολοκλήρωσε την απάντηση μέσα στο διαθέσιμο όριο. Ξεχώρισε σαφώς όσα υπάρχουν σήμερα από μελλοντικές προτάσεις.',
 'Οι ανεξάρτητοι διανομείς δεν ενεργοποιούνται αυτόματα. Η εκδήλωση ενδιαφέροντος είναι ξεχωριστή από έγκριση και σύμβαση.',
 'Βοηθάς με στρατηγική, προσέγγιση καταστημάτων, σχεδιασμό λειτουργιών, τεχνικές ερωτήσεις και υποθετικούς υπολογισμούς. Δεν έχεις πρόσβαση σε πραγματικά στοιχεία, λογαριασμούς, διαπιστευτήρια, βάση δεδομένων ή εργαλεία. Δεν ισχυρίζεσαι ότι εκτέλεσες ενέργειες, πραγματοποίησες αναζήτηση ή έλεγξες ζωντανά δεδομένα.',
 'Για ακριβή ζωντανά ποσά παρέπεμψε στα τοπικά κουμπιά αναφορών του Admin. Ξεχώριζε τις υποθέσεις από τα γεγονότα και μη δίνεις εγγυήσεις εσόδων. Για νομικά/φορολογικά θέματα απαιτείται έλεγχος ειδικού. Μη ζητάς προσωπικά δεδομένα ή μυστικά.'
].join('\n');
function configured(env=process.env){return Boolean(env.GROQ_API_KEY&&env.FD_GROQ_FREE_CONFIRMED==='true');}
function localReport(state,kind,now=new Date()){
 const date=athensDay(now);
 const orders=state.orders||[];
 const today=orders.filter(o=>athensDay(o.createdAt)===date);
 const stores=allStores(state);
 const bills=stores.map(s=>({store:s,bill:settlementSummary(orders,state.shopSettlements||[],s.id,date)}));
 const outstanding=bills.reduce((n,x)=>n+x.bill.outstandingCents,0);
 const todayFee=bills.reduce((n,x)=>n+(x.bill.days.find(d=>d.day===date)?.feeCents||0),0);
 const money=c=>(c/100).toLocaleString('el-GR',{style:'currency',currency:'EUR'});
 const head='Πραγματικές μετρήσεις πιλοτικού μητρώου — όχι πραγματικές εισπράξεις ('+date+').\n';
 if(kind==='billing')return head+'Συνολικές ανεξόφλητες δοκιμαστικές χρεώσεις: '+money(outstanding)+'\nΧρεώσεις ολοκληρωμένων σήμερα: '+money(todayFee)+'\n'+bills.map(({store,bill})=>store.name+': '+money(bill.outstandingCents)+(state.shopHolds[store.id]?.suspended?' — σε αναστολή':'')).join('\n');
 if(kind==='stores')return head+'Καταστήματα: '+stores.length+' · Ορατά στο πιλοτικό μενού: '+stores.filter(s=>s.active).length+'\n'+bills.map(({store})=>store.name+': '+(!store.active?'προετοιμασία':state.shopHolds[store.id]?.suspended?'αναστολή':'ενεργό πιλοτικό μενού')).join('\n');
 if(kind==='recruitment')return head+'Δηλώσεις ενδιαφέροντος στο μητρώο: '+(state.courierApplications||[]).filter(a=>a.kind==='interest').length+'\nΑναλυτικές αιτήσεις: '+(state.courierApplications||[]).filter(a=>a.kind!=='interest').length+'\nΤα μηνύματα που έρχονται απευθείας στο email δεν μετρώνται εδώ. Κανένας υποψήφιος δεν ενεργοποιείται αυτόματα.';
 if(kind==='today')return head+'Νέες παραγγελίες σήμερα: '+today.length+'\nΕνεργές συνολικά: '+orders.filter(o=>!['delivered','cancelled'].includes(o.status)).length+'\nΟλοκληρωμένες σήμερα: '+orders.filter(o=>o.status==='delivered'&&athensDay(o.completedAt||o.updatedAt||o.createdAt)===date).length+'\nΑκυρωμένες από τις σημερινές: '+today.filter(o=>o.status==='cancelled').length+'\nΧρεώσεις καταστημάτων σήμερα: '+money(todayFee)+'\nΑνεξόφλητο συνολικά: '+money(outstanding);
 return null;
}
function unsafeText(message){
 return /@|\b[A-Z]{2}\d{2}[A-Z0-9\s]{11,35}\b|(?:\d[\s().+-]*){9,}|\b(?:gsk_|sk-|AIza|AQ\.)[A-Za-z0-9_-]{8,}|(?:api\s*key|password|κωδικός πρόσβασης)\s*[:=]/i.test(message);
}
async function askGroq(message,{env=process.env,fetcher=fetch}={}){
 if(!configured(env))return {status:'not_configured'};
 if(unsafeText(message))return {status:'private'};
 const res=await fetcher('https://api.groq.com/openai/v1/chat/completions',{
  method:'POST',headers:{Authorization:'Bearer '+env.GROQ_API_KEY,'Content-Type':'application/json'},
  signal:AbortSignal.timeout(20000),body:JSON.stringify({model:MODEL,messages:[{role:'system',content:INSTRUCTIONS},{role:'user',content:message}],max_completion_tokens:3200,reasoning_effort:'low',temperature:0.4})
 });
 if(!res.ok)return {status:res.status===429?'quota':'unavailable'};
 const data=await res.json();const choice=data.choices?.[0];const answer=choice?.message?.content;
 return typeof answer==='string'&&answer.trim()?{status:'ok',answer:answer.trim(),truncated:choice.finish_reason==='length'}:{status:'unavailable'};
}
module.exports={MODEL,configured,localReport,unsafeText,askGroq};
