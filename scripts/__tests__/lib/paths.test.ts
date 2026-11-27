import fs from 'fs';
import path from 'path';
import { REPO_ROOT, CONFIG_DIR, SCHEMAS_DIR, SYNTHETIC_CASES_DIR, REAL_CASES_DIR } from '../../lib/paths';

describe('lib/paths', () => {
  it('resolves REPO_ROOT to the repository root', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'package.json'))).toBe(true);
  });

  it.each([
    ['CONFIG_DIR', CONFIG_DIR],
    ['SCHEMAS_DIR', SCHEMAS_DIR],
    ['SYNTHETIC_CASES_DIR', SYNTHETIC_CASES_DIR],
    ['REAL_CASES_DIR', REAL_CASES_DIR],
  ])('%s is a direct child of REPO_ROOT', (_name, dir) => {
    expect(path.dirname(dir)).toBe(REPO_ROOT);
  });
});
