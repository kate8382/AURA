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
  M: 'manipulation',
  B: 'benign'
};

export function isRealCasePath(p: string): boolean {
  return path.resolve(p).split(path.sep).includes('real_cases');
}

// Splits a case ID that matches CASE_ID_PATTERN into its prefix and domain letter; null otherwise.
export function parseCaseId(caseId: string): { prefix: string; letter: string } | null {
  const m = CASE_ID_PATTERN.exec(caseId);
  return m ? { prefix: m[1], letter: caseId.split('-')[1] } : null;
}
