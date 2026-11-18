'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {newRecovery,recoveryHash}=require('../account-recovery');const {encryptBackup,decryptBackup}=require('../encrypted-backup');
const phrase='synthetic backup phrase for tests only';
test('recovery entropy and encrypted envelope integrity',async()=>{
 const r=newRecovery();assert.equal(r.code.length,43);assert.equal(recoveryHash(r.code),r.hash);assert.equal(recoveryHash('invalid'),null);assert.notEqual(newRecovery().code,r.code);
 const mock={orders:[{id:'synthetic-order'}],shopPayout:{iban:'synthetic private value'}};
 const envelope=await encryptBackup(mock,phrase);
 assert.ok(!JSON.stringify(envelope).includes('synthetic private value'));
 assert.deepEqual(await decryptBackup(envelope,phrase),mock);
 await assert.rejects(decryptBackup(envelope,'different synthetic phrase only'));
 const changed=Buffer.from(envelope.ciphertext,'base64');changed[0]^=1;
 await assert.rejects(decryptBackup({...envelope,ciphertext:changed.toString('base64')},phrase));
});
test('recovery is one-time, password rotation revokes sessions, backups require admin reauth', {timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fd-recovery-'));
 const port=36000+Math.floor(Math.random()*2000),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,RENDER:'',DATABASE_URL:'',NODE_ENV:'test',DEMO_MODE:'true',PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir},stdio:'ignore'});
 async function call(url,role='',cookie='',method='GET',body,expected=200){
 const r=await fetch(base+url,{method,headers:{'X-FD-Role':role,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await r.json();assert.equal(r.status,expected,method+' '+url+' '+JSON.stringify(data));return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]||''};
 }
 try{
 for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 const alias='demo-recoverytest',password='synthetic-old-password',newPassword='synthetic-new-password',third='synthetic-third-password';
 const c=(await call('/api/customer/register','','','POST',{alias,password,pilotAcknowledged:true})).cookie;
 await call('/api/customer/recovery-code','customer',c,'POST',{password:'incorrect-password'},401);
 const rec=(await call('/api/customer/recovery-code','customer',c,'POST',{password})).data.recoveryCode;
 const rec2=(await call('/api/customer/recovery-code','customer',c,'POST',{password})).data.recoveryCode;
 assert.notEqual(rec,rec2);
 await call('/api/customer/recover','','','POST',{alias,recoveryCode:rec,newPassword},401);
 await call('/api/customer/recover','','','POST',{alias,recoveryCode:rec2,newPassword});
 await call('/api/customer/recover','','','POST',{alias,recoveryCode:rec2,newPassword:third},401);
 await call('/api/customer/orders','customer',c,'GET',undefined,401);
 await call('/api/customer/login','','','POST',{alias,password},401);
 const second=(await call('/api/customer/login','','','POST',{alias,password:newPassword})).cookie;
 await call('/api/customer/change-password','customer',second,'POST',{password:newPassword,newPassword:third});
 await call('/api/customer/orders','customer',second,'GET',undefined,401);
 const admin=(await call('/api/auth/login','','','POST',{role:'admin',code:'demo'})).cookie;
 const backup={adminCode:'demo',passphrase:phrase,confirm:true};
 await call('/api/admin/backup','customer',second,'POST',backup,401);
 await call('/api/admin/backup','admin',admin,'POST',{...backup,adminCode:'wrong'},403);
 const file=(await call('/api/admin/backup','admin',admin,'POST',backup)).data;
 const snapshot=await decryptBackup(file,phrase);
 const account=Object.values(snapshot.customers).find(a=>a.alias===alias);
 assert.ok(account);assert.equal(account.recoveryHash,undefined);assert.notEqual(account.passwordHash,third);assert.ok(!JSON.stringify(snapshot).includes(phrase));
 }finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,150));fs.rmSync(dir,{recursive:true,force:true});}
});
