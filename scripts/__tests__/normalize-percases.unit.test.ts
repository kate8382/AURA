import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { NormalizePerCases } from '../normalize-percases';

describe('normalize-percases (unit)', () => {
  test('dry-run executes and reports actions', () => {
    const cmd = 'node -r ts-node/register scripts/normalize-percases.ts public_cases --dry-run';
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out).toMatch(/\[dry\] WOULD|Dry-run mode/);
  });

  test('recomputes existing signal_ids when --apply-signal-ids', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
    const file = path.join(tmp, 'CASE-TEST.json');
    const caseObj = {
      case_id: 'CASE-TEST',
      category: 'test',
      scenarios: [
        { name: 's1', text: 'Example', triggers: ['test-trigger-foo'] }
      ],
      signal_ids: ['OLD-SID']
    };
    await fs.writeFile(file, JSON.stringify(caseObj, null, 2), 'utf8');

    // run normalization with apply-signal-ids flag injected
    process.argv.push('--apply-signal-ids');
    const N = new NormalizePerCases(false);
    await N.processFile(file);

    const out = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Array.isArray(out.signal_ids)).toBe(true);
    // derived signal id should not equal the old one (deriveSignalId('test-trigger-foo') deterministic)
    expect(out.signal_ids).not.toContain('OLD-SID');

    // cleanup argv
    process.argv = process.argv.filter(a => a !== '--apply-signal-ids');
  });
});
