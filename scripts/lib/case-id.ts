import path from 'path';

export type CaseKind = 'synthetic' | 'real';

// SC-<domain letter>-<sequence>, for example SC-A-001. RC is the same scheme for real cases.
export const CASE_PREFIX: Record<CaseKind, string> = {
  synthetic: 'SC',
  real: 'RC'
};

export const CASE_ID_PATTERN = /^(SC|RC)-[A-Z]-\d{3,}$/;

// Domain letter in the case ID -> value of the top-level "domain" field and the folder name.
export const DOMAIN_BY_LETTER: Record<string, string> = {
  A: 'access',
  F: 'fraud',
  M: 'manipulation'
};

export function isRealCasePath(p: string): boolean {
  return path.resolve(p).split(path.sep).includes('real_cases');
}
