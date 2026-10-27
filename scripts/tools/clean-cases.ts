import fs from 'fs';
import path from 'path';
import { logError, runCli } from '../logger';

function walk(dir: string, cb: (file: string) => void) {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, cb);
    else if (ent.isFile() && ent.name.endsWith('.json')) cb(full);
  }
}

function cleanObj(o: any): boolean {
  if (!o || typeof o !== 'object') return false;
  let changed = false;
  if (Array.isArray(o)) {
    for (const it of o) changed = cleanObj(it) || changed;
    return changed;
  }
  if ('cross_check_audit' in o) {
    delete o.cross_check_audit;
    changed = true;
  }
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v && typeof v === 'object') {
      changed = cleanObj(v) || changed;
    }
  }
  return changed;
}

runCli(() => {
  const base = path.join(process.cwd(), 'synthetic_cases');
  let total = 0;
  let cleaned = 0;
  const failures: string[] = [];
  walk(base, (file) => {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      const c = cleanObj(parsed);
      if (c) {
        fs.copyFileSync(file, file + '.bak');
        fs.writeFileSync(file, JSON.stringify(parsed, null, 2), 'utf8');
        cleaned++;
      }
      total++;
    } catch (e) {
      logError('cannot clean case file', { file, error: e });
      failures.push(file);
    }
  });
  console.log('Scanned', total, 'files, cleaned', cleaned);
  if (failures.length > 0) throw new Error(`${failures.length} file(s) failed: ${failures.join(', ')}`);
});
