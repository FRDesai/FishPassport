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