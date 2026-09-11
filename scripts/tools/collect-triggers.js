const fs = require('fs');
const path = require('path');

function walk(dir) {
  const res = [];
  if (!fs.existsSync(dir)) return res;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) res.push(...walk(full));
    else if (ent.isFile() && ent.name.endsWith('.json')) res.push(full);
  }
  return res;
}

function normalize(t) {
  if (!t || typeof t !== 'string') return null;
  return t.trim().toLowerCase().replace(/\s+request$/i, '').replace(/\s+/g, ' ');
}

function main() {
  const root = path.resolve(__dirname, '..', '..', 'public_cases');
  const files = walk(root);
  const triggers = new Set();
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const j = JSON.parse(raw);
      const items = [];
      const topKeys = Object.keys(j || {});
      const categoryKeys = topKeys.filter(k => ['MANIPULATION', 'FRAUD', 'ACCESS'].includes(k));
      if (categoryKeys.length) {
        for (const k of categoryKeys) {
          const arr = j[k] || [];
          if (Array.isArray(arr)) items.push(...arr);
        }
      } else if (j && typeof j === 'object' && j.case_id) items.push(j);
      else {
        for (const k of Object.keys(j || {})) {
          const v = j[k];
          if (Array.isArray(v)) items.push(...v.filter(it => it && it.case_id));
          else if (v && v.case_id) items.push(v);
        }
      }
      for (const c of items) {
        if (Array.isArray(c.scenarios)) {
          for (const s of c.scenarios) {
            if (s && Array.isArray(s.triggers)) for (const t of s.triggers) {
              const n = normalize(t);
              if (n) triggers.add(n);
            }
          }
        }
        if (Array.isArray(c.signal_ids)) for (const s of c.signal_ids) {
          const n = normalize(s);
          if (n) triggers.add(n);
        }
      }
    } catch (err) {
      // ignore
    }
  }
  const arr = Array.from(triggers).sort();
  const tmpDir = path.resolve(process.cwd(), 'tmp');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { }
  const outPath = path.resolve(tmpDir, 'collected-triggers.json');
  fs.writeFileSync(outPath, JSON.stringify(arr, null, 2), 'utf8');
  // also keep legacy filename for compatibility
  try { fs.writeFileSync(path.resolve(tmpDir, 'all-triggers.json'), JSON.stringify(arr, null, 2), 'utf8'); } catch (e) { }
  console.log('WROTE', outPath, 'COUNT', arr.length);
}

if (require.main === module) main();
