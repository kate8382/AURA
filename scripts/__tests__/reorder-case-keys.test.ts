import { reorderCaseKeys } from '../utils';

describe('reorderCaseKeys', () => {
  test('keeps provenance, negative_labels and declared_shape in schema order', () => {
    const input = {
      confidence: 0.5,
      declared_shape: { operation_type: 'system_prompt_extraction' },
      negative_labels: { status: 'unknown' },
      provenance: { source_id: 'deepset-prompt-injections' },
      scenarios: [],
      signal_ids: [],
      category: 'c',
      domain: 'manipulation',
      case_id: 'RC-M-001',
      suggested_action: 'cross_check',
      cross_check: {},
      deception_threshold: {},
      decision_reasons: ['x'],
      confidence_raw: 1,
      decision: 'pending',
    };
    const keys = Object.keys(reorderCaseKeys(input));
    expect(keys).toEqual([
      'case_id', 'domain', 'category', 'provenance', 'signal_ids', 'scenarios',
      'negative_labels', 'declared_shape', 'suggested_action', 'cross_check',
      'deception_threshold', 'confidence', 'decision', 'confidence_raw', 'decision_reasons',
    ]);
  });

  test('unknown keys are appended after canonical keys', () => {
    const keys = Object.keys(reorderCaseKeys({ case_id: 'SC-M-001', custom_field: 1, domain: 'manipulation' }));
    expect(keys).toEqual(['case_id', 'domain', 'custom_field']);
  });

  test('"__proto__" input key is kept as own data and does not change the prototype', () => {
    const input = JSON.parse('{"case_id":"X-1","__proto__":{"polluted":true}}');
    const out = reorderCaseKeys(input);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(Object.keys(out)).toEqual(['case_id', '__proto__']);
  });
});
