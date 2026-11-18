'use strict';
const crypto=require('crypto');
function config(env=process.env,demo=false){
 const controller=demo?'Fair Delivery synthetic test':String(env.COURIER_INTEREST_CONTROLLER||'').trim();
 const contact=demo?'privacy@example.test':String(env.COURIER_INTEREST_CONTACT||'').trim();
 const notice=demo?'Synthetic test only. No real applicants.':String(env.COURIER_INTEREST_NOTICE||'').trim();
 const open=demo||(env.COURIER_INTEREST_OPEN==='true'&&controller.length>=3&&validEmail(contact)&&notice.length>=200);
 const version=open?crypto.createHash('sha256').update(JSON.stringify({controller,contact,notice})).digest('hex'):null;
 return {open,controller:open?controller:'',contact:open?contact:'',notice:open?notice:'',version,retentionDays:90};
}
function validEmail(email){return typeof email==='string'&&email.length<=120&&/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);}
function validateInterest(body,config){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('Μη έγκυρη δήλωση.');
 if(!config.open||body.noticeVersion!==config.version||body.consent!==true)throw Error('Διάβασε την ενημέρωση και επίλεξε συγκατάθεση.');
 const email=typeof body.email==='string'?body.email.trim().toLowerCase():'';
 if(!validEmail(email))throw Error('Συμπλήρωσε έγκυρο email.');
 const region=typeof body.region==='string'?body.region.trim():'';
 if(region.length>80)throw Error('Η περιοχή επιτρέπεται έως 80 χαρακτήρες.');
 if(Object.keys(body).some(k=>!['email','region','noticeVersion','consent'].includes(k)))throw Error('Μη επιτρεπόμενο πεδίο.');
 return {kind:'interest',email,region,consentVersion:config.version,consentedAt:new Date().toISOString()};
}
function screening(app,evaluate){return app.kind==='interest'?{status:'interest',issues:[],requiresHumanVerification:true,notice:'Εκδήλωση ενδιαφέροντος μόνο. Δεν έχει γίνει αξιολόγηση ή ενεργοποίηση.'}:evaluate(app);}
module.exports={config,validateInterest,screening};
