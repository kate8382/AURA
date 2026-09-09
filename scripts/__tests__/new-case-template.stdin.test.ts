import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('new-case CLI (non-interactive flows)', () => {
  test('creates single-letter folder and uses manual number via -n', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-stdin-'));
    const outDir = path.join(tmp, 'public_cases');
    await fs.mkdir(outDir, { recursive: true });

    const cmd = `node -r ts-node/register scripts/new-case-template.ts -o "${outDir}" -l Q -n 5`;
    execSync(cmd, { stdio: 'inherit' });

    const expected = path.join(outDir, 'Q', 'Q-CASE-005.json');
    const stat = await fs.stat(expected);
    expect(stat.isFile()).toBe(true);

    await fs.rm(tmp, { recursive: true, force: true });
  });

  test('auto-increment via -a when folder exists', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-stdin-'));
    const outDir = path.join(tmp, 'public_cases');
    const rdir = path.join(outDir, 'R');
    await fs.mkdir(rdir, { recursive: true });
    await fs.writeFile(path.join(rdir, 'R-CASE-001.json'), '{}');
    await fs.writeFile(path.join(rdir, 'R-CASE-002.json'), '{}');

    const cmd = `node -r ts-node/register scripts/new-case-template.ts -o "${outDir}" -l R -a`;
    execSync(cmd, { stdio: 'inherit' });

    const expected = path.join(rdir, 'R-CASE-003.json');
    const stat = await fs.stat(expected);
    expect(stat.isFile()).toBe(true);

    await fs.rm(tmp, { recursive: true, force: true });
  });
});
