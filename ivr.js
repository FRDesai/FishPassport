const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { createLanding, HARBOUR_CODES } = require('./landings');
const { baseUrl } = require('./baseurl');
const MAX_KG = 2000; // a keypad slip like 9999 is far more likely than a two-tonne landing

const LANG = process.env.IVR_LANG || 'en-IN'; 
const CLIPS_DIR = process.env.IVR_CLIPS_DIR || path.join(__dirname, 'public', 'ivr'); 

const SPECIES = {
  1: ['Indian Mackerel (Bangude)', 'Bangude'],
  2: ['Oil Sardine (Boothai)', 'Boothai'],
  3: ['Seer Fish (Anjal)', 'Anjal'],
  4: ['Silver Pomfret (Manji)', 'Manji'],
  5: ['Lady Fish (Kane)', 'Kane'],
  6: ['Prawns', 'Prawns'],
};

const SPECIES_MENU=Object.entries(SPECIES).map(([d, [, short]]) => `press ${d} for ${short}`).join(', ');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function plivoSignedString(req, nonce){
  const u = new URL(baseUrl(req) + req.originalUrl);
  const qp = {}; for (const [k, v] of u.searchParams) (qp[k] ||= []).push(v);
  const query = Object.keys(qp).sort().map(k => qp[k].sort().map(v => `${k}=${v}`).join('&')).join('&');
  const body = req.body || {};
  const params = Object.keys(body).sort().map(k => [].concat(body[k]).sort().map(v => k + v).join('')).join('');
  let s = u.origin + u.pathname;
  if (query || params) s += '?' + query;
  if (query && params) s += '.';
  return s + params + '.' + nonce;
}

function verifyPlivo(req, res, next){
     const token = process.env.PLIVO_AUTH_TOKEN;
  if (!token) return next();
  const nonce = req.get('x-plivo-signature-v3-nonce') || '';
  const expected = Buffer.from(crypto.createHmac('sha256', token).update(plivoSignedString(req, nonce)).digest('base64'));
  // The header can carry several signatures (comma-separated) while an auth token is being rotated.
  const ok = String(req.get('x-plivo-signature-v3') || '').split(',').map(s => Buffer.from(s.trim()))
    .some(given => given.length === expected.length && crypto.timingSafeEqual(given, expected));
  if (!ok) { console.warn(`IVR: rejected ${req.method} ${baseUrl(req)}${req.originalUrl} — bad Plivo signature (is PUBLIC_URL exactly the address Plivo calls?)`); return res.status(403).send('bad signature'); }
  next();
}

function prompt(){}

function gather(){}

const COUNTRY_CODE = process.env.IVR_COUNTRY_CODE || '91';
const outboundEnabled = () => !!(process.env.PLIVO_AUTH_ID && process.env.PLIVO_AUTH_TOKEN && process.env.PLIVO_NUMBER);

async function callFisher(req, fisher, transfer) {
  if (!outboundEnabled() || !fisher || !fisher.phone) return false;
  const authId = process.env.PLIVO_AUTH_ID;
  const api = (process.env.PLIVO_API_URL || 'https://api.plivo.com/v1').replace(/\/+$/, '');
  const to = COUNTRY_CODE + String(fisher.phone).replace(/\D/g, '').slice(-10);
  const body = { from: process.env.PLIVO_NUMBER.replace(/\D/g, ''), to, answer_url: baseUrl(req) + '/ivr/answer', answer_method: 'POST', ring_timeout: 30 };
  const r = await fetch(`${api}/Account/${authId}/Call/`, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Basic ' + Buffer.from(`${authId}:${process.env.PLIVO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Plivo ${r.status}: ${(await r.text()).slice(0, 200)}`);
  console.log(`IVR: ringing ${fisher.name} (${to}) about hand-over #${transfer.id}`);
  return true;
}

function speciesMenu(req, actor, greet = true) {
  const inner = (greet ? prompt(req, 'greeting', `Namaskara ${actor.name.split(' ')[0]}. Fish Passport.`) : '') +
    prompt(req, 'species', `Which fish did you land? ${SPECIES_MENU}.`);
  return gather(req, '/ivr/species', 1, inner) + prompt(req, 'noinput', 'We did not hear anything. Goodbye.') + '<Hangup/>';
}

function callerAlert(){

}

function askWeight(){

}

function mountIVR(){

}


module.exports = mountIVR;
module.exports.callFisher;