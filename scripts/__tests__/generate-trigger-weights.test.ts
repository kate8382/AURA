import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import GenerateTriggerWeights, { generateSignalIds } from '../generate-trigger-weights';

describe('generate-trigger-weights script', () => {
  test('generates config from sample public_cases', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aura-gen-'));
    const casesDir = path.join(tmp, 'public_cases');
    await fsp.mkdir(path.join(casesDir, 'ACCESS'), { recursive: true });
    await fsp.mkdir(path.join(casesDir, 'FRAUD'), { recursive: true });

    // create sample cases
    const a = {
      case_id: 'A-1',
      scenarios: [ { name: 's', triggers: ['Urgency / pressure', 'Targeted mass scraping'] } ],
      signal_ids: ['sig-1']
    };
    const b = {
      case_id: 'F-1',
      scenarios: [ { name: 's', triggers: ['targeted mass scraping'] } ],
      signal_ids: []
    };
    await fsp.writeFile(path.join(casesDir, 'ACCESS', 'A-1.json'), JSON.stringify(a, null, 2));
    await fsp.writeFile(path.join(casesDir, 'FRAUD', 'F-1.json'), JSON.stringify(b, null, 2));

    // run the TS script using ts-node/register, with CASES_DIR pointing to tmp cases
    execSync('node -r ts-node/register scripts/generate-trigger-weights.ts', { env: { ...process.env, CASES_DIR: casesDir } });

    const cfgPath = path.resolve('config', 'trigger-weights.json');
    const raw = await fsp.readFile(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('triggerWeights');
    const tw = parsed.triggerWeights;
    // normalized keys should exist
    expect(tw).toHaveProperty('urgency / pressure');
    expect(tw).toHaveProperty('targeted mass scraping');
    // target mass scraping appears in two cases -> should have >= weight of urgency
    expect(tw['targeted mass scraping']).toBeGreaterThanOrEqual(tw['urgency / pressure']);

    // cleanup: restore original config if backup exists
    const bak = cfgPath + '.bak';
    if (await fsp.stat(bak).catch(() => null)) {
      await fsp.rename(bak, cfgPath);
    }
    // remove tmp
    await fsp.rm(tmp, { recursive: true, force: true });
  });
});

describe('GenerateTriggerWeights', () => {
  test('generateSignalIds maps triggers to signal ids', () => {
    const scenarios = [
      { triggers: ['Urgency', 'unknown'] },
      { triggers: ['financial_request'] }
    ];
    const sids = generateSignalIds(scenarios);
    expect(new Set(sids)).toEqual(new Set(['behavior:urgency', 'fin:suspicious']));
  });

  test('run with --apply-signal-ids writes signal_ids into case files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-test-'));
    const publicDir = path.join(tmp, 'public_cases', 'ACCESS');
    fs.mkdirSync(publicDir, { recursive: true });
    const filePath = path.join(publicDir, 'A-TEST.json');
    const sample = { case_id: 'T-1', scenarios: [{ triggers: ['urgency', 'unknown'] }], category: 'access' };
    fs.writeFileSync(filePath, JSON.stringify(sample, null, 2), 'utf8');

    // create minimal signal-mapping.json in tmp config so the instance can load it
    const cfgDir = path.join(tmp, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    const mapping = { signals: { 'behavior:urgency': { id: 'behavior:urgency', triggers: ['urgency'] }, 'fin:suspicious': { id: 'fin:suspicious', triggers: ['financial_request'] }, 'SIG-OTHER': { id: 'SIG-OTHER', triggers: ['unknown'] } } };
    fs.writeFileSync(path.join(cfgDir, 'signal-mapping.json'), JSON.stringify(mapping, null, 2), 'utf8');

    const g = new GenerateTriggerWeights(tmp);
    const origArgv = process.argv.slice();
    try {
      process.argv.push('--apply-signal-ids');
      const res = g.run();
      expect(res.outPath).toBeTruthy();
      const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(Array.isArray(written.signal_ids)).toBe(true);
      expect(written.signal_ids).toContain('behavior:urgency');
    } finally {
      process.argv = origArgv;
      // cleanup
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    }
  });

  test('tiered TF-IDF assigns critical weights (canonical mapping)', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aura-gen-'));
    try {
      const cfgDir = path.join(tmp, 'config');
      await fsp.mkdir(cfgDir, { recursive: true });
      // create a canonical config with headers so generator uses the categories
      const canonical = {
        triggerWeights: {
          '=== CRITICAL / DIRECT EXPLOITS (0.5 - 0.6) ===': '---',
          'actionable payload': 0.5,
          'actionable hardware exploit': 0.5,
          'functional exploit / weaponization': 0.5,
          '=== HIGH SEVERITY / THREAT VECTORS (0.3 - 0.4) ===': '---',
          'automated exploitation': 0.3
        },
        normAlpha: 0.3
      };
      await fsp.writeFile(path.join(cfgDir, 'trigger-weights.json'), JSON.stringify(canonical, null, 2), 'utf8');

      const casesDir = path.join(tmp, 'public_cases');
      await fsp.mkdir(path.join(casesDir, 'ACCESS'), { recursive: true });
      // create a case that contains actionable payload
      const a = { case_id: 'A-CRIT', scenarios: [{ name: 's', triggers: ['Actionable payload'] }] };
      await fsp.writeFile(path.join(casesDir, 'ACCESS', 'A-CRIT.json'), JSON.stringify(a, null, 2));

      const g = new GenerateTriggerWeights(tmp);
      const res = g.run();
      const out = JSON.parse(await fsp.readFile(res.outPath, 'utf8'));
      expect(out).toHaveProperty('triggerWeights');
      const tw = out.triggerWeights;
      // actionable payload should be in critical range 0.50-0.60
      expect(tw['actionable payload']).toBeGreaterThanOrEqual(0.5);
      expect(tw['actionable payload']).toBeLessThanOrEqual(0.6);
      // weightMethod set
      expect(out.weightMethod).toBeTruthy();
    } finally {
      try { await fsp.rm(tmp, { recursive: true, force: true }); } catch (e) {}
    }
  });

  test('regression: preserve categories and correct ranges for known triggers', async () => {
    const cfgPath = path.resolve('config', 'trigger-weights.json');
    const raw = await fsp.readFile(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('triggerWeights');
    const tw = parsed.triggerWeights;

    // helper to detect category from section header text
    function detectCategory(hdr: string) {
      const s = String(hdr || '').toLowerCase();
      if (s.includes('critical')) return 'critical';
      if (s.includes('high')) return 'high';
      if (s.includes('medium')) return 'medium';
      if (s.includes('low')) return 'low';
      if (s.includes('camouflage') || s.includes('weak')) return 'camo';
      return 'camo';
    }

    // build mapping of trigger -> category by walking keys in order
    const mapping: Record<string, string> = {};
    let currentCat = 'camo';
    for (const k of Object.keys(tw)) {
      const s = String(k || '').trim();
      if (s.startsWith('===')) {
        currentCat = detectCategory(s);
        continue;
      }
      mapping[k] = currentCat;
    }

    const CATEGORY_RANGES: Record<string, { lower: number; upper: number }> = {
      critical: { lower: 0.50, upper: 0.60 },
      high: { lower: 0.30, upper: 0.40 },
      medium: { lower: 0.15, upper: 0.20 },
      low: { lower: 0.04, upper: 0.05 },
      camo: { lower: 0.01, upper: 0.03 }
    };

    const checks = [
      'actionable payload request',
      'actionable geolocation payload',
      'functional malicious asset',
      'reputational threat / extortion'
    ];

    for (const t of checks) {
      expect(tw).toHaveProperty(t);
      const cat = mapping[t] || 'camo';
      // ensure not mapped to camo for these known critical/high triggers
      expect(cat).not.toBe('camo');
      const range = CATEGORY_RANGES[cat];
      const w = Number(tw[t]);
      expect(w).toBeGreaterThanOrEqual(range.lower);
      expect(w).toBeLessThanOrEqual(range.upper);
    }
  });
});
