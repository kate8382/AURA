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

function main() {
  const root = path.resolve(__dirname, '..', '..', 'public_cases');
  const files = walk(root);
  const out = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const j = JSON.parse(raw);
      const cat = (j.category || '').toLowerCase();
      const dir = path.basename(path.dirname(f)).toLowerCase();
      if (!cat.includes(dir)) {
        out.push({ file: f.replace(process.cwd() + path.sep, ''), dir, category: j.category || '' });
      }
    } catch (err) {
      // ignore parse errors
    }
  }
  const tmpDir = path.resolve(process.cwd(), 'tmp');
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { }
  const outPath = path.resolve(tmpDir, 'audit-output.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('WROTE', outPath, 'COUNT', out.length);
}

if (require.main === module) main();
