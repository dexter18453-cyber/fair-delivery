'use strict';
const crypto=require('node:crypto');
const MAX_SUBSCRIPTIONS=5;
const ALLOWED_HOSTS=new Set(['webpush.push.apple.com','fcm.googleapis.com','fcm-xm.googleapis.com','updates.push.services.mozilla.com','push.services.mozilla.com']);
const PREFIX='Fair Delivery';
function decoded(value){try{return Buffer.from(value,'base64url');}catch{return Buffer.alloc(0);}}
function isEndpoint(value){
 if(typeof value!=='string'||value.length>2048)return false;
 try{const u=new URL(value);return u.protocol==='https:'&&ALLOWED_HOSTS.has(u.hostname)&&!u.username&&!u.password&&u.port===''&&u.hash==='';}catch{return false;}
}
function validateSubscription(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!isEndpoint(value.endpoint)||!value.keys||typeof value.keys!=='object')throw Object.assign(Error('Δεν είναι έγκυρη η εγγραφή ειδοποιήσεων.'),{statusCode:400});
 const p=decoded(value.keys.p256dh),a=decoded(value.keys.auth);
 if(p.length!==65||p[0]!==4||a.length!==16)throw Object.assign(Error('Μη έγκυρα κλειδιά ειδοποιήσεων.'),{statusCode:400});
 try{crypto.ECDH.convertKey(p,'prime256v1',undefined,undefined,'uncompressed');}catch{throw Object.assign(Error('Μη έγκυρο κλειδί συσκευής.'),{statusCode:400});}
 return {endpoint:value.endpoint,keys:{p256dh:p.toString('base64url'),auth:a.toString('base64url')}};
}
function config(env=process.env){
 const secret=decoded(env.FD_VAPID_PRIVATE_KEY);let publicKey=null;
 if(secret.length===32&&typeof env.FD_VAPID_SUBJECT==='string'&&/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.FD_VAPID_SUBJECT)){
  try{const e=crypto.createECDH('prime256v1');e.setPrivateKey(secret);publicKey=e.getPublicKey().toString('base64url');}catch{}
 }
 return {available:Boolean(publicKey),publicKey};
}
function prune(subscriptions){
 if(!Array.isArray(subscriptions))return [];
 const unique=new Map();
 for(const item of subscriptions){
  try{const s=validateSubscription(item);unique.set(s.endpoint,{...s,addedAt:item.addedAt||new Date().toISOString()});}catch{}
 }
 return [...unique.values()].slice(-MAX_SUBSCRIPTIONS);
}
function add(subscriptions,subscription,now=new Date().toISOString()){
 const current=prune(subscriptions),clean=validateSubscription(subscription);
 return [...current.filter(s=>s.endpoint!==clean.endpoint),{...clean,addedAt:now}].slice(-MAX_SUBSCRIPTIONS);
}
function remove(subscriptions,endpoint){return prune(subscriptions).filter(s=>s.endpoint!==endpoint);}
function signVapid(endpoint,env=process.env,now=Math.floor(Date.now()/1000)){
 const secret=decoded(env.FD_VAPID_PRIVATE_KEY);
 if(secret.length!==32||!config(env).available)throw Error('Push δεν έχει ρυθμιστεί.');
 const e=crypto.createECDH('prime256v1');e.setPrivateKey(secret);const publicKey=e.getPublicKey();
 const key=crypto.createPrivateKey({key:{kty:'EC',crv:'P-256',d:secret.toString('base64url'),x:publicKey.subarray(1,33).toString('base64url'),y:publicKey.subarray(33,65).toString('base64url')},format:'jwk'});
 const jwtHeader=Buffer.from(JSON.stringify({typ:'JWT',alg:'ES256'})).toString('base64url');
 const jwtBody=Buffer.from(JSON.stringify({aud:new URL(endpoint).origin,exp:now+3600,sub:env.FD_VAPID_SUBJECT})).toString('base64url');
 const text=jwtHeader+'.'+jwtBody;
 const sig=crypto.sign('sha256',Buffer.from(text),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
 return 'vapid t='+text+'.'+sig+', k='+publicKey.toString('base64url');
}
function encryptedMessage(subscription,payload){
 const clean=validateSubscription(subscription);
 const receiver=Buffer.from(clean.keys.p256dh,'base64url'),auth=Buffer.from(clean.keys.auth,'base64url');
 const e=crypto.createECDH('prime256v1');e.generateKeys();
 const sender=e.getPublicKey(),shared=e.computeSecret(receiver);
 const keyInfo=Buffer.concat([Buffer.from('WebPush: info\0'),receiver,sender]);
 const ikm=Buffer.from(crypto.hkdfSync('sha256',shared,auth,keyInfo,32));
 const salt=crypto.randomBytes(16);
 const cek=Buffer.from(crypto.hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16));
 const nonce=Buffer.from(crypto.hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
 const msg=Buffer.from(JSON.stringify(payload));
 if(msg.length>1024)throw Error('Πολύ μεγάλη ειδοποίηση.');
 const cipher=crypto.createCipheriv('aes-128-gcm',cek,nonce);
 const encrypted=Buffer.concat([cipher.update(Buffer.concat([msg,Buffer.from([2])])),cipher.final(),cipher.getAuthTag()]);
 const header=Buffer.alloc(5);header.writeUInt32BE(4096,0);header[4]=65;
 return Buffer.concat([salt,header,sender,encrypted]);
}
async function send(subscription,payload,{env=process.env,fetcher=fetch}={}){
 const clean=validateSubscription(subscription);
 if(!config(env).available)return {ok:false,status:503};
 const response=await fetcher(clean.endpoint,{method:'POST',headers:{TTL:'3600',Urgency:'high','Content-Type':'application/octet-stream','Content-Encoding':'aes128gcm','Authorization':signVapid(clean.endpoint,env)},body:encryptedMessage(clean,payload),signal:AbortSignal.timeout(7500)});
 return {ok:response.ok,status:response.status};
}
module.exports={MAX_SUBSCRIPTIONS,ALLOWED_HOSTS,isEndpoint,validateSubscription,config,prune,add,remove,signVapid,encryptedMessage,send};
