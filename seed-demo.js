

const BASE= process.env.PUBLIC_URL || 'https://localhost:8000';

const PHONES= {suresh: 9900000001, ravi: 9900000003, coastal: 9900000005, truck: 9900000008 };

const tokens={};

async function call(method, path, body, who){
 const headers={'Content-Type' : 'application/json'};
    if(who) headers.Authorization = 'Bearer' +tokens[who];
    const r = await fetch(BASE +path,{method,headers,body:body? JSON.stringify(body):undefined});
    const data = await r.json();
    if(!r.ok) throw new Error(path + ' → ' + data.error);
    return data;
 }

const post=(path,body,who)=> call('POST', path,body,who);
const get=(path,who)=> call('GET', path, null, who);

async function handOver(batchId, seller, buyer, kg, price){
 await post('/api/transfers', { batch_id: batchId, counterparty_id: (await get('/api/actors', buyer)).find(a => a.phone === PHONES[buyer]).id, quantity_kg: kg, price }, seller);
 const inbox=await get('api/inbox',buyer);
 const t= inbox.find(x => x.batch_id ==batchId);
 const r= await post(`/api/transfers/${t.id}/confirm`, {}, buyer);
 console.log(`  ${batchId} → ${kg} kg → ${buyer}: ${r.transfer.status} (${r.transfer.child_id})`);
 return r.transfer.child_id;
}

(async () => {
  for (const [who, phone] of Object.entries(PHONES)) tokens[who] = (await post('/api/login', { phone, pin: '1234' })).token;
  console.log('Landing 50kg of mackeral at Malpe as Suresh');
  const root=await post('/api/landings', { species: 'Indian Mackerel (Bangude)', quantity_kg: 50, grade: 'A', harbour: 'Malpe', vessel: 'IND-KA-07-MM-1234' }, 'suresh');
  console.log('root batch', root.id);
  const onTruck= await handOver(root.id, 'suresh', 'truck', 30);
  const c1 = await handover(onTruck, 'truck', 'ravi', 30, 180);          // and delivers to the trader
  const c2 = await handover(root.id, 'suresh', 'ravi', 20, 175);         // the rest is sold at the harbour directly
  const p1 = await handover(c1, 'ravi', 'coastal', 30, 210);
  const p2 = await handover(c2, 'ravi', 'coastal', 20, 210);
  console.log('Done. Coastal Fresh Processing now owns', p1, 'and', p2, '— ready for the Process step.');
  console.log('Open', BASE + '/batch/' + root.id, 'to see the root batch.');
})().catch(e => { console.error('Seed failed:', e.message, '\nIs the server running on', BASE, '?'); process.exit(1); });