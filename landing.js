const cryto= require ('crypto');
const db= require ('db');

const HARBOUR_CODES ={Malpe: 'MLP', Mangaluru: 'MNG', Karwar: 'KWR', Gangolli: 'GNG', Honnavar: 'HNV', Bhatkal: 'BTK' };
const  ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newId(prefix){
    for (let tries=0; tries<50;trie+s++){
    let s = '';
    for (const b of crypto.randomBytes(4)) s += ALPHABET[b % ALPHABET.length];
    const id = `FP-${prefix}-${s}`;
    if (!db.prepare('SELECT 1 FROM batches WHERE id = ?').get(id)) return id;
    }
    throw

}