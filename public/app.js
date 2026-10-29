const Session = {
get actor(){
    try{
        return JSON.parse(localStorage.getItem('fp_actor')|| 'null')
    }catch{
        return null;
    }
},
get token(){
    return localStorage.getItem('fp_token') ||'';
},
set(actor,token){
    localStorage.setItem('fp_actor',JSON.stringify(actor));
    localStorage.setItem('fp_token',token);
},

clear(){
    localStorage.removeItem('fp_actor');
    localStorage.removeItem('fp_token');
}
};


function requireActor() { 
    const a = Session.actor; 
    if (!a || !Session.token) {
         Session.clear(); 
         location.replace('/'); 
         throw new Error('no actor');
         } 
         return a;
         }
async function logout() { 
    try { 
        await api('/api/logout', {}); 
    } catch {

    } Session.clear();
     location.href = '/'; }
const authHeaders = () => Session.token ? { Authorization: 'Bearer ' + Session.token } : {};

async function api(path,body,opts={}){
const init = {headers:authHeaders()};
if (body){
    init.method = opts.method || 'POST';
    init.headers['Content-Type']= 'application/json';
    init.body = JSON.stringify(body);
}
let response ;

try{
    response = await fetch(path,init);
}catch{
    if(body && opts.queue){
        Queue.push(path,body);
        return {queued:true};
    }
    throw new Error('No Connection to Server');
}
const data = await response.json().catch(() => ({}));

if (response.status === 401 && Session.token && path !== '/api/login') {
    Session.clear();
    location.href = '/';
}

if (!response.ok) throw new Error(data.error || response.statusText);

return data;
}

const Queue = {
    key: 'fp_queue',
    all(){
        try {
            return JSON.parse(localStorage.getItem(this.key) || '[]');
        } catch (error) {
            return [];
        }
    },
        save(list)
         { localStorage.setItem(this.key, JSON.stringify(list));
             renderOfflineBar(); },

    push(path, body) {
     const l = this.all();
      l.push({ path, body, at: Date.now() }); 
      this.save(l); 
    },
         async sync() {
    const list = this.all(); if (!list.length) return;
    const left = [];
    for (const item of list) {
      try {
        const r = await fetch(item.path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(item.body) });
        if (!r.ok && (r.status >= 500 || r.status === 401)) left.push(item); // server down or signed out → keep; other 4xx → drop (bad record)
      } catch { left.push(item); }
    }
    this.save(left);
    if (left.length < list.length) toast(`Synced ${list.length - left.length} offline record(s)`);
  },
};    
  
function renderOfflineBar() {
  let bar = document.getElementById('offlineBar');
  const n = Queue.all().length;
  if (!n && !bar) return;
  if (!bar) { bar = document.createElement('div'); bar.id = 'offlineBar'; bar.className = 'offline'; document.body.prepend(bar); }
  bar.style.display = n ? '' : 'none';
  bar.textContent = `${n} record(s) saved on this phone, waiting for signal`;
}
window.addEventListener('online', () => Queue.sync());

const NAV = {
  fisher:    [['home', '/home'], ['new', '/new'], ['scan', '/scan'], ['inbox', '/inbox']],
  trader:    [['home', '/home'], ['scan', '/scan'], ['merge', '/merge'], ['inbox', '/inbox']],
  processor: [['home', '/home'], ['scan', '/scan'], ['process', '/process'], ['inbox', '/inbox']],
  retailer:  [['home', '/home'], ['scan', '/scan'], ['inbox', '/inbox']],
  transporter: [['home', '/home'], ['scan', '/scan'], ['inbox', '/inbox']],
  authority: [['admin', '/admin'], ['scan', '/scan']],
};


function renderNav() {
    const a = Session.actor;
    const nav = document.createElement('div');
    nav.className = 'nav';

    const links = a ? NAV[a.role] || [] : [['scan', '/scan']];

    nav.innerHTML = `<span class="brand">${t('brand')}</span>` +
        links.map(([k, href]) =>
            `<a href="${href}" class="${location.pathname === href ? 'active' : ''}">${t(k)}</a>`
        ).join('') +
        `<button onclick="toggleLang()">${lang() === 'en' ? 'ಕನ್ನಡ' : 'English'}</button>` +
        (a
            ? `<span class="who">${a.name} · ${a.role} · ${a.location || ''} <button onclick="logout()">${t('logout')}</button></span>`
            : `<span class="who"><a href="/">Sign in</a></span>`);

    document.body.prepend(nav);
}

function toast(msg, bad = false) {
  const el = document.createElement('div'); el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3500);
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = s => s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '';
const $ = (sel, root = document) => root.querySelector(sel);

let _actors = null;
async function actors() { if (!_actors) _actors = await api('/api/actors'); return _actors; }
async function actorName(id) { const a = (await actors()).find(x => x.id === Number(id)); return a ? a.name : '#' + id; }

const EVENT_LABEL = {
  LANDING: 'Landed', CLAIM: 'Hand-over recorded', TRANSFER: 'Sold', RECEIVE: 'Received', DISPUTE: 'Weight mismatch flagged',
  REJECT: 'Hand-over rejected', PROCESS_INPUT: 'Sent for processing', PROCESS: 'Processed', SALE: 'Sold to consumer',

    MERGE_INPUT: 'Put in a combined crate', MERGE: 'Combined', WEIGH: 'Weighed at the harbour',
};

function eventLabel(e) {
  const d = e.data || {};
  if (e.type === 'TRANSFER' && e.actor_role === 'transporter') return 'Delivered';
  if (e.type === 'TRANSFER' && d.to_role === 'transporter') return 'Handed to transporter';
  if (e.type === 'RECEIVE' && e.actor_role === 'transporter') return 'Picked up';
  if (e.type === 'RECEIVE' && d.from_role === 'transporter') return 'Delivered by transporter';
  return EVENT_LABEL[e.type] || e.type;
}

async function describeEvent(e) {
  const d = e.data || {};
  if (e.type === 'TRANSFER' && e.actor_role === 'transporter') return `${e.actor_name} delivered ${d.quantity_kg} kg to ${await actorName(d.to)} → ${d.child_id}`;
  if (e.type === 'TRANSFER' && d.to_role === 'transporter') return `${e.actor_name} handed ${d.quantity_kg} kg to ${await actorName(d.to)} for transport → ${d.child_id}`;
  if (e.type === 'RECEIVE' && e.actor_role === 'transporter') return `${e.actor_name} picked up ${d.quantity_kg} kg from ${await actorName(d.from)} (from ${d.parent_id})`;
  if (e.type === 'RECEIVE' && d.from_role === 'transporter') return `${e.actor_name} received ${d.quantity_kg} kg delivered by ${await actorName(d.from)} (from ${d.parent_id})`;
  switch (e.type) {
     case 'LANDING': return `${d.quantity_kg} kg ${d.species} landed at ${d.harbour || '?'}${d.vessel ? ' from boat ' + d.vessel : ''} by ${e.actor_name}${d.source === 'ivr' ? ' (recorded by phone call)' : d.source === 'station' ? ' (recorded at the harbour scale)' : ''}`;
    case 'LANDING': return `${d.quantity_kg} kg ${d.species} landed at ${d.harbour || '?'}${d.vessel ? ' from boat ' + d.vessel : ''} by ${e.actor_name}${d.source === 'ivr' ? ' (recorded by phone call)' : ''}`;
    case 'CLAIM': return `${e.actor_name} (${d.role}) recorded ${d.quantity_kg} kg${d.matched ? ' — matched the other side' : ''}`;
    case 'TRANSFER': return `${e.actor_name} sold ${d.quantity_kg} kg to ${await actorName(d.to)}${d.price ? ' @ ₹' + d.price + '/kg' : ''} → ${d.child_id}`;
    case 'RECEIVE': return `${e.actor_name} received ${d.quantity_kg} kg from ${await actorName(d.from)} (from ${d.parent_id})`;
    case 'DISPUTE': return `Seller says ${d.seller_kg} kg, buyer says ${d.buyer_kg} kg — flagged for the Fisheries Department`;
    case 'REJECT': return `${e.actor_name} rejected the hand-over`;
    case 'PROCESS_INPUT': return `${e.actor_name} took ${d.quantity_kg} kg into ${d.output_id}`;
    case 'PROCESS': return `${e.actor_name} made ${d.output_kg} kg ${d.product} from ${d.input_kg} kg (${(d.inputs || []).map(i => i.id).join(', ')})`;
    case 'MERGE_INPUT': return `${e.actor_name} put ${d.quantity_kg} kg into ${d.output_id}`;
    case 'MERGE': return `${e.actor_name} combined ${(d.inputs || []).map(i => `${i.id} (${i.quantity_kg} kg)`).join(' + ')} into one ${d.quantity_kg} kg batch`;
    case 'SALE': return `${e.actor_name} sold ${d.quantity_kg} kg to a consumer`;
    case 'WEIGH': return `Scale ${d.station_id} weighed ${d.net_kg} kg (${d.declared_kg != null ? `declared ${d.declared_kg} kg` : 'not declared before'}${d.tare_kg ? `, crate ${d.tare_kg} kg removed` : ''}); ${e.actor_name} tapped their card`;
    default: return e.type;
  }
}

async function renderJourney(el, events) {
  const items = [];
  for (const e of events) items.push(`<li class="${e.type}"><b>${eventLabel(e)}</b> <span class="id">${e.batch_id}</span><br>${esc(await describeEvent(e))}<div class="t">${fmtDate(e.created_at)}</div></li>`);
  el.innerHTML = items.length ? `<ul class="timeline">${items.join('')}</ul>` : '<p class="muted">No events yet.</p>';
}

function renderGraph(el, lineage, currentId) {
 if (!window.vis) { el.textContent = 'Graph library not loaded'; return; }
  const nodes = lineage.nodes.map(n => ({
    id: n.id, label: `${n.id}\n${n.quantity_kg} kg ${n.product === 'Whole fish' ? n.species : n.product}\n${n.owner_name}`,
    shape: 'box', margin: 8, font: { size: 13, face: 'system-ui', multi: false },
    color: n.id === currentId ? { background: '#0b5fa5', border: '#083f6e' } : n.status === 'active' ? { background: '#e3f4ea', border: '#1d8a4b' } : { background: '#eef2f5', border: '#b8c2cc' },
    ...(n.id === currentId ? { font: { size: 13, color: '#fff', face: 'system-ui' } } : {}),
  }));
  const edges = lineage.edges.map(e => ({ from: e.parent_id, to: e.child_id, label: e.quantity_kg + ' kg', arrows: 'to', font: { size: 11, align: 'middle' } }));
  new vis.Network(el, { nodes, edges }, {
    layout: { hierarchical: { direction: 'UD', sortMethod: 'directed', levelSeparation: 90, nodeSpacing: 170 } },
    physics: false, interaction: { zoomView: true, dragView: true },
  }).on('click', p => { if (p.nodes[0]) location.href = (location.pathname.startsWith('/trace') ? '/trace/' : '/batch/') + p.nodes[0]; });
}

document.addEventListener('DOMContentLoaded', () => { renderNav(); renderOfflineBar(); Queue.sync(); applyI18n(); });