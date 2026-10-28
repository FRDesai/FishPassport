const BIZ_STEP = {
  LANDING:  'urn:gdst:bizStep:landing',
  TRANSFER: 'urn:epcglobal:cbv:bizstep:shipping',
  RECEIVE:  'urn:epcglobal:cbv:bizstep:receiving',
  PICKUP:   'urn:epcglobal:cbv:bizstep:departing',   // a transporter took the batch from the seller
  DELIVERY: 'urn:epcglobal:cbv:bizstep:arriving',    // a transporter handed the batch to the buyer
  PROCESS:  'urn:epcglobal:cbv:bizstep:transforming',
  SALE:     'urn:epcglobal:cbv:bizstep:retail_selling',
};

const SDT   = { owning: 'urn:epcglobal:cbv:sdt:owning_party', possessing: 'urn:epcglobal:cbv:sdt:possessing_party' };
const sdt   = role => role === 'transporter' ? SDT.possessing : SDT.owning; // a carrier possesses, never owns
const lot   = id => `urn:fishpassport:lot:${id}`;
const party = a  => `urn:fishpassport:party:${a}`;
const iso   = s  => new Date(s.replace(' ', 'T') + 'Z').toISOString();

function buildEpics (db) {
    const rows = db.prepare(`
    SELECT e.*, a.name AS actor_name, a.role AS actor_role, a.location AS actor_location,
           b.species, b.product, b.harbour, b.vessel
    FROM events e
    LEFT JOIN actors a ON a.id = e.actor_id
    JOIN batches b ON b.id = e.batch_id
    ORDER BY e.id`).all();

    const eventList = [];
    
    for (const r of rows) {
      const d = JSON.parse(r.data || '{}');
      const base = {
       eventID: `urn:fishpassport:event:${r.id}`,
       eventTime: iso(r.created_at),
       eventTimeZoneOffset: '+05:30',
       readPoint: { id: `urn:fishpassport:location:${(r.actor_location || 'unknown').replace(/\s+/g, '_')}` },
    };
     if (r.type === 'LANDING') {
      eventList.push({ ...base, type: 'ObjectEvent', action: 'ADD', bizStep: BIZ_STEP.LANDING,
        epcList: [lot(r.batch_id)],
        quantityList: [{ epcClass: lot(r.batch_id), quantity: d.quantity_kg, uom: 'KGM' }],
        ilmd: { 'gdst:productOwner': party(r.actor_id), 'gdst:vesselName': r.vessel || null,
                'gdst:unloadingPort': r.harbour || null, 'gdst:speciesName': r.species } });
    } else if (r.type === 'TRANSFER') {
      // a transporter handing on = arriving at the buyer; everyone else = shipping
      eventList.push({ ...base, type: 'ObjectEvent', action: 'OBSERVE', bizStep: r.actor_role === 'transporter' ? BIZ_STEP.DELIVERY : BIZ_STEP.TRANSFER,
        epcList: [lot(r.batch_id)],
        quantityList: [{ epcClass: lot(r.batch_id), quantity: d.quantity_kg, uom: 'KGM' }],
        sourceList: [{ type: sdt(r.actor_role), source: party(r.actor_id) }],
        destinationList: [{ type: sdt(d.to_role), destination: party(d.to) }] });
    } else if (r.type === 'RECEIVE') {
      // a transporter taking the batch = departing from the seller; everyone else = receiving
      eventList.push({ ...base, type: 'ObjectEvent', action: 'OBSERVE', bizStep: r.actor_role === 'transporter' ? BIZ_STEP.PICKUP : BIZ_STEP.RECEIVE,
        epcList: [lot(r.batch_id)],
        quantityList: [{ epcClass: lot(r.batch_id), quantity: d.quantity_kg, uom: 'KGM' }],
        sourceList: [{ type: sdt(d.from_role), source: party(d.from) }],
        destinationList: [{ type: sdt(r.actor_role), destination: party(r.actor_id) }] });
     } else if (r.type === 'PROCESS') {
      eventList.push({ ...base, type: 'TransformationEvent', bizStep: BIZ_STEP.PROCESS,
        inputQuantityList: (d.inputs || []).map(i => ({ epcClass: lot(i.id), quantity: i.quantity_kg, uom: 'KGM' })),
        outputQuantityList: [{ epcClass: lot(r.batch_id), quantity: d.output_kg, uom: 'KGM' }],
        ilmd: { 'gdst:productForm': d.product, 'gdst:productOwner': party(r.actor_id) } });
    } else if (r.type === 'MERGE') {
      // several lots of the same fish commingled into one crate: a transformation with no change of product
      eventList.push({ ...base, type: 'TransformationEvent', bizStep: BIZ_STEP.PROCESS,
        inputQuantityList: (d.inputs || []).map(i => ({ epcClass: lot(i.id), quantity: i.quantity_kg, uom: 'KGM' })),
        outputQuantityList: [{ epcClass: lot(r.batch_id), quantity: d.quantity_kg, uom: 'KGM' }],
        ilmd: { 'gdst:productForm': r.product, 'gdst:productOwner': party(r.actor_id) } });
    } else if (r.type === 'SALE') {
      eventList.push({ ...base, type: 'ObjectEvent', action: 'DELETE', bizStep: BIZ_STEP.SALE,
        epcList: [lot(r.batch_id)],
        quantityList: [{ epcClass: lot(r.batch_id), quantity: d.quantity_kg, uom: 'KGM' }] });
    }

    }

    return {
    '@context': ['https://ref.gs1.org/standards/epcis/2.0.0/epcis-context.jsonld', { gdst: 'https://traceability-dialogue.org/vocab' }],
    type: 'EPCISDocument',
    schemaVersion: '2.0',
    creationDate: new Date().toISOString(),
    epcisBody: { eventList },
  };
}

module.exports = buildEpics;