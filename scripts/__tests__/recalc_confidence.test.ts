import { mapConfidence, RecalcConfidence } from '../recalc_confidence';
import fs from 'fs';
import path from 'path';
import os from 'os';

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
    const res = await new RecalcConfidence().recalc(tmp, false, 0.6);
    expect(res.count).toBeGreaterThan(0);
    const out = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    const e = out.legal_intent_logs.MANIPULATION[0];
    expect(typeof e.confidence_raw).toBe('number');
    expect(e.confidence).toBeGreaterThanOrEqual(0.6);
    expect(typeof e.decision).toBe('string');
    expect(Array.isArray(e.decision_reasons)).toBe(true);
    expect(e.confidence_raw).toBe(0.2);
  });

  test('preserveExisting prevents changes when flag set', async () => {
    const payload = { legal_intent_logs: { MANIPULATION: [ { case_id: 'T-2', category: 'manipulation', prompts: [], confidence: 0.9, signal_ids: ['s1'] } ] } };
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    const res = await new RecalcConfidence().recalc(tmp, true, 0.6);
    expect(res.count).toBe(0);
    const out = JSON.parse(fs.readFileSync(tmp, 'utf8'));
    const e = out.legal_intent_logs.MANIPULATION[0];
    expect(e.confidence).toBe(0.9);
    expect(typeof e.confidence_raw).toBe('undefined');
    expect(typeof e.decision).toBe('undefined');
  });
});

describe('RecalcConfidence fallback signal_ids', () => {
  test('uses generated signal_ids when missing and updates confidence', async () => {
    // Case A: no signal_ids, behavior unchanged (use triggers)
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-recalc-'));
    const filePathA = path.join(tmpA, 'C-A.json');
    const sampleA = { case_id: 'C-A', category: 'access', scenarios: [ { triggers: ['urgency'] } ] };
    fs.writeFileSync(filePathA, JSON.stringify(sampleA, null, 2), 'utf8');
    const r = new RecalcConfidence();
    const resA = await r.recalc(filePathA, false, 0.5);
    expect(resA).toBeTruthy();
    const updatedA = JSON.parse(fs.readFileSync(filePathA, 'utf8'));
    expect(typeof updatedA.confidence).toBe('number');

    // Case B: mapped signal_id -> triggers should be expanded and affect confidence
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-recalc-'));
    const cfgDir = path.join(tmpB, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    // create minimal mapping: SIG-MAP -> ['urgency']
    fs.writeFileSync(path.join(cfgDir, 'signal-mapping.json'), JSON.stringify({ signals: { 'SIG-MAP': ['urgency'] } }, null, 2), 'utf8');
    const filePathB = path.join(tmpB, 'C-B.json');
    const sampleB = { case_id: 'C-B', category: 'access', scenarios: [], signal_ids: ['SIG-MAP'] };
    fs.writeFileSync(filePathB, JSON.stringify(sampleB, null, 2), 'utf8');
    // run recalc with CASES_DIR not needed; call recalc directly
    const r2 = new RecalcConfidence();
    const resB = await r2.recalc(filePathB, false, 0.5);
    expect(resB).toBeTruthy();
    const updatedB = JSON.parse(fs.readFileSync(filePathB, 'utf8'));
    expect(typeof updatedB.confidence).toBe('number');
    // should be >= base for access
    expect(updatedB.confidence).toBeGreaterThanOrEqual(0.95);

    // Case C: unmapped signal_id uses SIGNAL_ID_WEIGHT fallback
    const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-recalc-'));
    const filePathC = path.join(tmpC, 'C-C.json');
    const sampleC = { case_id: 'C-C', category: 'access', scenarios: [], signal_ids: ['SIG-UNKNOWN'] };
    fs.writeFileSync(filePathC, JSON.stringify(sampleC, null, 2), 'utf8');
    const r3 = new RecalcConfidence();
    const resC = await r3.recalc(filePathC, false, 0.5);
    expect(resC).toBeTruthy();
    const updatedC = JSON.parse(fs.readFileSync(filePathC, 'utf8'));
    expect(typeof updatedC.confidence).toBe('number');
    expect(updatedC.confidence).toBeGreaterThanOrEqual(0.51);

    // cleanup
    try { fs.rmSync(tmpA, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(tmpB, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(tmpC, { recursive: true, force: true }); } catch (e) {}
  });
});
