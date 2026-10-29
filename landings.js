// const cryto= require ('crypto');
const crypto = require('node:crypto');
const db= require ('./db');

const HARBOUR_CODES ={Malpe: 'MLP', Mangaluru: 'MNG', Karwar: 'KWR', Gangolli: 'GNG', Honnavar: 'HNV', Bhatkal: 'BTK' };
const  ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newId(prefix){
    for (let tries=0; tries<50;tries++){
    let s = '';
    for (const b of crypto.randomBytes(4)) s += ALPHABET[b % ALPHABET.length];
    const id = `FP-${prefix}-${s}`;
    if (!db.prepare('SELECT 1 FROM batches WHERE id = ?').get(id)) return id;
    }
    throw new Error('could not allocate a batch id');

}

    const insertBatch = db.prepare(`INSERT INTO batches (id, species, product, quantity_kg, grade, owner_id, status, harbour, vessel, landed_at)
                                VALUES (@id, @species, @product, @quantity_kg, @grade, @owner_id, @status, @harbour, @vessel, @landed_at)`);
    const insertEvent = db.prepare('INSERT INTO events (client_id, batch_id, type, actor_id, data) VALUES (?, ?, ?, ?, ?)');

    function createLanding(actor, { species, quantity_kg, grade, harbour, vessel, landed_at, client_id, source = 'web' }){
        if (client_id){
            const dup = db. prepare('SELECT batch_id FROM events WHERE client_id = ?').get(client_id);
            if(dup) return dup.batch_id;    
        }
        const id=newId(HARBOUR_CODES[harbour] ||'KA');
        db.transaction(() => {
            insertBatch.run({ id, species, product: 'Whole fish', quantity_kg: Number(quantity_kg), grade: grade || null, owner_id: actor.id,
      status: 'active', harbour: harbour || null, vessel: vessel || null, landed_at: landed_at || new Date().toISOString() });
    insertEvent.run(client_id || null, id, 'LANDING', actor.id, JSON.stringify({ species, quantity_kg: Number(quantity_kg), grade, harbour, vessel, landed_at, source }));
  })();
        return id;
}

function harbourOf(actor) {
  const loc = (actor.location || '').trim();
  return Object.keys(HARBOUR_CODES).find(h => loc.toLowerCase().includes(h.toLowerCase())) || loc || null;
}

 module.exports = { createLanding, newId,HARBOUR_CODES };