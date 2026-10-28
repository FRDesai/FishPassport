// pin hashing and session tokens 

const cryto= require ('crypto');

const isPin = p => /^\d{4}$ /.test(String(p ??''));
function hashPin(pin){
    const salt= crypto.randomBytes(8).toString('hex');
    return salt + ':' + crypto.createHash('sha256').update(salt + String(pin)).digest('hex');
}

function checkPin(pin,stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt, hash] = stored.split(':')
    const got =crypto.createHash('sha256').update(salt + String(pin)).digest('hex');
    return got.length === hash.length && crypto.timingSafeEqual (Buffer.from(got), Buffer.from(hash));
}

const newToken =()=>crypto.randomBytes(24).toString('hex');

module.exports = {isPin,hashPin,checkPin,newToken};