import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

describe('examples/simple-recalc smoke test', () => {
  test('runs simple-recalc.ts on sample_case.json and outputs valid JSON', () => {
    const bin = 'node';
    const args = ['-r', 'ts-node/register', 'examples/simple-recalc.ts', 'examples/sample_case.json', '--out', 'json'];
    const cwd = path.resolve(__dirname, '..', '..');
    const out = execSync([bin, ...args].join(' '), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toBeTruthy();
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('case_id');
    expect(parsed.case_id).toBe('EX-EXAMPLE-001');
  }, 20000);

  test('extracts triggers and keeps JSON output clean', () => {
    const cwd = path.resolve(__dirname, '..', '..');
    const samplePath = path.join(cwd, 'examples', 'sample_case.json');
    const originalCase = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    const result = spawnSync('node', [
      '-r', 'ts-node/register',
      'examples/simple-recalc.ts',
      'examples/sample_case.json',
      '--extract-triggers',
      '--out', 'json'
    ], { cwd, encoding: 'utf8' });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.scenarios[0].triggers).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(parsed.scenarios[0].triggers.length).toBeGreaterThan(0);
    expect(parsed.decision !== originalCase.decision || parsed.confidence !== originalCase.confidence).toBe(true);
  }, 20000);
});
