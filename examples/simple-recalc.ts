#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { extractTriggers } from '../scripts/extract-triggers';
import { RecalcConfidence } from '../scripts/recalc_confidence';

async function main() {
  const argv = process.argv.slice(2);
  const fileArg = argv.find(a => !a.startsWith('--')) || 'examples/sample_case.json';
  const extract = argv.includes('--extract-triggers');
  const outFlagIndex = argv.indexOf('--out');
  const outFormat = outFlagIndex >= 0 ? (argv[outFlagIndex + 1] || 'pretty') : 'pretty';

  const absPath = path.isAbsolute(fileArg) ? fileArg : path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(absPath)) {
    console.error('Case file not found:', absPath);
    process.exit(2);
  }

  const raw = fs.readFileSync(absPath, 'utf8');
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    console.error('Failed to parse JSON:', e && e.message);
    process.exit(2);
  }

  // Optionally extract triggers into scenarios (append deduped)
  if (extract && Array.isArray(parsed.scenarios)) {
    for (const sc of parsed.scenarios) {
      try {
        const text = typeof sc.text === 'string' ? sc.text : '';
        const found = extractTriggers(text);
        sc.triggers = sc.triggers || [];
        for (const t of found) if (!sc.triggers.includes(t)) sc.triggers.push(t);
      } catch (err) {
        // best-effort
      }
    }
  }

  // Write to a temp file and call the project's recalc routine so behavior matches production
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-example-'));
  const tmpPath = path.join(tmpDir, path.basename(absPath));
  fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2), 'utf8');

  try {
    const r = new RecalcConfidence();
    await r.recalc(tmpPath, false, 0.0);
    const outRaw = fs.readFileSync(tmpPath, 'utf8');
    const outObj = JSON.parse(outRaw);

    if (outFormat === 'json') {
      console.log(JSON.stringify(outObj, null, 2));
    } else {
      // pretty print summary
      const cid = outObj.case_id || '<no-id>';
      console.log('Case:', cid);
      console.log('Category:', outObj.category || outObj.domain || '-');
      console.log('Confidence:', outObj.confidence, '(raw:', outObj.confidence_raw, ')');
      console.log('Decision:', outObj.decision);
      console.log('Decision reasons:', Array.isArray(outObj.decision_reasons) ? outObj.decision_reasons.join('; ') : '-');
      console.log('Scenarios and triggers:');
      if (Array.isArray(outObj.scenarios)) {
        for (const sc of outObj.scenarios) {
          console.log(' -', sc.name || '-');
          console.log('   triggers:', Array.isArray(sc.triggers) ? sc.triggers.join(', ') : '-');
        }
      }
      if (outObj.cross_check_audit) {
        console.log('Cross-check audit:', JSON.stringify(outObj.cross_check_audit, null, 2));
      }
    }
  } finally {
    // cleanup temp
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch(err => { console.error('Error:', err && err.message ? err.message : err); process.exit(1); });
