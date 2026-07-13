import fs from 'fs/promises';
import path from 'path';

type AnyObj = { [k: string]: any };

const DRY = process.argv.includes('--dry-run');

async function walkDir(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await walkDir(full);
    else if (ent.isFile() && ent.name.endsWith('.json')) await processFile(full);
  }
}

async function processFile(filePath: string) {
  const raw = await fs.readFile(filePath, 'utf8');
  let data: AnyObj;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error('Invalid JSON:', filePath, e);
    return;
  }

  // find category wrapper keys (uppercase words)
  const topKeys = Object.keys(data);
  const categoryKey = topKeys.find(k => Array.isArray((data as AnyObj)[k]) && /^[A-Z_]+$/.test(k));

  let caseObjs: AnyObj[] = [];
  if (categoryKey) {
    const arr = (data as AnyObj)[categoryKey];
    if (Array.isArray(arr)) caseObjs = arr;
  } else if ((data as AnyObj).case_id) {
    // single-case file (already normalized) — treat the top-level object as the case
    caseObjs = [(data as AnyObj)];
    // metadata already merged into object; leave `metadata` empty so merging doesn't re-order
    for (const k of ['export_date', 'source', 'anonymized']) delete (data as AnyObj)[k];
  } else {
    // try to find nested case objects
    for (const k of Object.keys(data)) {
      const v = (data as AnyObj)[k];
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item === 'object' && item.case_id) caseObjs.push(item);
      } else if (v && typeof v === 'object' && v.case_id) caseObjs.push(v);
    }
  }

  if (caseObjs.length === 0) return;

  // metadata to merge (for wrapped files only)
  const metadata: AnyObj = {};
  for (const k of ['export_date', 'source', 'anonymized']) {
    if (k in data) metadata[k] = (data as AnyObj)[k];
  }

  // If more than one case in file, split into separate files
  if (caseObjs.length > 1) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, '.json');
    for (let i = 0; i < caseObjs.length; i++) {
      let obj = caseObjs[i];
      // If we need to rename `behavioral_pattern`, preserve original key order by reconstructing object
      if ('behavioral_pattern' in obj && !('behavioral_patterns' in obj)) {
        // replace key while preserving order
        const ordered: AnyObj = {};
        for (const key of Object.keys(obj)) {
          if (key === 'behavioral_pattern') ordered['behavioral_patterns'] = obj[key];
          else ordered[key] = obj[key];
        }
        obj = ordered;
      }
      // Ensure `behavioral_patterns` follows `legal_risk` (or precedes `cross_check` if no legal_risk)
      if ('behavioral_patterns' in obj) {
        const bp = obj['behavioral_patterns'];
        const reordered: AnyObj = {};
        let inserted = false;
        for (const key of Object.keys(obj)) {
          if (key === 'behavioral_patterns') continue; // skip, we'll insert at desired spot
          if (key === 'legal_risk') {
            reordered[key] = obj[key];
            reordered['behavioral_patterns'] = bp;
            inserted = true;
            continue;
          }
          if (key === 'cross_check' && !inserted) {
            // insert before cross_check if legal_risk wasn't present
            reordered['behavioral_patterns'] = bp;
            inserted = true;
          }
          reordered[key] = obj[key];
        }
        if (!inserted) reordered['behavioral_patterns'] = bp;
        obj = reordered;
      }
      const merged = { ...metadata, ...obj };
      const newName = `${base}-${i+1}.json`;
      const outPath = path.join(dir, newName);
      if (DRY) console.log('[dry] WOULD WRITE', outPath);
      else {
        await fs.writeFile(outPath, JSON.stringify(merged, null, 2), 'utf8');
        console.log('WROTE', outPath);
      }
    }
    // remove original
    if (DRY) console.log('[dry] WOULD REMOVE original', filePath);
    else {
      await fs.unlink(filePath);
      console.log('REMOVED original', filePath);
    }
  } else {
    // single case object - replace file content with merged object
    let obj = caseObjs[0];
    if ('behavioral_pattern' in obj && !('behavioral_patterns' in obj)) {
      const ordered: AnyObj = {};
      for (const key of Object.keys(obj)) {
        if (key === 'behavioral_pattern') ordered['behavioral_patterns'] = obj[key];
        else ordered[key] = obj[key];
      }
      obj = ordered;
    }
    if ('behavioral_patterns' in obj) {
      const bp = obj['behavioral_patterns'];
      const reordered: AnyObj = {};
      let inserted = false;
      for (const key of Object.keys(obj)) {
        if (key === 'behavioral_patterns') continue;
        if (key === 'legal_risk') {
          reordered[key] = obj[key];
          reordered['behavioral_patterns'] = bp;
          inserted = true;
          continue;
        }
        if (key === 'cross_check' && !inserted) {
          reordered['behavioral_patterns'] = bp;
          inserted = true;
        }
        reordered[key] = obj[key];
      }
      if (!inserted) reordered['behavioral_patterns'] = bp;
      obj = reordered;
    }
    const merged = { ...metadata, ...obj };
    if (DRY) console.log('[dry] WOULD NORMALIZE', filePath);
    else {
      await fs.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf8');
      console.log('NORMALIZED', filePath);
    }
  }
}

async function main() {
  const target = process.argv[2] || 'premium_matrices';
  const dry = process.argv.includes('--dry-run');
  if (dry) {
    console.log('Dry-run mode: no files will be written.');
    // create a temp workspace to simulate changes? For simplicity, we will just report intended actions.
  }
  await walkDir(target);
}

main().catch(err => { console.error(err); process.exit(1); });
