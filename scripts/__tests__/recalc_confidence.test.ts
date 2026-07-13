import { mapConfidence, recalc, PROMPT_BASE } from '../recalc_confidence';
import fs from 'fs';
import path from 'path';

describe('mapConfidence', () => {
  test('default base', () => {
    expect(mapConfidence('', 1)).toBeCloseTo(0.75);
  });
  test('harass maps to 0.9', () => {
    expect(mapConfidence('harass', 1)).toBeCloseTo(0.9);
  });
  test('access maps to 0.95', () => {
    expect(mapConfidence('unauthorized_access', 1)).toBeCloseTo(0.95);
  });
  test('boost applied and capped', () => {
    // fraud base 0.9, signalCount 3 -> boost 0.04 -> 0.94
    expect(mapConfidence('fraud', 3)).toBeCloseTo(0.94);
    // many signals should cap at +0.05
    expect(mapConfidence('access', 10)).toBeCloseTo(1.0);
  });
});

describe('recalc', () => {
  const tmp = path.resolve(__dirname, 'tmp_recalc.json');
  afterEach(() => {
    try { fs.unlinkSync(tmp); } catch (e) {}
  });

  test('recalc writes new confidence and preserves raw when absent', async () => {
    const payload = { legal_intent_logs: { MANIPULATION: [ { case_id: 'T-1', category: 'manipulation', prompts: [], confidence: 0.2, signal_ids: ['s1','s2'] } ] } };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    const res = await recalc(tmp, false, 0.6);
    expect(res.count).toBeGreaterThan(0);
    const out = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    const e = out.legal_intent_logs.MANIPULATION[0];
    expect(typeof e.confidence_raw).toBe('number');
    expect(e.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test('preserveExisting prevents changes when flag set', async () => {
    const payload = { legal_intent_logs: { MANIPULATION: [ { case_id: 'T-2', category: 'manipulation', prompts: [], confidence: 0.9, signal_ids: ['s1'] } ] } };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    const res = await recalc(tmp, true, 0.6);
    expect(res.count).toBe(0);
    const out = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    const e = out.legal_intent_logs.MANIPULATION[0];
    expect(e.confidence).toBe(0.9);
    expect(typeof e.confidence_raw).toBe('undefined');
  });
});
