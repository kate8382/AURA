import { NewCaseTemplate } from '../new-case-template';

test('createTemplate returns required keys and types', () => {
  const tpl = new NewCaseTemplate().createTemplate('TEST-1');
  expect(tpl).toHaveProperty('case_id', 'TEST-1');
  expect(typeof tpl.category).toBe('string');
  expect(Array.isArray(tpl.scenarios)).toBe(true);
  expect(typeof tpl.confidence).toBe('number');
  expect(tpl.legal_risk).toBeDefined();
  expect(tpl.behavioral_patterns).toBeDefined();
  expect(tpl.cross_check).toBeDefined();
  expect(tpl.deception_threshold).toBeDefined();
});
