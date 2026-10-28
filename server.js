const express = require('express');
const path = require('path');
const QRcode = require('qrcode');
const db = require('./db');
const {buildEpcis} = require('./epcis');
const {createLanding, newId}=require('./landings');
const {isPin, hashPin,checkPin,newToken}=require('./auth');
const {baseUrl} = require('./baseurl');

const BUYER_ROLES =['trader','processor','retailer','transporter'];
const SESSION_DAYS=30

const PORT = process.env.PORT||3000;
const app=express();
app.set('trust proxy',true);
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));
const ivr = require('./ivr');
ivr(app);


const prefixOf = id => id.split('-')[1] || 'KAR';
const parseEvent = e => ({...e,data: JSON.parse(e.data || '{}')});
const round2 = n => Math.round(n*100)/100;
const closeEnough =(a,b) => Math.abs(a-b) <= Math.max(0.5,0.02 * Math.max(a,b));  //2% or 5kg difference

const q = {
  actor: db.prepare('SELECT * FROM actors WHERE id = ?'),
  batch: db.prepare(`SELECT b.*, a.name AS owner_name, a.role AS owner_role, a.location AS owner_location
                     FROM batches b JOIN actors a ON a.id = b.owner_id WHERE b.id = ?`),
  events: db.prepare(`SELECT e.*, a.name AS actor_name, a.role AS actor_role
                      FROM events e LEFT JOIN actors a ON a.id = e.actor_id WHERE e.batch_id = ? ORDER BY e.id`),
  transfer: db.prepare('SELECT * FROM transfers WHERE id = ?'),
  insertBatch: db.prepare(`INSERT INTO batches (id, species, product, quantity_kg, grade, owner_id, status, harbour, vessel, landed_at)
                           VALUES (@id, @species, @product, @quantity_kg, @grade, @owner_id, @status, @harbour, @vessel, @landed_at)`),
  insertEvent: db.prepare('INSERT INTO events (client_id, batch_id, type, actor_id, data) VALUES (?, ?, ?, ?, ?)'),
  insertEdge: db.prepare('INSERT INTO edges (parent_id, child_id, quantity_kg) VALUES (?, ?, ?)'),
  updateQty: db.prepare('UPDATE batches SET quantity_kg = ?, status = ? WHERE id = ?'),
  setStatus: db.prepare('UPDATE batches SET status = ? WHERE id = ?'),
  ancestors: db.prepare(`WITH RECURSIVE up(id) AS (
                           SELECT parent_id FROM edges WHERE child_id = ?
                           UNION SELECT e.parent_id FROM edges e JOIN up ON e.child_id = up.id)
                         SELECT id FROM up`),
  descendants: db.prepare(`WITH RECURSIVE down(id) AS (
                             SELECT child_id FROM edges WHERE parent_id = ?
                             UNION SELECT e.child_id FROM edges e JOIN down ON e.parent_id = down.id)
                           SELECT id FROM down`),
};

function addEvent(batchId, type, actorId, data = {}, clientId = null) {
  return q.insertEvent.run(clientId, batchId, type, actorId, JSON.stringify(data));
}
// Everything upstream and downstream of a batch, with the edges and events among them.
function lineage(id) {
}

// Both sides recorded → confirm (split a child batch to the buyer) or dispute.
function resolveTransfer(t) {
}
function answerTransfer() {

}

const isPublic = (method, p) => p === '/login' || p === '/logout' ||
  (method === 'GET' && (p === '/actors' || p === '/demo-accounts' || /^\/batches\/[^/]+(\/qr\.png)?$/.test(p)));
const sessionActor = token => token && db.prepare(`SELECT a.* FROM sessions s JOIN actors a ON a.id = s.actor_id
  WHERE s.token = ? AND s.created_at > datetime('now', ?)`).get(token, `-${SESSION_DAYS} days`);

app.use('/api', (req, res, next) => {
  // ?token= is for plain download links (the EPCIS export) that cannot carry a header.
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '') || String(req.query.token || '');
  const row = sessionActor(token);
  if (row) req.me = row;
  if (isPublic(req.method, req.path)) return next(); // req.path here is relative to /api
  if (!row) return bad(res, 401, 'Please sign in');
  if (req.body && typeof req.body === 'object') req.body.actor_id = row.id;
  req.query.actor = String(row.id);
  next();
});

app.get('/api/actors', (req, res) => res.json(db.prepare(`SELECT id, name, role, location, vessel${req.me ? ', phone' : ''} FROM actors ORDER BY role, name`).all()));

app.get('/api/demo-accounts', (req, res) => {
  const ph = db.DEMO_PHONES.map(() => '?').join(',');
  res.json(db.prepare(`SELECT id, name, role, location, phone FROM actors WHERE phone IN (${ph}) ORDER BY role, name`).all(...db.DEMO_PHONES));
});
const requireRole = (req, res, role, what) => { if (req.me.role !== role) { bad(res, 403, `Only the ${what} can do this`); return false; } return true; };

// "Buy from a fisher": a signed-in buyer looks up a fisher's unsold batches instead of typing a batch ID.
app.get('/api/actors/:id/batches', (req, res) => {
  const a = q.actor.get(req.params.id);
  if (!a || a.role !== 'fisher') return bad(res, 404, 'Fisher not found');
  res.json(db.prepare(`SELECT * FROM batches WHERE owner_id = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC`).all(a.id));
});


function requireAuthority(req, res) {
    const { batch_id, actor_id, counterparty_id, quantity_kg, price } = req.body;
  const batch = q.batch.get(String(batch_id || '').toUpperCase());
  const me = q.actor.get(actor_id);
  if (!batch || !me) return bad(res, 404, 'Batch or actor not found');
  if (batch.status !== 'active') return bad(res, 400, `This batch is already ${batch.status}`);
  const kg = Number(quantity_kg);
  if (!(kg > 0)) return bad(res, 400, 'Quantity is required');
  const iAmSeller = batch.owner_id === me.id;
  const sellerId = batch.owner_id;
  const buyerId = iAmSeller ? Number(counterparty_id) : me.id;
  const buyer = Number.isFinite(buyerId) ? q.actor.get(buyerId) : null;
  if (!buyer || buyerId === sellerId || !BUYER_ROLES.includes(buyer.role)) return bad(res, 400, 'Choose a trader, processor, retailer or transporter as the other side');
  if (kg > batch.quantity_kg + 0.001) return bad(res, 400, `Only ${batch.quantity_kg} kg left in this batch`);
  const free = round2(batch.quantity_kg - reservedKg(batch.id));
  if (iAmSeller && kg > free + 0.001) return bad(res, 400, `Only ${free} kg left in this batch, the rest is already promised to another buyer`);

 const result = db.transaction(() => {
    let t = db.prepare(`SELECT * FROM transfers WHERE batch_id = ? AND seller_id = ? AND buyer_id = ? AND status = 'pending'`)
      .get(batch.id, sellerId, buyerId);
    let matched = false;
    if (t) {
      const mySide = iAmSeller ? 'seller_kg' : 'buyer_kg';
      if (t[mySide] != null) return { error: 'You already recorded this hand-over. Waiting for the other side.' };
      db.prepare(`UPDATE transfers SET ${mySide} = ?, price = COALESCE(price, ?) WHERE id = ?`).run(kg, price ?? null, t.id);
      matched = true;
    } else {
      const info = db.prepare(`INSERT INTO transfers (batch_id, seller_id, buyer_id, seller_kg, buyer_kg, price) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(batch.id, sellerId, buyerId, iAmSeller ? kg : null, iAmSeller ? null : kg, price ?? null);
      t = q.transfer.get(info.lastInsertRowid);
    }
    addEvent(batch.id, 'CLAIM', me.id, { role: iAmSeller ? 'seller' : 'buyer', counterparty: iAmSeller ? buyerId : sellerId, quantity_kg: kg, transfer_id: t.id, matched });
    return { transfer: resolveTransfer(q.transfer.get(t.id)), matched };
  })();
  if (result.error) return bad(res, 409, result.error);
  res.status(201).json(result);
  // A buyer just claimed from a fisher: ring the fisher so they can press 1 to confirm. Never blocks or fails the request.
  if (!iAmSeller && !result.matched) {
    const seller = q.actor.get(sellerId);
    if (seller && seller.role === 'fisher') ivr.callFisher(req, seller, result.transfer).catch(err => console.warn('IVR: outbound call failed:', err.message));
  }



    app.get('/api/inbox', (req, res) => {
  const a = Number(req.query.actor);
  res.json(db.prepare(`SELECT t.*, b.species, b.product, s.name AS seller_name, s.role AS seller_role, bu.name AS buyer_name, bu.role AS buyer_role
                       FROM transfers t JOIN batches b ON b.id = t.batch_id
                       JOIN actors s ON s.id = t.seller_id JOIN actors bu ON bu.id = t.buyer_id
                       WHERE t.status = 'pending' AND ((t.seller_id = ? AND t.seller_kg IS NULL) OR (t.buyer_id = ? AND t.buyer_kg IS NULL))
                       ORDER BY t.created_at DESC`).all(a, a));
    });

    app.post('/api/transfers/:id/confirm', (req, res) => {
  const t = q.transfer.get(req.params.id);
  if (!t || t.status !== 'pending') return bad(res, 404, 'No pending hand-over with that id');
  const out = answerTransfer(t, req.me.id, req.body.quantity_kg);
  if (out.error) return bad(res, /not yours/.test(out.error) ? 403 : /already recorded/.test(out.error) ? 409 : 400, out.error);
  res.json(out);
    });

    app.post('/api/transfers/:id/reject', (req, res) => {
  const t = q.transfer.get(req.params.id);
  if (!t || t.status !== 'pending') return bad(res, 404, 'No pending hand-over with that id');
  if (t.seller_id !== req.me.id && t.buyer_id !== req.me.id) return bad(res, 403, 'This hand-over is not yours');
  rejectTransfer(t, req.me.id);
  res.json({ ok: true });
    });

    app.post('/api/transfers/:id/resolve', (req, res) => {
  if (!requireRole(req, res, 'authority', 'Fisheries Department')) return;
  const t = q.transfer.get(req.params.id);
  if (!t || t.status !== 'disputed') return bad(res, 404, 'No disputed hand-over with that id');
  if (req.body.cancel) {
    db.prepare(`UPDATE transfers SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?`).run(t.id);
    addEvent(t.batch_id, 'REJECT', req.me.id, { transfer_id: t.id, by: 'authority' });
    return res.json({ transfer: q.transfer.get(t.id) });
  }
  const kg = Number(req.body.quantity_kg);
  const batch = q.batch.get(t.batch_id);
  if (!(kg > 0)) return bad(res, 400, 'Final weight is required');
  const free = round2(batch.quantity_kg - reservedKg(batch.id));
  if (batch.status !== 'active' || kg > free + 0.001) return bad(res, 400, `Only ${free} kg left in this batch`);
  const out = db.transaction(() => {
    db.prepare(`UPDATE transfers SET seller_kg = ?, buyer_kg = ?, status = 'pending' WHERE id = ?`).run(kg, kg, t.id);
    addEvent(t.batch_id, 'CLAIM', req.me.id, { role: 'authority', quantity_kg: kg, transfer_id: t.id, matched: true, resolved_dispute: true });
    return resolveTransfer(q.transfer.get(t.id));
  })();
  res.json({ transfer: out });
    });

// Processor merges N input batches into one output batch.
    app.post('/api/process', (req, res) => {
  const { actor_id, input_ids, product, quantity_kg } = req.body;
  const me = q.actor.get(actor_id);
  if (!me || me.role !== 'processor') return bad(res, 400, 'Only a processor can do this');
  const inputs = (input_ids || []).map(i => q.batch.get(String(i).toUpperCase()));
  if (!inputs.length || inputs.some(b => !b)) return bad(res, 404, 'Pick at least one batch');
  if (inputs.some(b => b.owner_id !== me.id || b.status !== 'active')) return bad(res, 400, 'You can only process active batches you own');
  const busy = inputs.find(b => hasPending(b.id));
  if (busy) return bad(res, 400, `${busy.id} has a hand-over waiting for confirmation. Settle it first.`);
  const inputKg = round2(inputs.reduce((s, b) => s + b.quantity_kg, 0));
  const outKg = Number(quantity_kg);
  if (!(outKg > 0) || outKg > inputKg + 0.001) return bad(res, 400, `Output must be between 0 and ${inputKg} kg`);
  const speciesSet = [...new Set(inputs.map(b => b.species))];
  const id = newId(prefixOf(inputs[0].id));
  db.transaction(() => {
    q.insertBatch.run({ id, species: speciesSet.length === 1 ? speciesSet[0] : 'Mixed (' + speciesSet.join(', ') + ')',
      product: product || 'Processed', quantity_kg: outKg, grade: null, owner_id: me.id, status: 'active',
      harbour: inputs[0].harbour, vessel: null, landed_at: inputs[0].landed_at });
    for (const b of inputs) {
      q.insertEdge.run(b.id, id, b.quantity_kg);
      q.setStatus.run('consumed', b.id);
      addEvent(b.id, 'PROCESS_INPUT', me.id, { output_id: id, quantity_kg: b.quantity_kg });
    }
    addEvent(id, 'PROCESS', me.id, { product, inputs: inputs.map(b => ({ id: b.id, quantity_kg: b.quantity_kg })), input_kg: inputKg, output_kg: outKg });
  })();
  res.status(201).json(q.batch.get(id));
    });
     app.post('/api/merge', (req, res) => {
  const { actor_id, input_ids } = req.body;
  const me = q.actor.get(actor_id);
  if (!me || me.role !== 'trader') return bad(res, 403, 'Only a trader can combine batches');
  const ids = [...new Set((input_ids || []).map(i => String(i).toUpperCase()))];
  if (ids.length < 2) return bad(res, 400, 'Pick at least two batches to combine');
  const inputs = ids.map(i => q.batch.get(i));
  if (inputs.some(b => !b)) return bad(res, 404, 'Batch not found');
  if (inputs.some(b => b.owner_id !== me.id || b.status !== 'active')) return bad(res, 400, 'You can only combine active batches you own');
  if (new Set(inputs.map(b => b.species + '|' + b.product)).size > 1) return bad(res, 400, 'Only batches of the same fish can go into one crate');
  const busy = inputs.find(b => hasPending(b.id));
  if (busy) return bad(res, 400, `${busy.id} has a hand-over waiting for confirmation. Settle it first.`);
  const kg = round2(inputs.reduce((s, b) => s + b.quantity_kg, 0));
  const same = f => new Set(inputs.map(b => b[f])).size === 1 ? inputs[0][f] : null;
  const harbours = [...new Set(inputs.map(b => b.harbour).filter(Boolean))];
  const id = newId(prefixOf(inputs[0].id));
  db.transaction(() => {
    q.insertBatch.run({ id, species: inputs[0].species, product: inputs[0].product, quantity_kg: kg, grade: same('grade'),
      owner_id: me.id, status: 'active', harbour: harbours.join(', ') || null, vessel: same('vessel'),
      landed_at: inputs.map(b => b.landed_at).filter(Boolean).sort()[0] || null }); // oldest catch decides freshness
    for (const b of inputs) {
      q.insertEdge.run(b.id, id, b.quantity_kg);
      q.updateQty.run(0, 'consumed', b.id);
      addEvent(b.id, 'MERGE_INPUT', me.id, { output_id: id, quantity_kg: b.quantity_kg });
    }
    addEvent(id, 'MERGE', me.id, { inputs: inputs.map(b => ({ id: b.id, quantity_kg: b.quantity_kg })), quantity_kg: kg });
  })();
  res.status(201).json(q.batch.get(id));
    });
     app.post('/api/sales', (req, res) => {
  const { batch_id, actor_id, client_id, channel } = req.body;
  const batch = q.batch.get(String(batch_id || '').toUpperCase());
  const me = q.actor.get(actor_id);
  if (!batch || !me) return bad(res, 404, 'Batch or actor not found');
  if (batch.owner_id !== me.id) return bad(res, 403, 'You do not own this batch');
  if (me.role === 'transporter') return bad(res, 400, 'A transporter only carries the fish. Deliver it to the buyer instead.');
  if (batch.status !== 'active') return bad(res, 400, `This batch is already ${batch.status}`);
  if (hasPending(batch.id)) return bad(res, 400, 'This batch has a hand-over waiting for confirmation. Settle it first.');
  if (client_id && db.prepare('SELECT 1 FROM events WHERE client_id = ?').get(client_id)) return res.json(q.batch.get(batch.id));
  db.transaction(() => {
    q.setStatus.run('sold', batch.id);
    addEvent(batch.id, 'SALE', me.id, { quantity_kg: batch.quantity_kg, channel: channel || 'shop' }, client_id || null);
  })();
  res.json(q.batch.get(batch.id));
    });
     app.get('/api/admin/stats', (req, res) => {
  if (!requireRole(req, res, 'authority', 'Fisheries Department')) return;
  const one = sql => db.prepare(sql).get().c;
  res.json({
    totals: {
      actors: one('SELECT COUNT(*) AS c FROM actors'),
      batches: one('SELECT COUNT(*) AS c FROM batches'),
      landings: one(`SELECT COUNT(*) AS c FROM events WHERE type = 'LANDING'`),
      landed_kg: db.prepare(`SELECT COALESCE(SUM(json_extract(data, '$.quantity_kg')), 0) AS c FROM events WHERE type = 'LANDING'`).get().c,
      confirmed: one(`SELECT COUNT(*) AS c FROM transfers WHERE status = 'confirmed'`),
      pending: one(`SELECT COUNT(*) AS c FROM transfers WHERE status = 'pending'`),
      disputed: one(`SELECT COUNT(*) AS c FROM transfers WHERE status = 'disputed'`),
    },
    by_harbour: db.prepare(`SELECT b.harbour, b.species, COUNT(*) AS landings, ROUND(SUM(json_extract(e.data, '$.quantity_kg')), 1) AS kg
                            FROM events e JOIN batches b ON b.id = e.batch_id WHERE e.type = 'LANDING'
                            GROUP BY b.harbour, b.species ORDER BY kg DESC`).all(),
    disputes: db.prepare(`SELECT t.*, b.species, s.name AS seller_name, bu.name AS buyer_name FROM transfers t
                          JOIN batches b ON b.id = t.batch_id JOIN actors s ON s.id = t.seller_id JOIN actors bu ON bu.id = t.buyer_id
                          WHERE t.status = 'disputed' ORDER BY t.resolved_at DESC`).all(),
    batches: db.prepare(`SELECT b.*, a.name AS owner_name, a.role AS owner_role FROM batches b JOIN actors a ON a.id = b.owner_id
                         ORDER BY b.created_at DESC LIMIT 100`).all(),
    recent: db.prepare(`SELECT e.*, a.name AS actor_name FROM events e LEFT JOIN actors a ON a.id = e.actor_id
                        ORDER BY e.id DESC LIMIT 25`).all().map(parseEvent),
  });
     });
}

app.get('/api/export/epcis', (req, res) => {
  if (!requireRole(req, res, 'authority', 'Fisheries Department')) return;
  res.setHeader('Content-Disposition', 'attachment; filename="fish-passport-epcis.json"');
  res.json(buildEpcis(db));
});


// ---------- pages ----------
const page = name => (req, res) => res.sendFile(path.join(__dirname, 'public', name + '.html'));
for (const p of ['home', 'new', 'scan', 'inbox', 'process', 'merge', 'admin']) app.get('/' + p, page(p));
app.get('/batch/:id', page('batch'));
app.get('/trace/:id', page('trace'));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message || 'Server error' }); });

if (require.main === module) app.listen(PORT, () => console.log(`Fish Passport running on http://localhost:${PORT}`));
module.exports = { app };