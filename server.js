const express = require('express');
const path = require('path');
if (require.main === module) require('./env').load(path.join(__dirname, '.env'));
const QRCode = require('qrcode');
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
  const ids = new Set([id]);
  for (const r of q.ancestors.all(id)) ids.add(r.id);
  for (const r of q.descendants.all(id)) ids.add(r.id);
  const list = [...ids];
  const ph = list.map(() => '?').join(',');
  const nodes = list.map(i => q.batch.get(i));
  const edges = db.prepare(`SELECT * FROM edges WHERE parent_id IN (${ph}) AND child_id IN (${ph})`).all(...list, ...list);
  const events = db.prepare(`SELECT e.*, a.name AS actor_name, a.role AS actor_role
                             FROM events e LEFT JOIN actors a ON a.id = e.actor_id
                             WHERE e.batch_id IN (${ph}) ORDER BY e.id`).all(...list).map(parseEvent);
  return { nodes, edges, events };
}

// Both sides recorded → confirm (split a child batch to the buyer) or dispute.
function resolveTransfer(t) {
  if (t.seller_kg == null || t.buyer_kg == null) return t;
  const batch = q.batch.get(t.batch_id);
  if (closeEnough(t.seller_kg, t.buyer_kg)) {
    const kg = Math.min(t.seller_kg, batch.quantity_kg);
    const childId = newId(prefixOf(batch.id));
    q.insertBatch.run({ id: childId, species: batch.species, product: batch.product, quantity_kg: kg, grade: batch.grade,
      owner_id: t.buyer_id, status: 'active', harbour: batch.harbour, vessel: batch.vessel, landed_at: batch.landed_at });
    q.insertEdge.run(batch.id, childId, kg);
    const remaining = round2(batch.quantity_kg - kg);
    q.updateQty.run(Math.max(remaining, 0), remaining <= 0 ? 'consumed' : 'active', batch.id);
    const sellerRole = q.actor.get(t.seller_id).role, buyerRole = q.actor.get(t.buyer_id).role; // so the trace can say "picked up" / "delivered"
    addEvent(batch.id, 'TRANSFER', t.seller_id, { to: t.buyer_id, to_role: buyerRole, quantity_kg: kg, price: t.price, child_id: childId, transfer_id: t.id });
    addEvent(childId, 'RECEIVE', t.buyer_id, { from: t.seller_id, from_role: sellerRole, quantity_kg: kg, parent_id: batch.id, transfer_id: t.id });
    db.prepare(`UPDATE transfers SET status = 'confirmed', child_id = ?, resolved_at = datetime('now') WHERE id = ?`).run(childId, t.id);
  } else {
    addEvent(batch.id, 'DISPUTE', null, { seller_kg: t.seller_kg, buyer_kg: t.buyer_kg, transfer_id: t.id });
    db.prepare(`UPDATE transfers SET status = 'disputed', resolved_at = datetime('now') WHERE id = ?`).run(t.id);
  }
  return q.transfer.get(t.id);
}

const reservedKg = (batchId, exceptTransferId = 0) => db.prepare(`SELECT COALESCE(SUM(seller_kg), 0) AS kg FROM transfers
  WHERE batch_id = ? AND status = 'pending' AND seller_kg IS NOT NULL AND id != ?`).get(batchId, exceptTransferId).kg;
const hasPending = batchId => db.prepare(`SELECT 1 FROM transfers WHERE batch_id = ? AND status = 'pending'`).get(batchId);


function answerTransfer(t, actorId, quantityKg) {
  const side = t.seller_id === actorId ? 'seller_kg' : t.buyer_id === actorId ? 'buyer_kg' : null;
  if (!side) return { error: 'This hand-over is not yours' };
  if (t[side] != null) return { error: 'You already recorded your side' };
  const batch = q.batch.get(t.batch_id);
  if (batch.status !== 'active') { // sold or processed meanwhile → nothing left to hand over
    db.prepare(`UPDATE transfers SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?`).run(t.id);
    return { error: `This batch was already ${batch.status}; the hand-over was cancelled` };
  }
  const kg = Number(quantityKg) > 0 ? Number(quantityKg) : (side === 'seller_kg' ? t.buyer_kg : t.seller_kg);
  const free = round2(batch.quantity_kg - reservedKg(batch.id, t.id));
  if (side === 'seller_kg' && kg > free + 0.001) return { error: `Only ${free} kg left in this batch` };
  return { transfer: db.transaction(() => {
    db.prepare(`UPDATE transfers SET ${side} = ? WHERE id = ?`).run(kg, t.id);
    addEvent(t.batch_id, 'CLAIM', actorId, { role: side === 'seller_kg' ? 'seller' : 'buyer', quantity_kg: kg, transfer_id: t.id, matched: true });
    return resolveTransfer(q.transfer.get(t.id));
  })() };
}

function rejectTransfer(t, actorId) {
  db.prepare(`UPDATE transfers SET status = 'rejected', resolved_at = datetime('now') WHERE id = ?`).run(t.id);
  addEvent(t.batch_id, 'REJECT', actorId, { transfer_id: t.id });
}
app.locals.answerTransfer = answerTransfer; // the IVR (ivr.js) resolves hand-overs through the same code
app.locals.rejectTransfer = rejectTransfer;

const bad = (res, code, error) => res.status(code).json({ error });
const pub = a => { if (!a) return a; const { pin, ...rest } = a; return rest; }; // never send the PIN hash to a browser
const cleanPhone = p => String(p ?? '').replace(/\D/g, '').slice(-10);
const loginFails = new Map(); // phone → { n, until }
app.post('/api/login', (req, res) => {
  const phone = cleanPhone(req.body.phone);
  const f = loginFails.get(phone) || { n: 0, until: 0 };
  if (f.until > Date.now()) return bad(res, 429, `Too many wrong PINs. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minutes`);
  const a = db.prepare('SELECT * FROM actors WHERE phone = ?').get(phone);
  if (!a || !checkPin(req.body.pin, a.pin)) {
    f.n += 1; if (f.n >= 5) { f.until = Date.now() + 5 * 60000; f.n = 0; }
    loginFails.set(phone, f);
    return bad(res, 401, 'Wrong phone number or PIN');
  }
  loginFails.delete(phone);
  db.prepare(`DELETE FROM sessions WHERE created_at < datetime('now', ?)`).run(`-${SESSION_DAYS} days`);
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, actor_id) VALUES (?, ?)').run(token, a.id);
  res.json({ token, actor: pub(a) });
});
app.post('/api/logout', (req, res) => {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});


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

// Fisheries Department registers fishers (so they can sign in and call the IVR). Phone is stored as 10 digits.
function requireAuthority(req, res) {
  const me = req.me;
  if (!me || me.role !== 'authority') { bad(res, 403, 'Only the Fisheries Department can manage fishers'); return null; }
  return me;
}


function phoneTaken(phone, exceptId) {
  const other = db.prepare('SELECT name FROM actors WHERE phone = ? AND id != ?').get(phone, exceptId || 0);
  return other ? `That phone number already belongs to ${other.name}` : null;
}

app.post('/api/actors', (req, res) => {
  if (!requireAuthority(req, res)) return;
  const { name, location, vessel } = req.body;
  const phone = cleanPhone(req.body.phone);
  if (!String(name || '').trim()) return bad(res, 400, 'Name is required');
  if (phone.length !== 10) return bad(res, 400, 'Phone must be a 10-digit mobile number');
  const taken = phoneTaken(phone); if (taken) return bad(res, 409, taken);
  const pin = req.body.pin === undefined || req.body.pin === '' ? '1234' : String(req.body.pin);
  if (!isPin(pin)) return bad(res, 400, 'PIN must be exactly 4 digits');
  const info = db.prepare('INSERT INTO actors (name, role, location, phone, vessel, pin) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(name).trim(), 'fisher', location || null, phone, vessel || null, hashPin(pin));
  res.status(201).json(pub(q.actor.get(info.lastInsertRowid)));
});


app.patch('/api/actors/:id', (req, res) => {
  if (!requireAuthority(req, res)) return;
  const a = q.actor.get(req.params.id);
  if (!a) return bad(res, 404, 'Actor not found');
  const next = { name: a.name, location: a.location, phone: a.phone, vessel: a.vessel };
  for (const k of ['name', 'location', 'vessel']) if (req.body[k] !== undefined) next[k] = String(req.body[k]).trim() || null;
  if (req.body.phone !== undefined) {
    next.phone = cleanPhone(req.body.phone);
    if (next.phone.length !== 10) return bad(res, 400, 'Phone must be a 10-digit mobile number');
    const taken = phoneTaken(next.phone, a.id); if (taken) return bad(res, 409, taken);
  }
  if (!next.name) return bad(res, 400, 'Name is required');
  if (req.body.pin !== undefined && req.body.pin !== '') {
    if (!isPin(req.body.pin)) return bad(res, 400, 'PIN must be exactly 4 digits');
    db.prepare('UPDATE actors SET pin = ? WHERE id = ?').run(hashPin(req.body.pin), a.id);
    db.prepare('DELETE FROM sessions WHERE actor_id = ?').run(a.id); // a new PIN signs that person out everywhere
  }
  db.prepare('UPDATE actors SET name = ?, location = ?, phone = ?, vessel = ? WHERE id = ?').run(next.name, next.location, next.phone, next.vessel, a.id);
  res.json(pub(q.actor.get(a.id)));
});

app.get('/api/me/batches', (req, res) => {
  const me = req.me.id;
  const rows = db.prepare(`SELECT * FROM batches WHERE owner_id = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC`).all(me);
  const past = db.prepare(`SELECT * FROM batches WHERE owner_id = ? AND status != 'active' ORDER BY created_at DESC, rowid DESC LIMIT 30`).all(me);
  const inbox = db.prepare(`SELECT COUNT(*) AS c FROM transfers WHERE status = 'pending'
                            AND ((seller_id = ? AND seller_kg IS NULL) OR (buyer_id = ? AND buyer_kg IS NULL))`).get(me, me).c;
  res.json({ batches: rows, past, inbox });
});


// Fisher records a landing → new root batch + LANDING event.
app.post('/api/landings', (req, res) => {
  const { actor_id, species, quantity_kg, grade, harbour, vessel, landed_at, client_id } = req.body;
  const actor = q.actor.get(actor_id);
  if (!actor || actor.role !== 'fisher') return bad(res, 400, 'Only a fisher can record a landing');
  if (!species || !(Number(quantity_kg) > 0)) return bad(res, 400, 'Species and quantity are required');
  const id = createLanding(actor, { species, quantity_kg, grade, harbour, vessel, landed_at, client_id, source: 'web' });
  res.status(201).json(q.batch.get(id));
});

app.get('/api/batches/:id', (req, res) => {
  const b = q.batch.get(req.params.id.toUpperCase());
  if (!b) return bad(res, 404, 'Batch not found');
  const pending = db.prepare(`SELECT t.*, s.name AS seller_name, s.role AS seller_role, bu.name AS buyer_name, bu.role AS buyer_role FROM transfers t
                              JOIN actors s ON s.id = t.seller_id JOIN actors bu ON bu.id = t.buyer_id
                              WHERE t.batch_id = ? AND t.status = 'pending'`).all(b.id);
  res.json({ batch: b, events: q.events.all(b.id).map(parseEvent), lineage: lineage(b.id), pending });
});

app.get('/api/batches/:id/qr.png', async (req, res) => {
  const url = `${baseUrl(req)}/trace/${req.params.id.toUpperCase()}`;
  res.set('X-QR-Link', url); // handy for checking what the QR encodes
  res.type('png').send(await QRCode.toBuffer(url, { width: 360, margin: 1 }));
});


// Handshake: either side records the hand-over; the second record matches the first.
app.post('/api/transfers', (req, res) => {
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
});



app.get('/api/inbox', (req, res) => {
//   const a = Number(req.query.actor);
  const a = req.me.id; 
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
// Fisheries Department settles a dispute: a final weight (→ confirmed, buyer gets the batch) or cancel.
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


// Retailer sells to a consumer → batch is closed.
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