import path from 'path';
import { REAL_CASES_DIR as REAL_CASES_PATH } from './paths';

export const DEFAULT_CASES_DIR = 'synthetic_cases';
/** Directory name (path segment) of real cases; derived from the repo-root path in `paths.ts`. */
export const REAL_CASES_NAME = path.basename(REAL_CASES_PATH);
export const BENIGN_CASES_DIR = 'benign_cases';
/** Safe cases that need clarifying questions; they stay `pending` and are excluded from attack weights. */
export const BENIGN_CLARIFY_DIR = 'clarify';

/** Returns the value of `--dir` / `-d`, or undefined when the option is absent. */
export function getDirOption(argv: string[]): string | undefined {
  const i = argv.findIndex((a) => a === '--dir' || a === '-d');
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('-')) throw new Error(`${argv[i]} requires a directory path`);
  return value;
}

/**
 * Resolves the cases directory with the priority: `--dir` > `CASES_DIR` env > `synthetic_cases`.
 * Relative paths are resolved against `baseDir`.
 */
export function resolveCasesDir(argv: string[], baseDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = getDirOption(argv) || env.CASES_DIR || DEFAULT_CASES_DIR;
  return path.resolve(baseDir, dir);
}

export function isRealCasesPath(p: string): boolean {
  return path.resolve(p).split(path.sep).includes(REAL_CASES_NAME);
}

/** Real data folders: real_cases/, benign_cases/real/ and benign_cases/clarify/real/. */
export function isProtectedRealPath(p: string): boolean {
  if (isRealCasesPath(p)) return true;
  const parts = path.resolve(p).split(path.sep);
  const i = parts.indexOf(BENIGN_CASES_DIR);
  if (i === -1) return false;
  return parts[i + 1] === 'real' || (parts[i + 1] === BENIGN_CLARIFY_DIR && parts[i + 2] === 'real');
}

/**
 * Blocks writes into real_cases/ and benign_cases/real/ unless `--allow-real-write` is passed.
 * Dry runs never write, so they are always allowed.
 */
export function assertRealWriteAllowed(target: string, argv: string[]): void {
  if (!isProtectedRealPath(target)) return;
  if (argv.includes('--dry-run') || argv.includes('--allow-real-write')) return;
  throw new Error(
    `Refusing to write into ${REAL_CASES_NAME}/ without --allow-real-write (target: ${target}). Use --dry-run to preview.`
  );
}
