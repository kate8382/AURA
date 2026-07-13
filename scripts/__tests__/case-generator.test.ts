// Basic unit tests for case-generator
import * as cg from '../../case-generator';

test('generateCase returns expected refusal/redirect', () => {
  const c = cg.generateCase('Financial', 'Academic', 'semantic_slippage');
  expect(typeof c.expectedRefusal).toBe('string');
  expect(c.expectedRefusal.length).toBeGreaterThan(0);
  expect(typeof c.expectedRedirect).toBe('string');
  expect(c.expectedRedirect.length).toBeGreaterThan(0);
});

test('generateBatch returns correct count', () => {
  const batch = cg.generateBatch(3);
  expect(Array.isArray(batch)).toBe(true);
  expect(batch.length).toBe(3);
});
