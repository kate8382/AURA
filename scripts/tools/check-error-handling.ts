import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const repoRoot = path.resolve(__dirname, '..', '..');
const BEST_EFFORT = /best-effort|cleanup only|fall ?back|fallthrough/i;

export interface SilentCatch { line: number; text: string }

/** Finds empty or comment-only catch blocks that do not say why ignoring the error is intended. */
export function findSilentCatches(source: string): SilentCatch[] {
  const found: SilentCatch[] = [];
  const pattern = /catch\s*(?:\([^)]*\))?\s*\{((?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*)\}/g;
  for (let m = pattern.exec(source); m; m = pattern.exec(source)) {
    if (BEST_EFFORT.test(m[1])) continue;
    const lineStart = source.lastIndexOf('\n', m.index - 1);
    const prevLineStart = source.lastIndexOf('\n', lineStart - 1);
    if (BEST_EFFORT.test(source.slice(Math.max(0, prevLineStart), m.index))) continue; // marker on this or the previous line
    found.push({ line: source.slice(0, m.index).split('\n').length, text: m[0].replace(/\s+/g, ' ') });
  }
  return found;
}

// Recursively lists all TypeScript and JavaScript source files in a directory, excluding __tests__ and node_modules.
function listSources(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== '__tests__' && ent.name !== 'node_modules') listSources(full, out);
    } else if (/\.(ts|js)$/.test(ent.name)) out.push(full);
  }
  return out;
}

// Checks all source files under the scripts directory for silent catch blocks without a best-effort note.
function checkSilentCatches(): number {
  let problems = 0;
  for (const file of listSources(path.join(repoRoot, 'scripts'))) {
    for (const hit of findSilentCatches(fs.readFileSync(file, 'utf8'))) {
      console.error(`[ERROR] silent catch without a best-effort note file=${path.relative(repoRoot, file)} line=${hit.line}`);
      problems += 1;
    }
  }
  return problems;
}

import { generateSignalHash } from './generate-signal-hash';

// Checks that the signal catalog hash is up to date.
function checkSignalHash(): number {
  let problems = 0;
  const mappingPath = path.join(repoRoot, 'config', 'signal-mapping.json');
  const metaPath = path.join(repoRoot, 'config', 'signal-catalog-meta.json');

  if (!fs.existsSync(metaPath)) {
    console.error(`[ERROR] signal catalog meta missing file=${metaPath} (run npm run gen:signal-hash)`);
    return 1;
  }

  const currentHash = generateSignalHash(mappingPath).sha256;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.sha256 !== currentHash) {
      console.error(`[ERROR] signal catalog hash mismatch file=${metaPath} expected=${currentHash} actual=${meta.sha256} (run npm run gen:signal-hash)`);
      problems += 1;
    }
  } catch (err) {
    console.error(`[ERROR] failed to read signal catalog meta file=${metaPath}`);
    problems += 1;
  }
  return problems;
}

// Defines the sequence of pipeline steps to run for error-handling checks.
const PIPELINE: Array<{ name: string; args: string[] }> = [
  { name: 'validate', args: ['scripts/validate-percases.ts', 'public_cases', '--dry-run'] },
  { name: 'normalize --dry-run', args: ['scripts/normalize-percases.ts', 'public_cases', '--dry-run', '--extract-triggers', '--apply-signal-ids'] },
  { name: 'recalc --dry-run', args: ['scripts/recalc_confidence.ts', '--dir', 'public_cases', '--dry-run'] }
];

// Determines if the given output text contains any error messages.
export function outputHasError(text: string): boolean {
  return /\[ERROR\]|"level":"error"|UnhandledPromiseRejection|Unhandled promise rejection/.test(text);
}

// Checks the entire error-handling pipeline by running each step and capturing errors.
function checkPipeline(): number {
  let problems = 0;
  for (const step of PIPELINE) {
    const res = spawnSync(process.execPath, ['-r', 'ts-node/register', ...step.args], { cwd: repoRoot, encoding: 'utf8' });
    const output = `${res.stdout}\n${res.stderr}`;
    if (res.status !== 0 || outputHasError(output)) {
      console.error(`[ERROR] pipeline step failed step="${step.name}" exit=${res.status}`);
      console.error(output.trim());
      problems += 1;
    } else {
      console.log(`[INFO] pipeline step ok step="${step.name}"`);
    }
  }
  return problems;
}

if (require.main === module) {
  const problems = checkSilentCatches() + checkPipeline() + checkSignalHash();
  if (problems > 0) {
    console.error(`[ERROR] error-handling check failed problems=${problems}`);
    process.exitCode = 1;
  } else {
    console.log('[INFO] error-handling check passed');
  }
}
