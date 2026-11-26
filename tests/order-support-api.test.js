'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {spawn}=require('node:child_process');const {once}=require('node:events');const net=require('node:net');
test('pilot support API is owner-scoped, admin-reviewed, durable and never changes order price', {timeout:30000}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fd-support-'));
 const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
 const base='http://127.0.0.1:'+port;let child;
 async function start(){child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,RENDER:'',DATABASE_URL:'',NODE_ENV:'test',DEMO_MODE:'true',FD_MAINTENANCE_MODE:'false',PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir},stdio:'ignore'});for(let i=0;i<80;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('server startup failed');}
 async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}}
 async function call(url,role='',method='GET',body,status=200,cookie=''){const r=await fetch(base+url,{method,headers:{'X-FD-Role':role,'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();assert.equal(r.status,status,method+' '+url+' '+JSON.stringify(data));return {data,cookie:r.headers.get('set-cookie')?.split(';')[0]||''};}
 async function customer(alias,action='register'){return (await call('/api/customer/'+action,'customer','POST',{alias,password:'synthetic-pass-12345',pilotAcknowledged:true},action==='register'?201:200)).cookie;}
 try{
  await start();
  assert.equal((await fetch(base+'/order-support-ui.js')).status,200);
  const a=await customer('demo-supporta'),b=await customer('demo-supportb');
  const menu=(await call('/api/products')).data.products;
  const order=(await call('/api/orders','customer','POST',{items:[{productId:menu[0].id,qty:1}],customerName:'Synthetic Test',customerPhone:'6900000000',deliveryAddress:'Test Street 10',deliveryLocation:{lat:37.98,lng:23.72},privacyConsent:true},201,a)).data.order;
  const endpoint='/api/customer/orders/'+order.id+'/support';
  await call(endpoint,'customer','GET',undefined,401);
  await call(endpoint,'customer','GET',undefined,404,b);
  await call(endpoint,'customer','POST',{category:'missing_item'},404,b);
  await call(endpoint,'customer','POST',{category:'invalid'},400,a);
  const ticket=(await call(endpoint,'customer','POST',{category:'missing_item'},201,a)).data.ticket;
  assert.equal((await call(endpoint,'customer','POST',{category:'missing_item'},200,a)).data.ticket.id,ticket.id);
  await call('/api/admin/order-support','customer','GET',undefined,401,a);
  const admin=(await call('/api/auth/login','admin','POST',{role:'admin',code:'demo'})).cookie;
  assert.equal((await call('/api/admin/order-support','admin','GET',undefined,200,admin)).data.tickets.length,1);
  await call('/api/admin/order-support/'+order.id+'/'+ticket.id,'admin','PATCH',{decision:'refund_review'},200,admin);
  assert.equal((await call(endpoint,'customer','GET',undefined,200,a)).data.tickets[0].decision,'refund_review');
  await stop();await start();
  const again=await customer('demo-supporta','login');
  assert.equal((await call(endpoint,'customer','GET',undefined,200,again)).data.tickets[0].status,'reviewed');
  const after=(await call('/api/orders/'+order.id,'customer','GET',undefined,200,again)).data.order;
  assert.equal(after.total,order.total);assert.equal(after.paymentCollected,false);assert.equal(after.supportTickets,undefined);
 }finally{await stop();fs.rmSync(dir,{recursive:true,force:true});}
});
