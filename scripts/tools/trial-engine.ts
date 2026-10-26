import fs from 'fs/promises';
import path from 'path';
import { logError, logWarn, runCli } from '../logger';

export type TrialShape = {
  operation_type?: string;
  signal_ids?: string[];
};

// Negative label info for trials
export type TrialNegativeLabel = {
  status?: 'confirmed_negative' | 'benign' | 'unknown';
  reason?: string;
  source?: string;
};

// Fail closed: a missing shape or empty operation_type never matches.
export function sameShape(candidate: { declared_shape?: TrialShape } | null | undefined, baseline: { declared_shape?: TrialShape } | null | undefined): boolean {
  const a = candidate?.declared_shape;
  const b = baseline?.declared_shape;
  if (!a?.operation_type?.trim() || !b?.operation_type?.trim()) return false;

  const key = (shape: TrialShape) => JSON.stringify({ operation_type: shape.operation_type, signal_ids: [...(shape.signal_ids ?? [])].sort() });
  return key(a) === key(b);
}

// Calculate false positive rate for trials
export function calculateFalsePositiveRate(rows: Array<{ isPositive?: boolean; negative_labels?: TrialNegativeLabel }>) {
  const evaluated = rows.filter((row) => {
    const status = row.negative_labels?.status;
    return status === 'confirmed_negative' || status === 'benign' || status === 'unknown';
  });

  let false_positives = 0;
  let true_negatives = 0;
  for (const row of evaluated) {
    const status = row.negative_labels?.status;
    if (status === 'confirmed_negative' || status === 'benign') {
      if (row.isPositive === true) false_positives += 1;
      else true_negatives += 1;
    }
  }

  const denominator = false_positives + true_negatives;
  // null means no labelled negatives: insufficient data, not a 0% rate.
  const fpr = denominator === 0 ? null : false_positives / denominator;

  return {
    evaluated: denominator,
    false_positives,
    true_negatives,
    fpr
  };
}

// Recursively collect JSON file paths under a directory.
async function listJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await listJsonFiles(full)));
    else if (ent.isFile() && ent.name.endsWith('.json')) out.push(full);
  }
  return out;
}

// Usage: trial-engine [dir] [--signal <signal_id> --baseline <case.json>].
// Fail closed: with --signal, only cases whose declared_shape matches the baseline shape are evaluated.
async function main(argv: string[]): Promise<number> {
  const signalIdx = argv.indexOf('--signal');
  const baselineIdx = argv.indexOf('--baseline');
  const signal = signalIdx >= 0 ? argv[signalIdx + 1] : undefined;
  const baselineArg = baselineIdx >= 0 ? argv[baselineIdx + 1] : undefined;
  const positional = argv.filter((arg, i) => !arg.startsWith('--') && i !== signalIdx + 1 && i !== baselineIdx + 1);
  const dir = path.resolve(process.cwd(), positional[0] ?? 'public_cases');

  if (signal !== undefined && baselineArg === undefined) {
    logError('--signal requires --baseline for the same_shape gate');
    return 1;
  }
  const baseline = baselineArg !== undefined
    ? JSON.parse(await fs.readFile(path.resolve(process.cwd(), baselineArg), 'utf8'))
    : undefined;

  const summary = {
    cases: 0,
    declared_shape: 0,
    shape_mismatch: 0,
    negative_labels: { confirmed_negative: 0, benign: 0, unknown: 0, missing: 0 }
  };
  const rows: Array<{ isPositive?: boolean; negative_labels?: TrialNegativeLabel }> = [];

  for (const file of await listJsonFiles(dir)) {
    let obj: any;
    try {
      obj = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      logError('cannot read case file', { file, error: err });
      continue;
    }
    if (!obj || typeof obj.case_id !== 'string') continue;

    summary.cases += 1;
    if (obj.declared_shape) summary.declared_shape += 1;
    const status = obj.negative_labels?.status as string | undefined;
    if (status === 'confirmed_negative' || status === 'benign' || status === 'unknown') summary.negative_labels[status] += 1;
    else summary.negative_labels.missing += 1;

    if (signal !== undefined && !sameShape(obj, baseline)) {
      summary.shape_mismatch += 1;
      logWarn('case excluded: declared_shape does not match baseline', { file, case_id: obj.case_id });
      continue;
    }

    rows.push({
      isPositive: signal !== undefined && Array.isArray(obj.signal_ids) && obj.signal_ids.includes(signal),
      negative_labels: obj.negative_labels
    });
  }

  const fpr = signal !== undefined ? calculateFalsePositiveRate(rows) : null;
  console.log(JSON.stringify({ dir, signal: signal ?? null, ...summary, fpr }, null, 2));
  return 0;
}

if (require.main === module) {
  runCli(() => main(process.argv.slice(2)));
}
