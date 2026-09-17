import fs from 'fs';
import path from 'path';
import os from 'os';
import PolicyEvaluator from '../policy/evaluateDecision';

function writeCfg(tmpDir: string, cfg: any) {
  const p = path.join(tmpDir, 'policy.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2), 'utf8');
  return p;
}

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
});
