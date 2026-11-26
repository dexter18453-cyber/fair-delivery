'use strict';
const fs=require('node:fs/promises');
const {decryptBackup}=require('../encrypted-backup');
async function main(){
 const [input,output]=process.argv.slice(2);
 if(!input||!output||!process.stdin.isTTY&&process.stdin.readableEnded)throw Error('Χρήση: node scripts/decrypt-backup.js encrypted.json new-state.json (φράση από stdin)');
 let phrase='';for await(const chunk of process.stdin){phrase+=chunk.toString();if(phrase.length>512)throw Error('Μη έγκυρη φράση.');}
 phrase=phrase.replace(/\r?\n$/,'');
 const stat=await fs.stat(input);if(stat.size>45*1024*1024)throw Error('Πολύ μεγάλο αρχείο.');
 const envelope=JSON.parse(await fs.readFile(input,'utf8'));
 const state=await decryptBackup(envelope,phrase);
 if(!state||!Array.isArray(state.orders)||!Array.isArray(state.products)||!state.settings)throw Error('Το περιεχόμενο δεν είναι έγκυρο μητρώο Fair Delivery.');
 await fs.writeFile(output,JSON.stringify(state,null,2),{mode:0o600,flag:'wx'});
 console.log('Το αντίγραφο αποκρυπτογραφήθηκε σε νέο ιδιωτικό αρχείο. Δεν τροποποιήθηκε καμία βάση.');
}
main().catch(()=>{console.error('Η αποκρυπτογράφηση απέτυχε: έλεγξε φράση, ακεραιότητα και διαδρομές. Το αρχείο εξόδου πρέπει να μην υπάρχει.');process.exitCode=1;});
