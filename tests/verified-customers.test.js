'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawn}=require('node:child_process');
const v=require('../verified-customers');
test('verified registration stays closed without configuration and durable storage',async()=>{
 const env={FD_CUSTOMER_EMAIL_OPEN:'true',FD_CUSTOMER_STORAGE_APPROVED:'true',FD_BREVO_FREE_CONFIRMED:'true',BREVO_API_KEY:'synthetic-only',BREVO_SENDER:'test@example.test',FD_CUSTOMER_EMAIL_CONTROLLER:'Synthetic business',FD_CUSTOMER_EMAIL_CONTACT:'privacy@example.test',FD_CUSTOMER_EMAIL_NOTICE:'Synthetic notice. '.repeat(20)};
 assert.equal(v.config({},true).open,false);assert.equal(v.config(env,false).open,false);assert.equal(v.config({...env,FD_CUSTOMER_STORAGE_APPROVED:'false'},true).open,false);assert.equal(v.config(env,true).open,true);
 const now=Date.now(),attempt=v.challenge('test@example.test','signup','version',now);
 assert.equal(v.matches(attempt.record,'test@example.test','signup',attempt.token,now),true);
 assert.equal(v.matches(attempt.record,'other@example.test','signup',attempt.token,now),false);
 assert.equal(v.matches(attempt.record,'test@example.test','reset',attempt.token,now),false);
 assert.equal(v.matches(attempt.record,'test@example.test','signup',attempt.token,now+v.TTL),false);
 assert.ok(!JSON.stringify(attempt.record).includes(attempt.token));assert.ok(!JSON.stringify(attempt.record).includes('test@example.test'));
 assert.equal(v.prune([attempt.record],now+v.TTL).length,0);
 let sent=false;
 await v.deliver('test@example.test','signup',attempt.token,{env,fetcher:async(url,request)=>{sent=true;assert.equal(url,'https://api.brevo.com/v3/smtp/email');const body=JSON.parse(request.body);assert.equal(body.to.length,1);assert.equal(body.to[0].email,'test@example.test');assert.ok(body.textContent.includes(attempt.token));return {ok:true};}});assert.equal(sent,true);
 await assert.rejects(v.deliver('test@example.test','signup',attempt.token,{env:{},fetcher:async()=>{throw Error('Must remain disabled');}}));
});
test('verified signup and email reset end-to-end using only isolated synthetic delivery',{timeout:35000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fd-verified-'));const tokenFile=path.join(dir,'synthetic-token.txt'),fixture=path.join(dir,'mock.cjs');
 // Local test process only: replace mail delivery and the gate through a preload,
 // never through a production environment switch or public test endpoint.
 fs.writeFileSync(fixture,`const fs=require('node:fs');const p=require('node:path');const v=require(p.join(process.cwd(),'verified-customers'));v.config=()=>({open:true,controller:'Synthetic test',contact:'privacy@example.test',notice:'Synthetic test only',version:'synthetic-v1'});v.deliver=async(address,purpose,token)=>{if(!address.endsWith('@example.test'))throw Error('Only synthetic addresses');fs.writeFileSync(${JSON.stringify(tokenFile)},token);};`);
 const port=38000+Math.floor(Math.random()*2000),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['--require',fixture,'server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,RENDER:'',DATABASE_URL:'',NODE_ENV:'test',DEMO_MODE:'true',PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir},stdio:'ignore'});
 async function call(endpoint,method='GET',body,expected=200,cookie=''){
  const r=await fetch(base+endpoint,{method,headers:{'X-FD-Role':'customer',...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await r.json();assert.equal(r.status,expected,method+' '+endpoint+' '+JSON.stringify(data));return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]||''};
 }
 try{
  for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  const email='verified@example.test',password='synthetic-first-password',nextPassword='synthetic-second-password',signup={email,purpose:'signup',acknowledged:true,noticeVersion:'synthetic-v1'};
  const start=await call('/api/customer/email/start','POST',signup,202);const code=fs.readFileSync(tokenFile,'utf8');
  assert.ok(!JSON.stringify(start.data).includes(code));
  await call('/api/customer/email/finish','POST',{...signup,password,code:'bad-code'},400);
  await call('/api/customer/email/finish','POST',{...signup,password,code});
  const first=await call('/api/customer/email/login','POST',{email,password});
  assert.equal(first.data.account.emailVerified,true);assert.equal(first.data.account.email,email);assert.equal(first.data.account.passwordHash,undefined);
  await call('/api/orders','POST',{storeId:'default'},409,first.cookie);
  await call('/api/customer/email/start','POST',{email,purpose:'reset'},202);
  const reset=fs.readFileSync(tokenFile,'utf8');assert.notEqual(reset,code);
  await call('/api/customer/email/finish','POST',{email,purpose:'reset',password:nextPassword,code:reset});
  await call('/api/customer/email/finish','POST',{email,purpose:'reset',password,code:reset},400);
  await call('/api/customer/orders','GET',undefined,401,first.cookie);
  await call('/api/customer/email/login','POST',{email,password:nextPassword});
 }finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,150));fs.rmSync(dir,{recursive:true,force:true});}
});
