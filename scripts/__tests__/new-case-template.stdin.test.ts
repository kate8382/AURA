import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('new-case CLI (non-interactive flows)', () => {
  test('creates single-letter folder and uses manual number via -n', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-stdin-'));
    const outDir = path.join(tmp, 'synthetic_cases');
    await fs.mkdir(outDir, { recursive: true });

    const cmd = `node -r ts-node/register scripts/new-case-template.ts -o "${outDir}" -l Q -n 5`;
    execSync(cmd, { stdio: 'inherit' });

    const expected = path.join(outDir, 'Q', 'SC-Q-005.json');
    const stat = await fs.stat(expected);
    expect(stat.isFile()).toBe(true);

    await fs.rm(tmp, { recursive: true, force: true });
  }, 60000);

  test('--type real writes RC- ids', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-stdin-'));
    const outDir = path.join(tmp, 'cases');
    await fs.mkdir(outDir, { recursive: true });

    execSync(`node -r ts-node/register scripts/new-case-template.ts -o "${outDir}" -l M -n 7 -t real`, { stdio: 'inherit' });

    const stat = await fs.stat(path.join(outDir, 'M', 'RC-M-007.json'));
    expect(stat.isFile()).toBe(true);

    await fs.rm(tmp, { recursive: true, force: true });
  }, 60000);

  test('auto-increment via -a when folder exists', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-stdin-'));
    const outDir = path.join(tmp, 'synthetic_cases');
    const rdir = path.join(outDir, 'R');
    await fs.mkdir(rdir, { recursive: true });
    await fs.writeFile(path.join(rdir, 'SC-R-001.json'), '{}');
    await fs.writeFile(path.join(rdir, 'SC-R-002.json'), '{}');

    const cmd = `node -r ts-node/register scripts/new-case-template.ts -o "${outDir}" -l R -a`;
    execSync(cmd, { stdio: 'inherit' });

    const expected = path.join(rdir, 'SC-R-003.json');
    const stat = await fs.stat(expected);
    expect(stat.isFile()).toBe(true);

    await fs.rm(tmp, { recursive: true, force: true });
  }, 60000);
});
