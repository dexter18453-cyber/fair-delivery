'use strict';
const crypto=require('node:crypto');const {promisify}=require('node:util');const scrypt=promisify(crypto.scrypt);
const FORMAT='fair-delivery-encrypted-backup-v1',LIMIT=32*1024*1024;
function validPhrase(phrase){return typeof phrase==='string'&&phrase.length>=20&&phrase.length<=256&&Buffer.byteLength(phrase)<=512;}
async function key(phrase,salt){if(!validPhrase(phrase))throw Error('Η φράση κρυπτογράφησης πρέπει να έχει 20–256 χαρακτήρες.');return scrypt(phrase,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});}
async function encryptBackup(state,phrase){
 const plain=Buffer.from(JSON.stringify(state));if(plain.length>LIMIT)throw Error('Το αντίγραφο είναι πολύ μεγάλο για εξαγωγή από τον browser.');
 const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),secret=await key(phrase,salt);
 try{const cipher=crypto.createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(Buffer.from(FORMAT));const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);return {format:FORMAT,createdAt:new Date().toISOString(),salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};}
 finally{secret.fill(0);plain.fill(0);}
}
async function decryptBackup(envelope,phrase){
 if(!envelope||envelope.format!==FORMAT||typeof envelope.ciphertext!=='string'||envelope.ciphertext.length>Math.ceil(LIMIT*4/3)+8)throw Error('Μη έγκυρο αντίγραφο.');
 for(const [name,size] of [['salt',16],['iv',12],['tag',16]])if(typeof envelope[name]!=='string'||Buffer.from(envelope[name],'base64').length!==size)throw Error('Μη έγκυρο αντίγραφο.');
 const secret=await key(phrase,Buffer.from(envelope.salt,'base64'));
 try{const cipher=crypto.createDecipheriv('aes-256-gcm',secret,Buffer.from(envelope.iv,'base64'));cipher.setAAD(Buffer.from(FORMAT));cipher.setAuthTag(Buffer.from(envelope.tag,'base64'));const data=Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext,'base64')),cipher.final()]);try{return JSON.parse(data.toString('utf8'));}finally{data.fill(0);}}
 finally{secret.fill(0);}
}
module.exports={encryptBackup,decryptBackup,validPhrase,FORMAT};
