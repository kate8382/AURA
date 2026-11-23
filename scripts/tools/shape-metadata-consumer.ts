// helpers for negative labels
export type NegativeLabelStatus = 'confirmed_negative' | 'benign' | 'unknown';

// helpers for negative labels
export type NegativeLabel = {
  status: NegativeLabelStatus;
  reason?: string;
  source?: string;
  annotation?: string;
};

// helper for negative label
export function getNegativeLabel(value: unknown): NegativeLabel {
  if (!value || typeof value !== 'object') return { status: 'unknown' };

  const record = value as Record<string, unknown>;
  const negative = record.negative_labels as Record<string, unknown> | undefined;
  const annotation = typeof record.annotation === 'string' ? record.annotation : undefined;
  const status =
    negative && typeof negative.status === 'string' && ['confirmed_negative', 'benign', 'unknown'].includes(negative.status)
      ? (negative.status as NegativeLabelStatus)
      : 'unknown';

  const result: NegativeLabel = { status };
  if (negative && typeof negative.reason === 'string') result.reason = negative.reason;
  if (negative && typeof negative.source === 'string') result.source = negative.source;
  if (annotation) result.annotation = annotation;
  return result;
}
