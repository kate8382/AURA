import path from 'path';

export type CaseKind = 'synthetic' | 'real';

// SC-<domain letter>-<sequence>, for example SC-A-001. RC is the same scheme for real cases.
export const CASE_PREFIX: Record<CaseKind, string> = {
  synthetic: 'SC',
  real: 'RC'
};

export const CASE_ID_PATTERN = /^(SC|RC)-[A-Z]-\d{3,}$/;

export function isRealCasePath(p: string): boolean {
  return path.resolve(p).split(path.sep).includes('real_cases');
}
