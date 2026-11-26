'use strict';
const crypto=require('node:crypto');
function newRecovery(){const code=crypto.randomBytes(32).toString('base64url');return {code,hash:recoveryHash(code)};}
function recoveryHash(code){return typeof code==='string'&&/^[A-Za-z0-9_-]{43}$/.test(code)?crypto.createHash('sha256').update('fair-delivery-recovery-v1:'+code).digest('hex'):null;}
module.exports={newRecovery,recoveryHash};
