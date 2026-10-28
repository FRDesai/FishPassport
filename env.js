// env.js — read KEY=value lines from a .env file into process.env, without a dependency and on any Node version.
// Values already set in the shell win. A missing file is fine.
const fs = require('fs');

function parse(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) v = v.slice(1, -1);
    else { const hash = v.indexOf(' #'); if (hash >= 0) v = v.slice(0, hash).trim(); } // trailing comment
    out[m[1]] = v;
  }
  return out;
}

function load(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const vars = parse(text);
  for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
  return vars;
}

module.exports = { load, parse };
