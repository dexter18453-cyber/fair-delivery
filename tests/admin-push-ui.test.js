'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../public/admin.js'),'utf8');
const key=crypto.createECDH('prime256v1');key.generateKeys();
const publicKey=key.getPublicKey().toString('base64url');
const flush=()=>new Promise(resolve=>setImmediate(resolve));

async function app({existing=false,permission='default',configFailures=0,saveFailures=0}={}){
 const nodes=new Map(),events=[],notices=[];
 let tapping=false,subscribed=existing;
 function node(id){
  if(!nodes.has(id))nodes.set(id,{textContent:'',value:'',disabled:false,hidden:false,
   addEventListener(){},setAttribute(){},classList:{add(){},remove(){},toggle(){}},querySelectorAll:()=>[]});
  return nodes.get(id);
 }
 node('applicationPushButton').textContent='Ειδοποιήσεις στο κινητό';
 const subscription={endpoint:'https://webpush.push.apple.com/synthetic-ui-device',
  toJSON:()=>({endpoint:subscription.endpoint,keys:{p256dh:publicKey,auth:'synthetic'}}),
  async unsubscribe(){events.push('unsubscribe');subscribed=false;return true;}};
 const notification={permission,requestPermission(){throw Error('Unexpected separate permission prompt');}};
 const manager={
  async getSubscription(){events.push('get-subscription');return subscribed?subscription:null;},
  subscribe(options){
   // Simulate Safari rejecting a prompt once the tap handler has yielded.
   assert.equal(tapping,true,'Subscribe must start directly during the tap');
   assert.equal(options.userVisibleOnly,true);
   assert.equal(Buffer.from(options.applicationServerKey).toString('base64url'),publicKey);
   events.push('subscribe');notification.permission='granted';subscribed=true;
   return Promise.resolve(subscription);
  }
 };
 const context=vm.createContext({
  document:{getElementById:node,querySelectorAll:()=>[],querySelector:()=>null},
  location:{pathname:'/app/admin/'},navigator:{serviceWorker:{ready:Promise.resolve({pushManager:manager})}},
  window:{PushManager:class{},Notification:notification},Notification:notification,
  atob,setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},
  FD:{
   async api(url,options={}){
    if(url==='/api/health')return {version:'test',mode:'local-demo',storage:'temporary-file'};
    if(url==='/api/admin/courier-applications/summary')return {newCount:0,recentIds:[]};
    if(url==='/api/admin/push/config'){
     events.push('config');if(configFailures-->0)throw Error('Synthetic connection failure');
     return {enabled:true,publicKey};
    }
    if(url==='/api/admin/push/subscription'){
     events.push(options.method);
     if(options.method==='POST'&&saveFailures-->0)throw Error('Synthetic save failure');
     return {saved:true};
    }
    throw Error('Unexpected route: '+url);
   },
   me:async()=>({authenticated:false}),
   notice(id,message,error){notices.push({id,message,error});}
  }
 });
 vm.runInContext(source,context);
 context.startApplicationMonitoring();
 await flush();
 return {node,events,notices,notification,async tap(){
  assert.equal(node('applicationPushButton').disabled,false);
  tapping=true;const result=node('applicationPushButton').onclick();tapping=false;
  await result;
 }};
}

test('first notification tap subscribes before yielding or requesting server configuration',async()=>{
 const page=await app();
 assert.deepEqual(page.events,['config','get-subscription']);
 page.events.length=0;
 await page.tap();
 assert.deepEqual(page.events,['subscribe','POST']);
 assert.equal(page.node('applicationPushButton').textContent,'Διακοπή ειδοποιήσεων');
 assert.ok(!page.notices.some(x=>x.error));
});

test('reopening Admin restores its authorized device and displays the unsubscribe action',async()=>{
 const page=await app({existing:true,permission:'granted'});
 assert.deepEqual(page.events,['config','get-subscription','POST']);
 assert.equal(page.node('applicationPushButton').textContent,'Διακοπή ειδοποιήσεων');
 page.events.length=0;
 await page.tap();
 assert.deepEqual(page.events,['DELETE','unsubscribe']);
 assert.equal(page.node('applicationPushButton').textContent,'Ειδοποιήσεις στο κινητό');
});

test('failed subscription save rolls back the device and allows another tap',async()=>{
 const page=await app({saveFailures:1});page.events.length=0;
 await page.tap();
 assert.deepEqual(page.events,['subscribe','POST','unsubscribe']);
 assert.equal(page.node('applicationPushButton').textContent,'Ειδοποιήσεις στο κινητό');
 assert.ok(page.notices.some(x=>x.error&&x.message==='Synthetic save failure'));
 page.events.length=0;
 await page.tap();
 assert.deepEqual(page.events,['subscribe','POST']);
 assert.equal(page.node('applicationPushButton').textContent,'Διακοπή ειδοποιήσεων');
});

test('retry after failed preparation waits for a fresh tap before prompting',async()=>{
 const page=await app({configFailures:1});
 await page.tap();
 assert.equal(page.events.includes('subscribe'),false);
 await page.tap();
 assert.equal(page.events.filter(x=>x==='subscribe').length,1);
 assert.equal(page.node('applicationPushButton').textContent,'Διακοπή ειδοποιήσεων');
});

test('denied permission displays device settings guidance without attempting subscription',async()=>{
 const page=await app({permission:'denied'});page.events.length=0;
 await page.tap();
 assert.deepEqual(page.events,[]);
 assert.ok(page.notices.some(x=>x.error&&/ρυθμίσεις/.test(x.message)));
 assert.equal(page.node('applicationPushButton').disabled,false);
});
