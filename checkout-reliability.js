'use strict';
const crypto=require('node:crypto');
function fail(message,statusCode=400){throw Object.assign(new Error(message),{statusCode});}
function requestKey(body,account){
 if(body.requestId===undefined)return null; // Legacy pilot clients only.
 if(!account)fail('Συνδέσου στον δοκιμαστικό λογαριασμό σου.',401);
 if(typeof body.requestId!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(body.requestId))fail('Μη έγκυρο αναγνωριστικό υποβολής.');
 return body.requestId.toLowerCase();
}
function digest(body,storeId){
 const data={storeId,items:body.items,customerName:body.customerName,customerPhone:body.customerPhone,deliveryAddress:body.deliveryAddress,deliveryLocation:body.deliveryLocation,paymentMethod:body.paymentMethod||'cash',privacyConsent:body.privacyConsent,confirmPaymentSimulation:body.confirmPaymentSimulation,quote:body.quote};
 return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
function verifyQuote(body,lines,deliveryFee){
 if(!body.quote||!Array.isArray(body.quote.items)||body.quote.items.length!==lines.length||!Number.isSafeInteger(body.quote.deliveryCents))fail('Ανανέωσε το καλάθι και επιβεβαίωσε τις τιμές.',409);
 const expected=new Map();
 for(const row of body.quote.items){
  if(!row||typeof row.productId!=='string'||!Number.isSafeInteger(row.unitCents)||expected.has(row.productId))fail('Μη έγκυρη επιβεβαίωση τιμών.');
  expected.set(row.productId,row.unitCents);
 }
 if(Math.round(deliveryFee*100)!==body.quote.deliveryCents||lines.some(row=>expected.get(row.productId)!==Math.round(row.unitPrice*100)))fail('Οι τιμές ή τα έξοδα διανομής άλλαξαν. Ανανέωσε το καλάθι και επιβεβαίωσε το νέο σύνολο.',409);
}
function checkUniqueItems(lines){if(new Set(lines.map(l=>l.productId)).size!==lines.length)fail('Το ίδιο προϊόν εμφανίζεται περισσότερες από μία φορές.');}
module.exports={requestKey,digest,verifyQuote,checkUniqueItems};
