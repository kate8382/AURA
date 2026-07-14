import { execSync } from 'child_process';

describe('normalize-percases script', () => {
  test('dry-run executes and reports actions', () => {
    const cmd = 'node -r ts-node/register scripts/normalize-percases.ts public_cases --dry-run';
    const out = execSync(cmd, { encoding: 'utf8' });
    expect(out).toContain('[dry] WOULD');
  });
});
