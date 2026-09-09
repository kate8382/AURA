import { execSync } from 'child_process';

describe('validate-percases script', () => {
  test('runs without error on private_cases', () => {
    const cmd = 'node -r ts-node/register scripts/validate-percases.ts private_cases';
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out).toContain('Validation complete');
  });
});
