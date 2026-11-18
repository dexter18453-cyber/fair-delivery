'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {spawn}=require('node:child_process');
const interest=require('../courier-interest');
test('privacy-rights requests validate minimal inputs and require consent version',()=>{
 const env={COURIER_INTEREST_OPEN:'true',COURIER_INTEREST_CONTROLLER:'Synthetic company',COURIER_INTEREST_CONTACT:'privacy@example.test',COURIER_INTEREST_NOTICE:'Synthetic privacy notice for testing. '.repeat(11)};
 const cfg=interest.config(env);
 assert.equal(cfg.open,true);
 const input={email:'RIGHTS@EXAMPLE.TEST',requestType:'erase',acknowledged:true,noticeVersion:cfg.version};
 const parsed=interest.validatePrivacyRequest(input,cfg);
 assert.equal(parsed.email,'rights@example.test');
 assert.equal(parsed.kind,'privacy-request');
 assert.equal(parsed.requestType,'erase');
 assert.equal(interest.screening(parsed,()=>{throw Error('Rights cannot be screened as applicants');}).status,'privacy-request');
 for(const data of [{...input,acknowledged:false},{...input,noticeVersion:'other'},{...input,requestType:'delete-everyone'},{...input,bankAccount:'evil'}])assert.throws(()=>interest.validatePrivacyRequest(data,cfg));
 assert.throws(()=>interest.validatePrivacyRequest(input,{...cfg,open:false}));
 const html=fs.readFileSync(path.join(__dirname,'../public/courier-apply.html'),'utf8');
 assert.match(html,/id="privacyRequestForm" hidden/);
 assert.match(html,/id="privacyRequestFields" disabled/);
 assert.equal(html.includes('mailto:dexter18453@gmail.com'),false);
 new vm.Script(fs.readFileSync(path.join(__dirname,'../public/courier-interest.js'),'utf8'));
 new vm.Script(fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8'));
});
test('synthetic interest and privacy-rights requests both appear securely in Admin', {timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fd-privacy-intake-')),port=48000+Math.floor(Math.random()*1200),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,RENDER:'',DATABASE_URL:'',FD_MIGRATION_TARGET_DATABASE_URL:'',NODE_ENV:'test',DEMO_MODE:'true',FD_MAINTENANCE_MODE:'false',PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir},stdio:'ignore'});
 async function call(endpoint,method='GET',body,role='',cookie=''){
  const r=await fetch(base+endpoint,{method,headers:{...(role?{'X-FD-Role':role}:{}),...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]||''};
 }
 try{
  for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,120));}
  const settings=await call('/api/courier-interest/config');assert.equal(settings.data.open,true);
  const user={email:'rights@example.test',region:'Synthetic city',consent:true,noticeVersion:settings.data.version};
  assert.equal((await call('/api/courier-interest','POST',user)).status,202);
  const rights={email:user.email,requestType:'erase',acknowledged:true,noticeVersion:settings.data.version};
  assert.equal((await call('/api/courier-interest/privacy-request','POST',{...rights,acknowledged:false})).status,400);
  const first=await call('/api/courier-interest/privacy-request','POST',rights);assert.equal(first.status,202);
  assert.equal((await call('/api/courier-interest/privacy-request','POST',rights)).status,202);
  assert.equal((await call('/api/admin/courier-applications/summary')).status,401);
  const admin=await call('/api/auth/login','POST',{role:'admin',code:'demo'});assert.equal(admin.status,200);
  const summary=await call('/api/admin/courier-applications/summary','GET',undefined,'admin',admin.cookie);
  assert.equal(summary.status,200);assert.equal(summary.data.total,2);assert.equal(summary.data.newCount,2);
  assert.ok(!JSON.stringify(summary.data).includes('rights@example.test'));
  const applications=await call('/api/admin/courier-applications','GET',undefined,'admin',admin.cookie);
  assert.equal(applications.status,200);
  const item=applications.data.applications.find(x=>x.kind==='privacy-request');assert.ok(item);
  assert.equal(item.requestType,'erase');assert.equal(item.email,user.email);
  assert.equal(item.screening.status,'privacy-request');
  const saved=await call('/api/admin/courier-applications/'+item.id,'PATCH',{status:'resolved',reviewNotes:'Synthetic: verify claimant before any action.'},'admin',admin.cookie);
  assert.equal(saved.status,200);
  const after=await call('/api/admin/courier-applications/summary','GET',undefined,'admin',admin.cookie);
  assert.equal(after.data.newCount,1);
 }finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,170));fs.rmSync(dir,{recursive:true,force:true});}
});
