type AnyObj = { [k: string]: any };

/**
 * reorderCaseKeys
 * Центральная утилита для формирования канонического порядка полей в per-case JSON.
 * Порядок:
 *  case_id, category, confidence_raw, scenarios, suggested_action, legal_risk,
 *  behavioral_patterns, cross_check, confidence, deception_threshold, ...rest
 */
export function reorderCaseKeys(obj: AnyObj): AnyObj {
  const ordered: AnyObj = {};
  const add = (k: string, v: any) => { if (typeof v !== 'undefined') ordered[k] = v; };
  add('case_id', obj.case_id);
  add('category', obj.category);
  add('confidence_raw', obj.confidence_raw);
  add('scenarios', obj.scenarios);
  add('suggested_action', obj.suggested_action);
  add('legal_risk', obj.legal_risk);
  add('behavioral_patterns', obj.behavioral_patterns);
  add('cross_check', obj.cross_check);
  add('confidence', obj.confidence);
  add('deception_threshold', obj.deception_threshold);
  for (const k of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(ordered, k)) ordered[k] = obj[k];
  return ordered;
}
