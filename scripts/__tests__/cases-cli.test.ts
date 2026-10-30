import path from 'path';
import { assertRealWriteAllowed, getDirOption, isRealCasesPath, resolveCasesDir } from '../lib/cases-cli';

const base = path.resolve(__dirname, '..', '..');

describe('cases-cli: --dir / CASES_DIR resolution', () => {
  test('getDirOption reads --dir and -d', () => {
    expect(getDirOption(['--dir', 'real_cases'])).toBe('real_cases');
    expect(getDirOption(['-d', 'x'])).toBe('x');
    expect(getDirOption(['--other'])).toBeUndefined();
  });

  test('getDirOption throws when --dir has no value', () => {
    expect(() => getDirOption(['--dir'])).toThrow(/requires a directory path/);
    expect(() => getDirOption(['--dir', '--dry-run'])).toThrow(/requires a directory path/);
  });

  test('--dir has priority over CASES_DIR', () => {
    const dir = resolveCasesDir(['--dir', 'real_cases'], base, { CASES_DIR: 'other' });
    expect(dir).toBe(path.resolve(base, 'real_cases'));
  });

  test('CASES_DIR is used when --dir is absent', () => {
    expect(resolveCasesDir([], base, { CASES_DIR: 'other' })).toBe(path.resolve(base, 'other'));
  });

  test('defaults to synthetic_cases when neither is set (backward compatible)', () => {
    expect(resolveCasesDir([], base, {})).toBe(path.resolve(base, 'synthetic_cases'));
  });
});

describe('cases-cli: real_cases write guard', () => {
  const realDir = path.resolve(base, 'real_cases', 'ACCESS');
  const synthDir = path.resolve(base, 'synthetic_cases');

  test('detects real_cases paths', () => {
    expect(isRealCasesPath(realDir)).toBe(true);
    expect(isRealCasesPath(synthDir)).toBe(false);
  });

  test('blocks writes into real_cases without a flag', () => {
    expect(() => assertRealWriteAllowed(realDir, [])).toThrow(/--allow-real-write/);
  });

  test('allows dry runs into real_cases', () => {
    expect(() => assertRealWriteAllowed(realDir, ['--dry-run'])).not.toThrow();
  });

  test('allows writes into real_cases with --allow-real-write', () => {
    expect(() => assertRealWriteAllowed(realDir, ['--allow-real-write'])).not.toThrow();
  });

  test('never blocks synthetic_cases writes', () => {
    expect(() => assertRealWriteAllowed(synthDir, [])).not.toThrow();
  });
});
