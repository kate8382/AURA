import fs from 'fs';
import path from 'path';

function walk(dir: string, files: string[] = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, files);
    else if (f.isFile() && f.name.endsWith('.json')) files.push(p);
  }
  return files;
}

function isValidDecision(d: any) {
  return typeof d === 'string' && ['allow', 'review', 'block', 'pending'].includes(d);
}

function main() {
  const argv = process.argv.slice(2);
  const validate = argv.includes('--validate');
  const dir = argv.find(a => a !== '--validate') || 'public_cases';
  const abs = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error('Path not found or not a directory:', abs);
    process.exit(2);
  }
  const files = walk(abs);
  const counts: Record<string, number> = {};
  const invalid: string[] = [];
  const missing: string[] = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const obj = JSON.parse(raw);
      const dec = obj.decision;
      if (typeof dec === 'undefined') {
        missing.push(f);
      } else if (!isValidDecision(dec)) {
        invalid.push(`${f} -> ${String(dec)}`);
      } else {
        counts[dec] = (counts[dec] || 0) + 1;
      }
    } catch (err) {
      // ignore parse errors
      invalid.push(`${f} -> parse error`);
    }
  }

  console.log('Decision counts:');
  for (const k of Object.keys(counts).sort()) console.log(`  ${k}: ${counts[k]}`);
  console.log(`Total files scanned: ${files.length}`);
  if (missing.length) {
    console.log('\nFiles missing `decision` (' + missing.length + '):');
    for (const m of missing.slice(0, 50)) console.log('  ' + m);
  }
  if (invalid.length) {
    console.log('\nFiles with invalid `decision` values (' + invalid.length + '):');
    for (const i of invalid.slice(0, 50)) console.log('  ' + i);
  }
  if (validate) {
    if (missing.length || invalid.length) process.exit(3);
    else process.exit(0);
  }
}

if (require.main === module) main();
