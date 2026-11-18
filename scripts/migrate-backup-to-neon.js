'use strict';
const fs=require('node:fs/promises');
const {Pool}=require('pg');
const {decryptBackup}=require('../encrypted-backup');
const {validateSnapshot,installSnapshot}=require('../migration-tools');
const HELP='Χρήση: NEON_MIGRATION_DATABASE_URL="postgresql://..." node scripts/migrate-backup-to-neon.js encrypted-backup.json [--apply --confirm-digest=SHA256]  (φράση από stdin)';
function targetUrl(value){
 if(typeof value!=='string'||!value)throw Error('Δεν έχει οριστεί ασφαλής URL προορισμού.');
 let url;try{url=new URL(value);}catch{throw Error('Μη έγκυρη URL προορισμού.');}
 if(!['postgresql:','postgres:'].includes(url.protocol)||!url.hostname.endsWith('.neon.tech')||url.pathname!=='/fair_delivery'||url.searchParams.get('sslmode')!=='require'||!url.username||!url.password)throw Error('Ο προορισμός πρέπει να είναι η εγκεκριμένη βάση fair_delivery της Neon με sslmode=require.');
 return url;
}
async function main(){
 const [file,...args]=process.argv.slice(2);
 if(!file||args.some(x=>x!=='--apply'&&!/^--confirm-digest=[a-f0-9]{64}$/.test(x)))throw Error(HELP);
 if(process.env.DATABASE_URL&&process.env.DATABASE_URL===process.env.NEON_MIGRATION_DATABASE_URL)throw Error('Δεν επιτρέπεται να τρέξει ο server με τον ίδιο URL κατά τη μεταφορά.');
 const target=targetUrl(process.env.NEON_MIGRATION_DATABASE_URL);
 const stat=await fs.stat(file);if(stat.size>45*1024*1024)throw Error('Το κρυπτογραφημένο αντίγραφο υπερβαίνει το όριο μεγέθους.');
 const phrase=(await new Promise((resolve,reject)=>{let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{input+=x;if(input.length>512)reject(Error('Υπερβολικά μεγάλη φράση.'));});process.stdin.on('end',()=>resolve(input.replace(/\r?\n$/,'')));process.stdin.on('error',reject);})).trim();
 const state=await decryptBackup(JSON.parse(await fs.readFile(file,'utf8')),phrase);
 const summary=validateSnapshot(state);
 const apply=args.includes('--apply');
 const expected=args.find(a=>a.startsWith('--confirm-digest='))?.slice('--confirm-digest='.length);
 console.log('Ελέγχθηκε το κρυπτογραφημένο αντίγραφο. SHA-256:',summary.digest);
 console.log('Πλήθος εγγραφών:',JSON.stringify(summary.counts));
 const pool=new Pool({connectionString:target.toString(),max:1,connectionTimeoutMillis:8000,statement_timeout:15000,query_timeout:15000});
 try{
  const c=await pool.query("SELECT to_regclass('public.fair_delivery_state') IS NOT NULL AS has_table");
  if(c.rows[0].has_table){
   const count=await pool.query('SELECT count(*)::integer AS n FROM fair_delivery_state');
   if(count.rows[0].n!==0)throw Error('Ο προορισμός δεν είναι κενός. Καμία μεταφορά δεν έγινε.');
  }
  console.log('Η σύνδεση στη Neon λειτουργεί. Ο προορισμός δεν έχει μητρώο.');
  if(!apply){console.log('ΠΡΟΕΠΙΣΚΟΠΗΣΗ ΜΟΝΟ. Δεν γράφτηκε τίποτα.');return;}
  if(expected!==summary.digest)throw Error('Απαιτείται --confirm-digest ακριβώς ίσο με το SHA-256 της προεπισκόπησης.');
  const result=await installSnapshot(pool,state);
  console.log('Επιτυχής μεταφορά και έλεγχος. SHA-256:',result.digest);
  console.log('Δεν άλλαξε η αρχική βάση. Για αλλαγή σε παραγωγή απαιτείται χωριστό ελεγχόμενο cutover.');
 }finally{await pool.end();}
}
main().catch(()=>{console.error('Η διαδικασία διακόπηκε. Δεν εκτελέστηκε μεταφορά ή δεν επιβεβαιώθηκε. Έλεγξε τη σύνδεση, το κλειδί αποκρυπτογράφησης και την κατάσταση της βάσης.');process.exitCode=1;});
