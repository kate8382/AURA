import path from 'path';
import fs from 'fs';
import GenerateTriggerWeights from '../generate-trigger-weights';

function walkDir(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkDir(full, files);
    else if (ent.isFile() && ent.name.endsWith('.json')) files.push(full);
  }
  return files;
}

function extractCasesFromFile(file: string): any[] {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    const cases: any[] = [];
    const topKeys = Object.keys(data || {});
    const categoryKeys = topKeys.filter(k => ['MANIPULATION', 'FRAUD', 'ACCESS'].includes(k));
    if (categoryKeys.length) {
      for (const k of categoryKeys) {
        const arr = (data as any)[k] || [];
        if (Array.isArray(arr)) cases.push(...arr);
      }
      return cases;
    }
    if (data && typeof data === 'object' && (data as any).case_id) return [data];
    for (const k of Object.keys(data || {})) {
      const v = (data as any)[k];
      if (Array.isArray(v)) for (const item of v) if (item && typeof item === 'object' && (item as any).case_id) cases.push(item);
      else if (v && typeof v === 'object' && (v as any).case_id) cases.push(v);
    }
    return cases;
  } catch (e) {
    return [];
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const casesDir = process.env.CASES_DIR || path.join(repoRoot, 'public_cases');
  const files = walkDir(casesDir);
  const counts: Record<string, number> = Object.create(null);
  let total = 0;
  for (const f of files) {
    const cs = extractCasesFromFile(f);
    for (const c of cs) {
      total++;
      const uniq = new Set<string>();
      if (Array.isArray((c as any).scenarios)) {
        for (const s of (c as any).scenarios) if (s && Array.isArray(s.triggers)) for (const t of s.triggers) {
          if (!t || typeof t !== 'string') continue;
          const n = t.trim().toLowerCase().replace(/\s+request$/i, '').replace(/\s+/g, ' ');
          if (n) uniq.add(n);
        }
      }
      for (const trig of uniq) counts[trig] = (counts[trig] || 0) + 1;
    }
  }

  const gw = new GenerateTriggerWeights(repoRoot);

  // linear
  gw.weightMethod = 'linear';
  const linear = gw.computeWeights(counts, total).triggerWeights;

  // tfidf
  gw.weightMethod = 'tfidf';
  const tfidf = gw.computeWeights(counts, total).triggerWeights;

  const allKeys = Array.from(new Set([...Object.keys(linear), ...Object.keys(tfidf)])).sort();
  const rows = allKeys.map(k => ({ key: k, linear: linear[k] || 0, tfidf: tfidf[k] || 0, diff: (tfidf[k] || 0) - (linear[k] || 0) }));
  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  console.log('Total cases:', total, 'unique triggers:', allKeys.length);
  console.log('trigger, linear, tfidf, diff');
  for (const r of rows.slice(0, 200)) console.log(`${r.key} | ${r.linear.toFixed(3)} | ${r.tfidf.toFixed(3)} | ${r.diff.toFixed(3)}`);
}

main().catch(e => { console.error(e); process.exit(2); });
