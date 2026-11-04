'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const port = 32187 + Math.floor(Math.random() * 1000);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fair-delivery-test-'));
const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, DEMO_MODE: 'true' }, stdio: ['ignore','pipe','pipe'] });
const base = `http://127.0.0.1:${port}`;
const cookies = {}; let activeRole = '';
function rememberCookie(response, role){const raw=response.headers.get('set-cookie')||'';const first=raw.split(';')[0];if(first)cookies[role]=first;activeRole=role;}
async function waitServer(){for(let i=0;i<40;i++){try{const r=await fetch(base+'/api/health');if(r.ok)return;}catch{}await new Promise(r=>setTimeout(r,150));}throw new Error('Server did not start');}
async function api(url,opts={}){const headers={'X-FD-Role':activeRole,...(opts.headers||{})};const allCookies=Object.values(cookies).join('; ');if(allCookies)headers.Cookie=allCookies;const r=await fetch(base+url,{...opts,headers});const data=await r.json();if(!r.ok)throw new Error(data.error||String(r.status));return data;}
(async()=>{
 try{
  await waitServer();
  const health=await api('/api/health');assert.equal(health.ok,true);
  const html=await fetch(base+'/');assert.equal(html.status,200);assert.match(await html.text(),/Fair Delivery/);
  for (const file of ['/admin.js','/customer.js','/shop.js','/rider.js','/assets/app.css','/assets/common.js','/customer-app.html','/shop-app.html','/Rider-App.html']) { const asset=await fetch(base+file); assert.equal(asset.status,200,`static asset not served: ${file}`); }
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'shop',code:'demo'})});assert.equal(login.status,200);rememberCookie(login,'shop');
  const menu=await api('/api/products');assert.ok(menu.products.length>=1);
  const orderResult=await api('/api/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{productId:menu.products[0].id,qty:2}]})});const id=orderResult.order.id;assert.equal(orderResult.order.status,'new');
  await api(`/api/orders/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'accepted'})});
  await api(`/api/orders/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'ready'})});
  const publicOrder=await api(`/api/orders/${id}`);assert.equal(publicOrder.order.status,'ready');
  const riderLogin=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'rider',code:'demo'})});assert.equal(riderLogin.status,200);rememberCookie(riderLogin,'rider');
  await api('/api/rider/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({online:true})});
  await api(`/api/orders/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'assigned'})});
  await api(`/api/orders/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'picked_up'})});
  const delivered=await api(`/api/orders/${id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'delivered',estimatedKm:2.8,badWeather:true})});assert.equal(delivered.order.status,'delivered');assert.equal(delivered.order.riderPayEstimate,6.24);
  const adminLogin=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:'admin',code:'demo'})});assert.equal(adminLogin.status,200);rememberCookie(adminLogin,'admin');
  const stats=await api('/api/stats');assert.equal(stats.ordersToday,1);assert.equal(stats.deliveredToday,1);
  const saved=JSON.parse(fs.readFileSync(path.join(dataDir,'state.json'),'utf8'));assert.equal(saved.orders.length,1);
  assert.equal(Object.keys(cookies).length,3);
  console.log('PASS: health, static pages/assets, separate shop/rider/admin sessions, menu, order creation, shop workflow, rider workflow, payout estimate, admin stats, persistence.');
 }catch(e){console.error('FAIL:',e);process.exitCode=1;}finally{child.kill('SIGTERM');setTimeout(()=>{try{fs.rmSync(dataDir,{recursive:true,force:true});}catch{}},1000);}
})();
