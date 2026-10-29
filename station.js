
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { baseUrl }= require('./baseurl');
const {createLanding, harbourOf} =require('./landings');
const {SPECIES, shortSpecies}=require('./ivr');
const MAX_KG=2000;
const MAX_SKEW_S=300;

const cleanCard = s => String(s ?? '').toUpperCase().replace(/[\s:-]/g, ''); 
const round2 = n => Math.round(n * 100) / 100;
const secretFor = id => process.env['STATION_SECRET_' + String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')];
const fail = (res, code, error) => res.status(code).json({ error });

const seen =new Map();
function firstTime(sig){
  const now = Date.now();
  for (const [s, t] of seen) if (now - t > MAX_SKEW_S * 2000) seen.delete(s);
  if (seen.has(sig)) return false;
  seen.set(sig, now);
  return true;
}

function verifyStation(req,res,next){
  const id = String(req.get('x-station-id') || '');
  const secret = id && secretFor(id);
  if (!secret) return fail(res, 401, 'unknown_station');
  const ts = String(req.get('x-timestamp') || '');
  if (!(Math.abs(Date.now() / 1000 - Number(ts)) <= MAX_SKEW_S)) return fail(res, 401, 'stale_request');
  const sig = String(req.get('x-signature') || '').toLowerCase();
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(`${ts}.`).update(req.rawBody || '').digest('hex'));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), expected)) return fail(res, 401, 'bad_signature');
  if (!firstTime(sig)) return fail(res, 409, 'duplicate_request');
  req.stationId = id.toUpperCase();
  next();
}

function weights(body){
  const gross = Number(body.grossKg), tare = Number(body.tareKg || 0);
  if (!Number.isFinite(gross) || !Number.isFinite(tare) || tare < 0) return { error: 'bad_weight' };
  const net = round2(gross - tare);
  if (!(net > 0) || net > MAX_KG) return { error: 'bad_weight' };
  return { gross: round2(gross), tare: round2(tare), net };
}

const openDeclaration = db.prepare(`SELECT b.* FROM batches b
  WHERE b.owner_id = ? AND b.status = 'active' AND b.created_at > datetime('now', '-1 day')
    AND EXISTS (SELECT 1 FROM events e WHERE e.batch_id = b.id AND e.type = 'LANDING')
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.batch_id = b.id AND e.type = 'WEIGH')
    AND NOT EXISTS (SELECT 1 FROM edges WHERE parent_id = b.id)
    AND NOT EXISTS (SELECT 1 FROM transfers t WHERE t.batch_id = b.id AND t.status = 'pending' AND t.seller_kg IS NOT NULL)
  ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1`);
const byCard = uid => uid && db.prepare('SELECT * FROM actors WHERE card_uid = ?').get(uid);
const batchById = id => db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
const speciesOptions = () => Object.entries(SPECIES).map(([code, [, name]]) => ({ code, name }));

function mountStation(app){
 const r=express.Router();
 r.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
 r.use(verifyStation);
 
 r.post('/landing', (req, res) => {
    const w = weights(req.body);
    if (w.error) return fail(res, 400, w.error);
    const fisher = byCard(cleanCard(req.body.fisherCard));
    if (!fisher) return fail(res, 404, 'fisher_not_found');
    if (fisher.role !== 'fisher') return fail(res, 400, 'not_a_fisher_card');
    let batch = openDeclaration.get(fisher.id);
    const declaredKg = batch ? batch.quantity_kg : null;
    const reading = { net_kg: w.net, gross_kg: w.gross, tare_kg: w.tare, declared_kg: declaredKg,
      diff_kg: batch ? round2(w.net - declaredKg) : null, station_id: req.stationId };
    if (batch) {
      db.transaction(() => {
        db.prepare('UPDATE batches SET quantity_kg = ? WHERE id = ?').run(w.net, batch.id);
        db.prepare('INSERT INTO events (batch_id, type, actor_id, data) VALUES (?, ?, ?, ?)').run(batch.id, 'WEIGH', fisher.id, JSON.stringify(reading));
      })();
    } else {
      const sp = SPECIES[String(req.body.speciesCode || '')];
      if (!sp) return res.status(409).json({ error: 'need_species', needSpecies: true, speciesOptions: speciesOptions() });
      db.transaction(() => {
        const id = createLanding(fisher, { species: sp[0], quantity_kg: w.net, harbour: harbourOf(fisher), vessel: fisher.vessel, source: 'station' });
        db.prepare('INSERT INTO events (batch_id, type, actor_id, data) VALUES (?, ?, ?, ?)').run(id, 'WEIGH', fisher.id, JSON.stringify(reading));
        batch = { id };
      })();
    }
    batch = batchById(batch.id);
    res.status(201).json({ batchId: batch.id, qrUrl: `${baseUrl(req)}/trace/${batch.id}`, species: shortSpecies(batch.species),
      netKg: w.net, declaredKg, fisherName: fisher.name, harbour: batch.harbour });
  });

   r.post('/sale', (req, res) => {
    const w = weights(req.body);
    if (w.error) return fail(res, 400, w.error);
    const batch = batchById(String(req.body.batchId || '').toUpperCase());
    if (!batch) return fail(res, 404, 'batch_not_found');
    if (batch.status !== 'active') return fail(res, 409, 'batch_closed');
    if (w.net > batch.quantity_kg * 1.02 + 0.5) return fail(res, 409, 'weight_exceeds_batch');
    const trader = byCard(cleanCard(req.body.traderCard));
    if (!trader) return fail(res, 404, 'trader_not_found');
    if (trader.id === batch.owner_id) return fail(res, 400, 'buyer_is_seller');
    // A reading a little over the batch (melting ice, a wet crate) counts as all of it.
    const kg = Math.min(w.net, batch.quantity_kg);
    const scale = { station_id: req.stationId, scale_kg: w.net, gross_kg: w.gross, tare_kg: w.tare };
    // The trader may already have recorded this purchase in the app: the scale's weight replaces what they typed.
    const agreed = db.prepare(`SELECT * FROM transfers WHERE batch_id = ? AND seller_id = ? AND buyer_id = ? AND status = 'pending'
      AND buyer_kg IS NOT NULL AND seller_kg IS NULL`).get(batch.id, batch.owner_id, trader.id);
    let result;
    if (agreed) {
      db.transaction(() => {
        db.prepare('UPDATE transfers SET buyer_kg = ? WHERE id = ?').run(kg, agreed.id);
        db.prepare('INSERT INTO events (batch_id, type, actor_id, data) VALUES (?, ?, ?, ?)').run(batch.id, 'CLAIM', trader.id,
          JSON.stringify({ role: 'buyer', counterparty: batch.owner_id, quantity_kg: kg, transfer_id: agreed.id, matched: false, replaced_kg: agreed.buyer_kg, ...scale }));
      })();
      result = { transfer: db.prepare('SELECT * FROM transfers WHERE id = ?').get(agreed.id), matched: false };
    } else {
      result = req.app.locals.recordClaim(batch, trader, null, kg, null, scale);
      if (result.error) return fail(res, result.code, result.code === 400 ? 'not_a_buyer_card' : 'sale_refused');
    }
    res.status(201).json({ saleId: result.transfer.id, traderName: trader.name, netKg: kg, status: result.transfer.status });
    req.app.locals.ringSellerIfFisher(req, result);
  });
   app.use('/station', r);
}

module.exports=mountStation;
module.exports.cleanCard=cleanCard;