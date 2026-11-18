'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const push=require('../admin-push');
function vapid(){const k=crypto.createECDH('prime256v1');k.generateKeys();return {FD_VAPID_PRIVATE_KEY:k.getPrivateKey().toString('base64url'),FD_VAPID_SUBJECT:'mailto:synthetic-admin@example.test',public:k.getPublicKey()};}
function sub(){const k=crypto.createECDH('prime256v1');k.generateKeys();const auth=crypto.randomBytes(16);return {keys:{p256dh:k.getPublicKey().toString('base64url'),auth:auth.toString('base64url')},endpoint:'https://webpush.push.apple.com/synthetic-dev-token',key:k,auth};}
test('web push validates allowed hosts and public keys, deduplicates device registrations',()=>{
 const device=sub();
 assert.equal(push.validateSubscription(device).keys.auth,device.keys.auth);
 assert.equal(push.isEndpoint('http://localhost:8888/'),false);
 assert.equal(push.isEndpoint('https://127.0.0.1/test'),false);
 assert.equal(push.isEndpoint('https://webpush.push.apple.com.evil.example/'),false);
 assert.equal(push.isEndpoint('https://fcm.googleapis.com:4444/test'),false);
 assert.equal(push.isEndpoint(device.endpoint),true);
 assert.throws(()=>push.validateSubscription({...device,keys:{p256dh:'invalid',auth:'invalid'}}));
 const saved=push.add([],device);assert.equal(saved.length,1);
 assert.equal(push.add(saved,device).length,1);
 assert.equal(push.remove(saved,device.endpoint).length,0);
 assert.equal(push.prune([{endpoint:'https://evil.test/',keys:device.keys}]).length,0);
});
test('VAPID JWT is signed and aes128gcm payload decrypts using user-agent private key',async()=>{
 const keys=vapid(),env={FD_VAPID_PRIVATE_KEY:keys.FD_VAPID_PRIVATE_KEY,FD_VAPID_SUBJECT:keys.FD_VAPID_SUBJECT};
 const device=sub(),body={type:'new-application',id:'synthetic-1',url:'/app/admin/#applications'};
 const ciphertext=push.encryptedMessage(device,body);
 const salt=ciphertext.subarray(0,16),length=ciphertext.readUInt32BE(16),publicLength=ciphertext[20],sender=ciphertext.subarray(21,21+publicLength);
 assert.equal(length,4096);assert.equal(publicLength,65);
 const auth=Buffer.from(device.keys.auth,'base64url');
 const keyInfo=Buffer.concat([Buffer.from('WebPush: info\0'),device.key.getPublicKey(),sender]);
 const ikm=Buffer.from(crypto.hkdfSync('sha256',device.key.computeSecret(sender),auth,keyInfo,32));
 const cek=Buffer.from(crypto.hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16));
 const nonce=Buffer.from(crypto.hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
 const encoded=ciphertext.subarray(21+publicLength),encrypted=encoded.subarray(0,-16),tag=encoded.subarray(-16);
 const decipher=crypto.createDecipheriv('aes-128-gcm',cek,nonce);decipher.setAuthTag(tag);
 const plaintext=Buffer.concat([decipher.update(encrypted),decipher.final()]);
 assert.equal(plaintext[plaintext.length-1],2);assert.deepEqual(JSON.parse(plaintext.subarray(0,-1).toString()),body);
 const header=push.signVapid(device.endpoint,env);
 assert.match(header,/^vapid t=/);
 const jwt=header.match(/^vapid t=([^,]+), k=([^\s]+)$/);assert.ok(jwt);assert.equal(jwt[2],keys.public.toString('base64url'));
 const [h,p,sig]=jwt[1].split('.');
 const key=crypto.createPublicKey({key:{kty:'EC',crv:'P-256',x:keys.public.subarray(1,33).toString('base64url'),y:keys.public.subarray(33,65).toString('base64url')},format:'jwk'});
 assert.equal(crypto.verify('sha256',Buffer.from(h+'.'+p),{key,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url')),true);
 assert.equal(JSON.parse(Buffer.from(p,'base64url').toString()).aud,'https://webpush.push.apple.com');
 let contacted=false;
 const result=await push.send(device,body,{env,fetcher:async(url,opts)=>{contacted=true;assert.equal(url,device.endpoint);assert.equal(opts.headers['Content-Encoding'],'aes128gcm');assert.ok(Buffer.isBuffer(opts.body));return {ok:true,status:201};}});
 assert.equal(contacted,true);assert.equal(result.ok,true);
});
test('interest arrives in private admin applications and unread counter, not via email', {timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fd-interest-alerts-')),port=47000+Math.floor(Math.random()*1300),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,DATABASE_URL:'',RENDER:'',NODE_ENV:'test',DEMO_MODE:'true',FD_VAPID_PRIVATE_KEY:'',FD_VAPID_SUBJECT:'',PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir},stdio:'ignore'});
 async function call(uri,method='GET',body,role='',cookie=''){
  const res=await fetch(base+uri,{method,headers:{...(role?{'X-FD-Role':role}:{}),...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:res.status,data:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]||''};
 }
 try{
  for(let i=0;i<65;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const admin=await call('/api/auth/login','POST',{role:'admin',code:'demo'},'');
  assert.equal(admin.status,200);
  const publicInfo=await call('/api/courier-interest/config');assert.equal(publicInfo.data.open,true);
  const initial=await call('/api/admin/courier-applications/summary','GET',undefined,'admin',admin.cookie);
  assert.equal(initial.data.newCount,0);
  assert.equal((await call('/api/admin/courier-applications/summary')).status,401);
  const message={email:'synthetic-interest@example.test',region:'Πειραιάς',consent:true,noticeVersion:publicInfo.data.version};
  const submit=await call('/api/courier-interest','POST',message);
  assert.equal(submit.status,202);
  const second=await call('/api/courier-interest','POST',message);
  assert.equal(second.status,202);
  const summary=await call('/api/admin/courier-applications/summary','GET',undefined,'admin',admin.cookie);
  assert.equal(summary.data.newCount,1);assert.equal(summary.data.total,1);
  assert.equal(JSON.stringify(summary.data).includes('synthetic-interest'),false);
  const details=await call('/api/admin/courier-applications','GET',undefined,'admin',admin.cookie);
  assert.equal(details.data.applications[0].email,message.email);
  const id=details.data.applications[0].id;
  await call('/api/admin/courier-applications/'+id,'PATCH',{status:'contacted'},'admin',admin.cookie);
  const after=await call('/api/admin/courier-applications/summary','GET',undefined,'admin',admin.cookie);
  assert.equal(after.data.newCount,0);
  const html=fs.readFileSync(path.join(__dirname,'../public/courier-apply.html'),'utf8');
  assert.equal(html.includes('mailto:dexter18453@gmail.com'),false);
  assert.match(html,/id="interestForm" hidden/);
 }finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,170));fs.rmSync(dir,{recursive:true,force:true});}
});
