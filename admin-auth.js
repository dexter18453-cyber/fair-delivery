'use strict';
const crypto=require('node:crypto');
const SESSION_TTL_MS=30*24*60*60*1000;
const MAX_SESSIONS=10;
function normalizeLoginEmail(value){return typeof value==='string'?value.trim().toLowerCase():'';}
function emailMatches(email,configured){
 const expected=normalizeLoginEmail(configured);
 return !expected||normalizeLoginEmail(email)===expected;
}
function validatePassword(value,email=''){
 if(typeof value!=='string'||value.length<12||value.length>128||Buffer.byteLength(value)>256)throw Object.assign(Error('Ο νέος κωδικός πρέπει να έχει 12–128 χαρακτήρες.'),{statusCode:400});
 const lower=value.toLocaleLowerCase('el-GR');
 if(/^(.)\1{11,}$/.test(value)||/^(?:password|123456|qwerty|kisa123|admin123)/i.test(value)||lower===normalizeLoginEmail(email)||lower.includes('fairdelivery123'))throw Object.assign(Error('Ο κωδικός είναι προβλέψιμος. Χρησιμοποίησε μια μεγαλύτερη, μοναδική φράση.'),{statusCode:400});
 return value;
}
function sessionHash(token){
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
 return crypto.createHash('sha256').update('fd-admin-session-v1:'+token).digest('hex');
}
function prune(sessions,now=Date.now()){
 if(!Array.isArray(sessions))return [];
 return sessions.filter(x=>x&&typeof x.hash==='string'&&/^[a-f0-9]{64}$/.test(x.hash)&&Number.isFinite(x.expiresAt)&&x.expiresAt>now&&x.expiresAt<=now+SESSION_TTL_MS).slice(-MAX_SESSIONS);
}
function issue(sessions,now=Date.now()){
 const token=crypto.randomBytes(32).toString('hex'),entry={hash:sessionHash(token),expiresAt:now+SESSION_TTL_MS,createdAt:now};
 return {token,entry,sessions:[...prune(sessions,now),entry].slice(-MAX_SESSIONS)};
}
function lookup(sessions,token,now=Date.now()){
 const h=sessionHash(token);if(!h)return null;
 const found=prune(sessions,now).find(x=>x.hash===h);
 return found?{role:'admin',userId:'admin-owner',storeId:'default',expiresAt:found.expiresAt,token}:null;
}
function revoke(sessions,token){
 const h=sessionHash(token);
 return prune(sessions).filter(s=>s.hash!==h);
}
module.exports={SESSION_TTL_MS,MAX_SESSIONS,normalizeLoginEmail,emailMatches,validatePassword,sessionHash,prune,issue,lookup,revoke};
