'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {spawn}=require('node:child_process');
const adminAuth=require('../admin-auth');
test('admin email identity, session digest and nontrivial password constraints',()=>{
 assert.equal(adminAuth.emailMatches(' ADMIN@example.test ','admin@example.test'),true);
 assert.equal(adminAuth.emailMatches('other@example.test','admin@example.test'),false);
 assert.throws(()=>adminAuth.validatePassword('kisa123'),/12/);
 assert.throws(()=>adminAuth.validatePassword('password123456789'),/προβλέψιμος/);
 assert.equal(adminAuth.validatePassword('unique personal phrase 3927'),'unique personal phrase 3927');
 const issued=adminAuth.issue([],1700000000000);
 assert.equal(issued.sessions[0].hash.length,64);
 assert.equal(adminAuth.lookup(issued.sessions,issued.token,1700000000010).role,'admin');
 assert.equal(adminAuth.lookup(issued.sessions,issued.token,1700000000000+adminAuth.SESSION_TTL_MS),null);
 assert.equal(adminAuth.lookup(adminAuth.revoke(issued.sessions,issued.token),issued.token),null);
 assert.ok(!JSON.stringify(issued.sessions).includes(issued.token));
});
test('admin remembers email login across deploy and revokes sessions on password change/logout', {timeout:40000},async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'fd-admin-login-')),port=42000+Math.floor(Math.random()*1200),base='http://127.0.0.1:'+port;
 const email='synthetic-admin@example.test';let child;
 const env={...process.env,RENDER:'',DATABASE_URL:'',FD_MIGRATION_TARGET_DATABASE_URL:'',NODE_ENV:'test',DEMO_MODE:'',ADMIN_ACCESS_CODE:'demo',FD_ADMIN_LOGIN_EMAIL:email,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:temp,FD_MAINTENANCE_MODE:'false'};
 async function launch(){
  child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env,stdio:'ignore'});
  for(let i=0;i<90;i++){try{const r=await fetch(base+'/api/health');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,110));}
  throw Error('Test server did not start');
 }
 async function stop(){if(!child)return;child.kill('SIGTERM');await new Promise(r=>{const t=setTimeout(r,1200);child.once('exit',()=>{clearTimeout(t);r();});});child=null;}
 async function call(url,{method='GET',body,cookie='',role='admin'}={}){
  const res=await fetch(base+url,{method,headers:{'X-FD-Role':role,...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await res.json();return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0]||''};
 }
 try{
  await launch();
  assert.equal((await call('/api/auth/login',{method:'POST',body:{role:'admin',email:'wrong@example.test',code:'demo'}})).status,401);
  const login=await call('/api/auth/login',{method:'POST',body:{role:'admin',email,code:'demo'}});
  assert.equal(login.status,200);assert.equal(login.data.expiresInSeconds,30*24*60*60);
  assert.equal((await call('/api/auth/me',{cookie:login.cookie})).data.authenticated,true);
  const raw=fs.readFileSync(path.join(temp,'state.json'),'utf8');
  assert.ok(!raw.includes(login.cookie.split('=')[1]));
  assert.ok(raw.includes('adminSessions'));
  await stop();await launch();
  assert.equal((await call('/api/auth/me',{cookie:login.cookie})).data.authenticated,true);
  const changed=await call('/api/admin/change-password',{method:'POST',cookie:login.cookie,body:{currentCode:'demo',newCode:'unique personal phrase 3927'}});
  assert.equal(changed.status,200);
  assert.equal((await call('/api/auth/me',{cookie:login.cookie})).data.authenticated,false);
  assert.equal((await call('/api/auth/login',{method:'POST',body:{role:'admin',email,code:'demo'}})).status,401);
  const login2=await call('/api/auth/login',{method:'POST',body:{role:'admin',email,code:'unique personal phrase 3927'}});
  assert.equal(login2.status,200);
  assert.equal((await call('/api/admin/backup',{method:'POST',cookie:login2.cookie,body:{adminCode:'demo',passphrase:'some synthetic phrase for encrypted backup',confirm:true}})).status,403);
  assert.equal((await call('/api/admin/backup',{method:'POST',cookie:login2.cookie,body:{adminCode:'unique personal phrase 3927',passphrase:'some synthetic phrase for encrypted backup',confirm:true}})).status,200);
  await stop();await launch();
  assert.equal((await call('/api/auth/me',{cookie:login2.cookie})).data.authenticated,true);
  const out=await call('/api/auth/logout',{method:'POST',cookie:login2.cookie,body:{role:'admin'}});assert.equal(out.status,200);
  assert.equal((await call('/api/auth/me',{cookie:login2.cookie})).data.authenticated,false);
  await stop();await launch();
  assert.equal((await call('/api/auth/me',{cookie:login2.cookie})).data.authenticated,false);
 }finally{await stop();fs.rmSync(temp,{recursive:true,force:true});}
});
