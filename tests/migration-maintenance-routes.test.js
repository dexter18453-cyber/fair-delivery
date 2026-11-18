'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
test('maintenance leaves reads and admin backup access intact while blocking writes',{timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fd-maintenance-')),port=40100+Math.floor(Math.random()*1000),base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,RENDER:'',DATABASE_URL:'',FD_MIGRATION_TARGET_DATABASE_URL:'',FD_MAINTENANCE_MODE:'true',NODE_ENV:'test',DEMO_MODE:'true',PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir},stdio:'ignore'});
 async function call(url,method='GET',body,cookie='',role=''){
  const response=await fetch(base+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(role?{'X-FD-Role':role}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]||''};
 }
 try{
  for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.equal((await call('/api/health')).data.maintenance,true);
  assert.equal((await call('/api/products')).status,200);
  assert.equal((await call('/api/customer/register','POST',{alias:'demo-writesblocked',password:'synthetic-password-1234',pilotAcknowledged:true})).status,503);
  assert.equal((await call('/api/orders','POST',{})).status,503);
  const admin=await call('/api/auth/login','POST',{role:'admin',code:'demo'});
  assert.equal(admin.status,200);
  const verified=await call('/api/admin/storage/verify','GET',undefined,admin.cookie,'admin');
  assert.equal(verified.status,200);assert.match(verified.data.integritySha256,/^[a-f0-9]{64}$/);
  const notConfigured=await call('/api/admin/migration/preflight','GET',undefined,admin.cookie,'admin');
  assert.equal(notConfigured.status,503);
  const copying=await call('/api/admin/migration/copy','POST',{adminCode:'demo',expectedDigest:verified.data.integritySha256,confirmDownloadedBackup:true,confirmNewDatabase:true},admin.cookie,'admin');
  assert.equal(copying.status,503);
  const backup=await call('/api/admin/backup','POST',{adminCode:'demo',passphrase:'synthetic-passphrase-for-quiet-tests',confirm:true},admin.cookie,'admin');
  assert.equal(backup.status,200);assert.equal(backup.data.format,'fair-delivery-encrypted-backup-v1');
 }finally{child.kill('SIGTERM');await new Promise(r=>setTimeout(r,200));fs.rmSync(dir,{recursive:true,force:true});}
});
