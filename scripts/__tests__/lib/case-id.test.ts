import path from 'path';
import { parseCaseId, isRealCasePath } from '../../lib/case-id';

describe('lib/case-id', () => {
  describe('parseCaseId', () => {
    it('splits a valid synthetic or real ID into prefix and domain letter', () => {
      expect(parseCaseId('SC-A-001')).toEqual({ prefix: 'SC', letter: 'A' });
      expect(parseCaseId('RC-F-1234')).toEqual({ prefix: 'RC', letter: 'F' });
    });

    it('returns null for IDs that do not match CASE_ID_PATTERN', () => {
      expect(parseCaseId('SC-A-01')).toBeNull();
      expect(parseCaseId('XX-A-001')).toBeNull();
      expect(parseCaseId('SC-a-001')).toBeNull();
    });
  });

  describe('isRealCasePath', () => {
    it('is true for a path inside real_cases/', () => {
      expect(isRealCasePath(path.join('repo', 'real_cases', 'access', 'RC-A-001.json'))).toBe(true);
    });

    it('is false for synthetic paths and for folder names that only contain real_cases', () => {
      expect(isRealCasePath(path.join('repo', 'synthetic_cases', 'access', 'SC-A-001.json'))).toBe(false);
      expect(isRealCasePath(path.join('repo', 'real_cases_backup', 'RC-A-001.json'))).toBe(false);
    });
  });
});
