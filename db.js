const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.FISH_DB || path.join(__dirname,'fish.db');
if(process.argv.includes('--reset')){
    for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) fs.rmSync(f,{force:true});
}

const db = new Database(DB_PATH);
db.pragma('journal_mode =WAL');
db.pragma('foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS actors(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    location TEXT,
    phone TEXT,
    vessel TEXT,
    pin TEXT
    );

     CREATE TABLE IF NOT EXISTS sessions(
     token TEXT PRIMARY KEY,
     actor_id INTEGER NOT NULL REFERENCES actors(id),
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );

     CREATE TABLE IF NOT EXISTS batches(
     id TEXT PRIMARY KEY,
     species TEXT NOT NULL,
     product TEXT NOT NULL DEFAULT 'whole fish',
     quantity_kg REAL NOT NULL,
     grade TEXT,
     owner_id INTEGER NOT NULL REFERENCES actors(id),
     status TEXT NOT NULL DEFAULT 'active',
     harbour TEXT,
     vessel TEXT,
     landed_at TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );
     CREATE TABLE IF NOT EXISTS events(
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id  TEXT UNIQUE,       
        batch_id   TEXT NOT NULL REFERENCES batches(id),
    type       TEXT NOT NULL,          
    actor_id   INTEGER REFERENCES actors(id),
    data       TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );
     CREATE TABLE IF NOT EXISTS edges(
      parent_id   TEXT NOT NULL REFERENCES batches(id),
      child_id    TEXT NOT NULL REFERENCES batches(id),
      quantity_kg REAL NOT NULL,
      PRIMARY KEY (parent_id, child_id)
     );
     CREATE TABLE IF NOT EXISTS transfers(
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id    TEXT NOT NULL REFERENCES batches(id),
    seller_id   INTEGER NOT NULL REFERENCES actors(id),
    buyer_id    INTEGER NOT NULL REFERENCES actors(id),
    seller_kg   REAL,                 
    buyer_kg    REAL,                  
    price       REAL,
    status      TEXT NOT NULL DEFAULT 'pending', 
    child_id    TEXT,                 
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
     );

     CREATE INDEX IF NOT EXISTS idx_events_batch ON events(batch_id);
     CREATE INDEX IF NOT EXISTS idx_transfers_batch ON transfers(batch_id,status);
     
    `);

   const actorCols = db.prepare('PRAGMA table_info(actors)').all().map(c => c.name);
if (!actorCols.includes('vessel')) db.exec('ALTER TABLE actors ADD COLUMN vessel TEXT');
if (!actorCols.includes('pin')) db.exec('ALTER TABLE actors ADD COLUMN pin TEXT');


const ACTORS = [
  ['Suresh Kharvi',                'fisher',    'Malpe',                   '9900000001', 'IND-KA-07-MM-1234'],
  ['Ganesh Salian',                'fisher',    'Mangaluru',               '9900000002', 'IND-KA-02-MM-0456'],
  ['Ravi Traders',                 'trader',    'Malpe Auction Yard',      '9900000003', null],
  ['Fatima Sea Foods',             'trader',    'Udupi',                   '9900000004', null],
  ['Coastal Fresh Processing',     'processor', 'Baikampady, Mangaluru',   '9900000005', null],
  ['Ocean Mart',                   'retailer',  'Indiranagar, Bengaluru',  '9900000006', null],
  ['Dept of Fisheries, Karnataka', 'authority', 'Bengaluru',               '9900000007', null],
  ['Malpe Cold Chain Logistics',   'transporter', 'Malpe – Mangaluru route', '9900000008', 'KA-20-AB-1234'], // vessel = vehicle number
];

if (db.prepare('SELECT COUNT(*) AS c FROM actors').get().c === 0) {
  const ins = db.prepare('INSERT INTO actors (name, role, location, phone, vessel) VALUES (?, ?, ?, ?, ?)');
  for (const a of ACTORS) ins.run(...a);
  console.log('Seeded', ACTORS.length, 'actors');
  } else { // older seed without boats: fill them in by phone number; demo accounts added later (transporter) are inserted
  const upd = db.prepare('UPDATE actors SET vessel = ? WHERE phone = ? AND vessel IS NULL');
  const has = db.prepare('SELECT 1 FROM actors WHERE phone = ?');
  const ins = db.prepare('INSERT INTO actors (name, role, location, phone, vessel) VALUES (?, ?, ?, ?, ?)');
  for (const a of ACTORS) { if (!has.get(a[3])) ins.run(...a); else if (a[4]) upd.run(a[4], a[3]); }
}

const {hashPin} = require('./auth');
for(const a of db.prepare('SELECT  id FROM actors WHERE pin IS NULL').all()) db.prepare('UPDATE actors SET pin = ? WHERE id = ?').run(hashPin('1234'), a.id);

module.exports=db;
module.exports.DEMO_PHONES = ACTORS.map(a=> a[3]);