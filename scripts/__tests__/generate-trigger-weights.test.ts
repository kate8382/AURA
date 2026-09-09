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
    expect(new Set(sids)).toEqual(new Set(['SIG-BEHAVIOR-URGENCY', 'SIG-FIN-SUSPICIOUS']));
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
    const mapping = { signals: { 'SIG-BEHAVIOR-URGENCY': ['urgency'], 'SIG-OTHER': ['unknown'] } };
    fs.writeFileSync(path.join(cfgDir, 'signal-mapping.json'), JSON.stringify(mapping, null, 2), 'utf8');

    const g = new GenerateTriggerWeights(tmp);
    const origArgv = process.argv.slice();
    try {
      process.argv.push('--apply-signal-ids');
      const res = g.run();
      expect(res.outPath).toBeTruthy();
      const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(Array.isArray(written.signal_ids)).toBe(true);
      expect(written.signal_ids).toContain('SIG-BEHAVIOR-URGENCY');
    } finally {
      process.argv = origArgv;
      // cleanup
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    }
  });
});
