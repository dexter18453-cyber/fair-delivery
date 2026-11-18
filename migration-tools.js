'use strict';
const crypto=require('node:crypto');
const MAX_BYTES=32*1024*1024;
function canonical(value){if(Array.isArray(value))return '['+value.map(x=>canonical(x===undefined?null:x)).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).filter(k=>value[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}

function validateSnapshot(snapshot){
 if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw Error('Το αντίγραφο δεν περιέχει έγκυρο αντικείμενο.');
 if(!snapshot.settings||typeof snapshot.settings!=='object'||Array.isArray(snapshot.settings)||!Array.isArray(snapshot.products)||!Array.isArray(snapshot.orders)||!snapshot.customers||typeof snapshot.customers!=='object'||Array.isArray(snapshot.customers))throw Error('Το αντίγραφο δεν περιέχει τις απαιτούμενες δομές του Fair Delivery.');
 if(!snapshot.riders||typeof snapshot.riders!=='object'||Array.isArray(snapshot.riders)||!snapshot.stores||typeof snapshot.stores!=='object'||Array.isArray(snapshot.stores))throw Error('Λείπουν πληροφορίες για τα καταστήματα ή τους διανομείς.');
 const text=JSON.stringify(snapshot);
 if(Buffer.byteLength(text)>MAX_BYTES)throw Error('Το αντίγραφο υπερβαίνει το όριο των 32 MB.');
 const orders=new Set();for(const order of snapshot.orders){if(!order||typeof order.id!=='string'||orders.has(order.id))throw Error('Διπλά ή μη έγκυρα αναγνωριστικά παραγγελιών.');orders.add(order.id);}
 const products=new Set();for(const p of snapshot.products){if(!p||typeof p.id!=='string'||products.has(p.id))throw Error('Διπλά ή μη έγκυρα αναγνωριστικά προϊόντων.');products.add(p.id);}
 const shape={stores:Object.keys(snapshot.stores).length,customers:Object.keys(snapshot.customers).length,orders:snapshot.orders.length,products:snapshot.products.length,riders:Object.keys(snapshot.riders).length,applications:Array.isArray(snapshot.courierApplications)?snapshot.courierApplications.length:0,settlements:Array.isArray(snapshot.shopSettlements)?snapshot.shopSettlements.length:0};
 const digest=crypto.createHash('sha256').update(canonical(snapshot)).digest('hex');
 return {digest,counts:shape,serialized:text};
}
async function installSnapshot(db,snapshot){
 const {serialized,digest,counts}=validateSnapshot(snapshot);
 const client=await db.connect();let begun=false;
 try{
  await client.query('BEGIN');begun=true;
  // Create the exact table expected by server.js. Never mutate a populated target.
  await client.query('CREATE TABLE IF NOT EXISTS fair_delivery_state (id INTEGER PRIMARY KEY CHECK (id = 1), body JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const previous=await client.query('SELECT id FROM fair_delivery_state LIMIT 1 FOR UPDATE');
  if(previous.rows.length)throw Error('Η βάση προορισμού περιέχει ήδη μητρώο. Καμία αντικατάσταση δεν επιτρέπεται.');
  // The unique id=1 constraint and ON CONFLICT protect against concurrent imports.
  const result=await client.query('INSERT INTO fair_delivery_state (id, body) VALUES (1,$1::jsonb) ON CONFLICT DO NOTHING RETURNING id',[serialized]);
  if(result.rowCount!==1)throw Error('Η εισαγωγή δεν πραγματοποιήθηκε επειδή η βάση δεν είναι κενή.');
  const verified=await client.query('SELECT body FROM fair_delivery_state WHERE id = 1');
  if(verified.rows.length!==1||validateSnapshot(verified.rows[0].body).digest!==digest)throw Error('Η επιβεβαίωση ακεραιότητας της νέας βάσης απέτυχε.');
  await client.query('COMMIT');begun=false;
  return {digest,counts};
 }catch(e){if(begun)await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}
module.exports={MAX_BYTES,validateSnapshot,installSnapshot};
