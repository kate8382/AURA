const fs = require('fs');
const path = require('path');
const { logError, runCli } = require('../logger');

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
  const root = path.resolve(__dirname, '..', '..', 'synthetic_cases');
  const files = walk(root);
  const out = [];
  const failures = [];
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
      logError('cannot read case file', { file: f, error: err });
      failures.push(f);
    }
  }
  const tmpDir = path.resolve(process.cwd(), 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.resolve(tmpDir, 'audit-output.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log('WROTE', outPath, 'COUNT', out.length);
  if (failures.length > 0) throw new Error(`${failures.length} file(s) failed: ${failures.join(', ')}`);
}

if (require.main === module) runCli(main);
