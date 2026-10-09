import { execSync } from 'child_process';
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
});
