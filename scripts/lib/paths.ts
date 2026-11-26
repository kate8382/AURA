import path from 'path';

// This file lives at scripts/lib/, so the fixed depth below reaches the repository root.
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

export const CONFIG_DIR = path.join(REPO_ROOT, 'config');
export const SCHEMAS_DIR = path.join(REPO_ROOT, 'schemas');
export const SYNTHETIC_CASES_DIR = path.join(REPO_ROOT, 'synthetic_cases');
export const REAL_CASES_DIR = path.join(REPO_ROOT, 'real_cases');
