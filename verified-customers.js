'use strict';
const crypto=require('node:crypto');
const TTL=20*60_000,COOLDOWN=3*60_000;
function fail(message,statusCode=400){throw Object.assign(Error(message),{statusCode});}
function email(value){
 const v=typeof value==='string'?value.trim().toLowerCase():'';
 if(v.length>120||!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(v))fail('Συμπλήρωσε έγκυρο email.');
 return v;
}
function password(value){
 if(typeof value!=='string'||value.length<12||value.length>128||Buffer.byteLength(value)>256)fail('Χρειάζεται κωδικός 12–128 χαρακτήρων.');
 return value;
}
function hash(value){return crypto.createHash('sha256').update(value).digest('hex');}
function emailKey(value){return hash('fd-email-v1:'+email(value));}
function config(env=process.env,durable=false){
 const controller=String(env.FD_CUSTOMER_EMAIL_CONTROLLER||'').trim();
 const contact=String(env.FD_CUSTOMER_EMAIL_CONTACT||'').trim();
 const notice=String(env.FD_CUSTOMER_EMAIL_NOTICE||'').trim();
 let senderValid=false;try{email(env.BREVO_SENDER);email(contact);senderValid=true;}catch{}
 const open=durable&&env.FD_CUSTOMER_EMAIL_OPEN==='true'&&env.FD_CUSTOMER_STORAGE_APPROVED==='true'&&env.FD_BREVO_FREE_CONFIRMED==='true'&&Boolean(env.BREVO_API_KEY)&&senderValid&&controller.length>=3&&notice.length>=200;
 return {open,controller:open?controller:'',contact:open?contact:'',notice:open?notice:'',version:open?hash(JSON.stringify({controller,contact,notice})):null};
}
function challenge(address,purpose,noticeVersion,now=Date.now()){
 const token=crypto.randomBytes(32).toString('base64url');
 return {token,record:{emailKey:emailKey(address),purpose,noticeVersion:noticeVersion||null,tokenHash:hash('fd-email-token-v1:'+token),createdAt:now,expiresAt:now+TTL}};
}
function prune(items,now=Date.now()){return (Array.isArray(items)?items:[]).filter(x=>Number.isFinite(x.expiresAt)&&x.expiresAt>now);}
function matches(record,address,purpose,token,now=Date.now()){
 if(!record||record.expiresAt<=now||record.emailKey!==emailKey(address)||record.purpose!==purpose||typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||typeof record.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(record.tokenHash))return false;
 return crypto.timingSafeEqual(Buffer.from(record.tokenHash,'hex'),Buffer.from(hash('fd-email-token-v1:'+token),'hex'));
}
async function deliver(address,purpose,token,{env=process.env,fetcher=fetch}={}){
 if(env.FD_BREVO_FREE_CONFIRMED!=='true'||!env.BREVO_API_KEY)fail('Δεν έχει ρυθμιστεί δωρεάν αποστολή email.',503);
 const recipient=email(address),sender=email(env.BREVO_SENDER);
 const subject=purpose==='signup'?'Fair Delivery — επιβεβαίωση email':'Fair Delivery — ανάκτηση κωδικού';
 const response=await fetcher('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':env.BREVO_API_KEY,'Content-Type':'application/json',accept:'application/json'},signal:AbortSignal.timeout(12000),body:JSON.stringify({sender:{name:'Fair Delivery',email:sender},to:[{email:recipient}],subject,textContent:'Ο κωδικός σου: '+token+'\nΙσχύει για 20 λεπτά και μόνο μία φορά. Αν δεν το ζήτησες, αγνόησε το μήνυμα.'})});
 if(!response.ok)fail('Η υπηρεσία αποστολής δεν είναι διαθέσιμη.',503);
}
module.exports={TTL,COOLDOWN,email,password,emailKey,config,challenge,prune,matches,deliver};
