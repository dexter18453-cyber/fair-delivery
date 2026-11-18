'use strict';
const {Pool}=require('pg');
const {validateSnapshot,installSnapshot}=require('./migration-tools');
function targetConnection(value){
 if(typeof value!=='string'||value.length<30||value.length>4096)throw Error('Η νέα PostgreSQL δεν έχει συνδεθεί ιδιωτικά.');
 let url;try{url=new URL(value);}catch{throw Error('Μη έγκυρη διεύθυνση νέας βάσης.');}
 if(!['postgresql:','postgres:'].includes(url.protocol)||!url.hostname.endsWith('.neon.tech')||url.pathname!=='/fair_delivery'||url.searchParams.get('sslmode')!=='require'||!url.username||!url.password)throw Error('Ο προορισμός δεν είναι η εγκεκριμένη Neon PostgreSQL.');
 return url.toString();
}
function targetPool(value){return new Pool({connectionString:targetConnection(value),max:1,connectionTimeoutMillis:7500,statement_timeout:20000,query_timeout:20000});}
async function destinationState(pool){
 const result=await pool.query("SELECT to_regclass('public.fair_delivery_state') IS NOT NULL AS exists");
 if(!result.rows[0]?.exists)return {tableExists:false,recordCount:0};
 const records=await pool.query('SELECT count(*)::integer AS count FROM public.fair_delivery_state');
 return {tableExists:true,recordCount:Number(records.rows[0]?.count||0)};
}
async function copyIntoNewDatabase(pool,snapshot){
 const before=await destinationState(pool);
 if(before.recordCount!==0)throw Error('Η νέα βάση περιέχει ήδη δεδομένα. Δεν επιτρέπεται επανεγγραφή.');
 const copied=await installSnapshot(pool,snapshot);
 const verified=await pool.query('SELECT body FROM public.fair_delivery_state WHERE id=1');
 const current=verified.rows?.[0]?.body;
 const fingerprint=validateSnapshot(current).digest;
 if(fingerprint!==copied.digest)throw Error('Η επαλήθευση της αντιγραφής απέτυχε.');
 return {digest:fingerprint,counts:copied.counts};
}
module.exports={targetConnection,targetPool,destinationState,copyIntoNewDatabase};
