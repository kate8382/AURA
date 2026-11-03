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
});
