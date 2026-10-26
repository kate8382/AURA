export type TrialShape = {
  operation_type?: string;
  signal_ids?: string[];
};

export type TrialNegativeLabel = {
  status?: 'confirmed_negative' | 'benign' | 'unknown';
  reason?: string;
  source?: string;
};

export function sameShape(candidate: { declared_shape?: TrialShape } | null | undefined, baseline: { declared_shape?: TrialShape } | null | undefined): boolean {
  const a = candidate?.declared_shape ?? {};
  const b = baseline?.declared_shape ?? {};

  const aKey = JSON.stringify({ operation_type: a.operation_type ?? '', signal_ids: [...(a.signal_ids ?? [])].sort() });
  const bKey = JSON.stringify({ operation_type: b.operation_type ?? '', signal_ids: [...(b.signal_ids ?? [])].sort() });
  return aKey === bKey;
}

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
  const fpr = denominator === 0 ? 0 : false_positives / denominator;

  return {
    evaluated: denominator,
    false_positives,
    true_negatives,
    fpr
  };
}
