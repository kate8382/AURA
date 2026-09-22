import fs from 'fs';
import path from 'path';
import os from 'os';
import PolicyEvaluator from '../policy/evaluateDecision';

function writeCfg(tmpDir: string, cfg: any) {
  const p = path.join(tmpDir, 'policy.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return p;
}

const tmpConfig = (name: string, obj: any) => {
  const p = path.resolve(__dirname, '..', '..', 'tmp', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  return p;
};

describe('PolicyEvaluator', () => {
  test('returns pending when cross_check answers incomplete', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-policy-'));
    const cfgPath = writeCfg(tmp, { review_threshold: 0.5, block_threshold: 0.9, veto_triggers: [] });
    const p = new PolicyEvaluator(cfgPath);
    const c: any = { cross_check: { questions: [{}, {}], history: [{}] }, confidence: 0.2 };
    const r = p.evaluate(c);
    expect(r.decision).toBe('pending');
  });

  test('veto trigger causes block', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-policy-'));
    const cfgPath = writeCfg(tmp, { review_threshold: 0.5, block_threshold: 0.9, veto_triggers: ['vetoed'] });
    const p = new PolicyEvaluator(cfgPath);
    const c: any = { scenarios: [{ triggers: ['vetoed'] }], confidence: 0.1 };
    const r = p.evaluate(c);
    expect(r.decision).toBe('block');
  });

  test('confidence >= block_threshold leads to block', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-policy-'));
    const cfgPath = writeCfg(tmp, { review_threshold: 0.4, block_threshold: 0.8, veto_triggers: [] });
    const p = new PolicyEvaluator(cfgPath);
    const c: any = { confidence: 0.85 };
    const r = p.evaluate(c);
    expect(r.decision).toBe('block');
  });

  test('confidence >= review_threshold leads to review', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-policy-'));
    const cfgPath = writeCfg(tmp, { review_threshold: 0.4, block_threshold: 0.9, veto_triggers: [] });
    const p = new PolicyEvaluator(cfgPath);
    const c: any = { confidence: 0.5 };
    const r = p.evaluate(c);
    expect(r.decision).toBe('review');
  });

  test('evasion attempts escalate to block', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-policy-'));
    const cfgPath = writeCfg(tmp, { review_threshold: 0.4, block_threshold: 0.9, max_retries_before_block: 2 });
    const p = new PolicyEvaluator(cfgPath);
    const c: any = { cross_check: { history: [] }, cross_check_evasion: undefined, confidence: 0.2 };
    // The evaluator checks `cross_check.evasion_attempts` or `evasion_attempts` on top level
    const c2: any = { evasion_attempts: 3, confidence: 0.2 };
    const r = p.evaluate(c2);
    expect(r.decision).toBe('block');
  });

  // Auditor repro tests (moved from evaluateDecision.test.ts)
  test('throws when policy config is missing (no silent fallback)', () => {
    expect(() => new (PolicyEvaluator as any)('/path/that/does/not/exist.json')).toThrow();
  });

  test('veto triggers should block even when cross-check questions are pending', () => {
    const cfgPath = tmpConfig('policy-veto.json', { veto_triggers: ['bad_trigger'], review_threshold: 0.6, block_threshold: 0.9, failed_checks_to_review: 1, failed_checks_to_block: 3, max_retries_before_block: 3, override_on_failed_requirements: 'review' });
    const P = new (PolicyEvaluator as any)(cfgPath);
    const c = {
      scenarios: [{ triggers: ['bad_trigger'] }],
      cross_check: { questions: ['q1'], history: [] },
      confidence: 0.1
    };
    const r = P.evaluate(c);
    expect(r.decision).toBe('block');
  });

  test('evasion escalation should block before review threshold prevents it', () => {
    const cfgPath = tmpConfig('policy-evasion.json', { max_retries_before_block: 2, review_threshold: 0.5, block_threshold: 0.9, failed_checks_to_review: 1, failed_checks_to_block: 3, veto_triggers: [], override_on_failed_requirements: 'review' });
    const P = new (PolicyEvaluator as any)(cfgPath);
    const c = { confidence: 0.6, cross_check: { evasion_attempts: 3 }, scenarios: [] };
    const r = P.evaluate(c);
    expect(r.decision).toBe('block');
  });

  test('numeric zero config values must be respected (not swallowed by ||)', () => {
    const cfgPath = tmpConfig('policy-zero.json', { failed_checks_to_block: 0, failed_checks_to_review: 1, review_threshold: 0.6, block_threshold: 0.9, max_retries_before_block: 3, veto_triggers: [], override_on_failed_requirements: 'review' });
    const P = new (PolicyEvaluator as any)(cfgPath);
    const c = { scenarios: [], cross_check: { history: [] }, confidence: 0.1 };
    // with failed_checks_to_block: 0, any failedReqs >= 0 should block — simulate zero failedReqs
    const r = P.evaluate(c);
    expect(r.decision).toBe('block');
  });
});
