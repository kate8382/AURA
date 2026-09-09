import { execSync } from 'child_process';

describe('validate-percases script', () => {
  test('runs without error on public_cases', () => {
    const cmd = 'node -r ts-node/register scripts/validate-percases.ts public_cases';
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out).toContain('Validation complete');
  });
});
