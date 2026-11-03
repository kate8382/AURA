type AnyObj = { [k: string]: any };

/**
 * reorderCaseKeys
 * Центральная утилита для формирования канонического порядка полей в per-case JSON.
 * Порядок совпадает с порядком в schemas/per-case-schema.json; динамические поля идут последними.
 */
export function reorderCaseKeys(obj: AnyObj): AnyObj {
  const ordered: AnyObj = {};
  const add = (k: string, v: any) => { if (typeof v !== 'undefined') ordered[k] = v; };
  add('case_id', obj.case_id);
  add('domain', obj.domain);
  add('category', obj.category);
  add('provenance', obj.provenance);
  add('signal_ids', obj.signal_ids);
  add('scenarios', obj.scenarios);
  add('negative_labels', obj.negative_labels);
  add('declared_shape', obj.declared_shape);
  add('suggested_action', obj.suggested_action);
  add('legal_risk', obj.legal_risk);
  add('behavioral_patterns', obj.behavioral_patterns);
  add('cross_check', obj.cross_check);
  add('deception_threshold', obj.deception_threshold);
  add('confidence', obj.confidence);
  add('decision', obj.decision);
  add('confidence_raw', obj.confidence_raw);
  add('decision_reasons', obj.decision_reasons);
  for (const k of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(ordered, k)) ordered[k] = obj[k];
  return ordered;
}

// deriveSignalId: deterministic SID from a normalized trigger string
export function deriveSignalId(trigger: string): string {
  if (!trigger || typeof trigger !== 'string') return '';
  // uppercase, replace non-alphanumeric with hyphens, collapse hyphens
  let s = trigger.trim().toUpperCase();
  s = s.replace(/[^A-Z0-9]+/g, '-');
  s = s.replace(/(^-|-$)+/g, '');
  s = s.replace(/-+/g, '-');
  return `SIG-TRIG-${s}`;
}
