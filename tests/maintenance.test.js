'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {decryptBackup}=require('../encrypted-backup');
test('maintenance freezes writes but permits admin login and encrypted final export',{timeout:35000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fd-maintenance-'));
 const port=40200+Math.floor(Math.random()*1000),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),env:{...process.env,RENDER:'',DATABASE_URL:'',NODE_ENV:'test',DEMO_MODE:'true',FD_MAINTENANCE_MODE:'true',PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir},stdio:'ignore'});
 async function request(endpoint,method='GET',body,role='',cookie=''){
  const response=await fetch(base+endpoint,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(role?{'X-FD-Role':role}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
 }
 try{
  for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  const status=await request('/api/health');assert.equal(status.status,200);assert.equal(status.body.maintenance,true);
  const refuse=await request('/api/orders','POST',{items:[]});assert.equal(refuse.status,503);assert.match(refuse.body.error,/συντήρηση/);
  assert.equal((await request('/api/customer/register','POST',{alias:'demo-locked',password:'synthetic-password',pilotAcknowledged:true})).status,503);
  assert.equal((await request('/api/admin/stores','POST',{name:'Synthetic'})).status,503);
  const login=await request('/api/auth/login','POST',{role:'admin',code:'demo'});
  assert.equal(login.status,200);assert.ok(login.cookie);
  const verify=await request('/api/admin/storage/verify','GET',undefined,'admin',login.cookie);
  assert.equal(verify.status,200);assert.equal(verify.body.counts.orders,0);
  const passphrase='synthetic maintenance phrase for backup';
  const backup=await request('/api/admin/backup','POST',{confirm:true,adminCode:'demo',passphrase},'admin',login.cookie);
  assert.equal(backup.status,200);
  const restored=await decryptBackup(backup.body,passphrase);
  assert.equal(restored.orders.length,0);
 }finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,150));fs.rmSync(dir,{recursive:true,force:true});}
});
