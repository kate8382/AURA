import { mapConfidence, RecalcConfidence } from '../recalc_confidence';
import CrossCheckAdapter from '../policy/crossCheckAdapter';
import * as configModule from '../config';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('RecalcConfidence.recalc writeCrossCheckAudit', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-recalc-audit-'));
    file = path.join(dir, 'SC-A-001.json');
    fs.writeFileSync(file, JSON.stringify({
      case_id: 'SC-A-001',
      category: 'access',
      confidence: 0.1,
      cross_check_audit: [{ id: 'q1', ok: false }]
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('strips cross_check_audit when writeCrossCheckAudit is false', async () => {
    const base = configModule.loadTriggerConfig();
    jest.spyOn(configModule, 'loadTriggerConfig').mockReturnValue({ ...base, writeCrossCheckAudit: false });
    await new RecalcConfidence().recalc(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).not.toHaveProperty('cross_check_audit');
  });

  test('keeps cross_check_audit when writeCrossCheckAudit is true', async () => {
    const base = configModule.loadTriggerConfig();
    jest.spyOn(configModule, 'loadTriggerConfig').mockReturnValue({ ...base, writeCrossCheckAudit: true });
    await new RecalcConfidence().recalc(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveProperty('cross_check_audit');
  });
});

describe('mapConfidence', () => {
  test('default base is PROMPT_BASE (presumption of innocence)', () => {
    expect(mapConfidence('', 1)).toBeCloseTo(0.0);
  });
  test('mapConfidence produces small boost when multiple signals present', () => {
    // with signalCount 3 -> boost = min(0.05, 0.02*(3-1)) = 0.04
    expect(mapConfidence('fraud', 3)).toBeCloseTo(0.04);
    // many signals should cap boost at 0.05
    expect(mapConfidence('any', 10)).toBeCloseTo(0.05);
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
    expect(e.confidence).toBeGreaterThanOrEqual(0);
    expect(typeof e.decision).toBe('string');
    expect(Array.isArray(e.decision_reasons)).toBe(true);
    // confidence_raw is now computed as the honest sum of evidence (audit value)
    expect(e.confidence_raw).toBeGreaterThanOrEqual(0);
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

  test('recalc persists updates after async cross-checks complete', async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'aura-recalc-crosscheck-')
    );
    const filePath = path.join(tmpDir, 'crosscheck.json');

    const payload = {
      case_id: 'T-CROSSCHECK',
      category: 'access',
      scenarios: [{ triggers: ['urgency'] }],
      confidence: 0.01,
      cross_check: {
        questions: [
          {
            id: 'cc-delay',
            title: 'Delayed check',
            type: 'boolean',
            evidence_weight: 0.1
          }
        ]
      }
    };

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');

    const adapter = CrossCheckAdapter;
    const originalEvaluate = adapter.evaluateCrossChecks;

    adapter.evaluateCrossChecks = async () => {
      await new Promise(resolve => setTimeout(resolve, 50));

      return {
        auditEntries: [
          {
            id: 'cc-delay',
            verifier: 'adapter:test-delay',
            result: true,
            ok: true,
            weight_applied: 0.1,
            ts: new Date().toISOString()
          }
        ],
        total_weight: 0.1,
        failed_requirements: [],
        decisionHints: {
          veto: false,
          require_manual_review: false,
          pending: false
        }
      };
    };

    try {
      const result = await new RecalcConfidence().recalc(
        filePath,
        false,
        0.0
      );

      expect(result.count).toBe(1);

      const out = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      expect(out.confidence).not.toBe(0.01);
      expect(out.confidence_raw).toBeGreaterThan(0);
      expect(out.cross_check_audit).toHaveLength(1);
      expect(out.cross_check_audit[0].id).toBe('cc-delay');
      expect(out.cross_check_audit[0].ok).toBe(true);
    } finally {
      adapter.evaluateCrossChecks = originalEvaluate;

      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {}
    }
  });
});

describe('RecalcConfidence cross_check edge cases', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-recalc-edge-'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeJson = (name: string, obj: unknown) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    return p;
  };
  const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

  test('empty cross_check.questions skips the adapter and writes no audit entries', async () => {
    const spy = jest.spyOn(CrossCheckAdapter, 'evaluateCrossChecks');
    const p = writeJson('C-E.json', { case_id: 'C-E', category: 'access', scenarios: [{ triggers: ['urgency'] }], cross_check: { questions: [] } });
    const res = await new RecalcConfidence().recalc(p);
    expect(spy).not.toHaveBeenCalled();
    expect(res.count).toBe(1);
    expect(readJson(p)).not.toHaveProperty('cross_check_audit');
  });

  test('a case without cross_check is recalculated with no audit entries', async () => {
    const p = writeJson('C-N.json', { case_id: 'C-N', category: 'access', scenarios: [] });
    const res = await new RecalcConfidence().recalc(p);
    expect(res.count).toBe(1);
    expect(readJson(p).confidence).toBe(0);
    expect(readJson(p)).not.toHaveProperty('cross_check_audit');
  });

  test('preserveExisting keeps prior confidence for a case without cross-check results', async () => {
    const p = writeJson('C-P.json', { case_id: 'C-P', category: 'access', scenarios: [{ triggers: ['urgency'] }], confidence: 0.3 });
    const res = await new RecalcConfidence().recalc(p, true, 0);
    expect(res.count).toBe(0);
    expect(readJson(p).confidence).toBe(0.3);
  });

  test('minFloor raises a computed confidence to the floor', async () => {
    const p = writeJson('C-F.json', { case_id: 'C-F', category: 'access', scenarios: [] });
    await new RecalcConfidence().recalc(p, false, 0.5);
    expect(readJson(p).confidence).toBe(0.5);
  });

  test('ignores malformed scenarios, non-string triggers and non-string signal_ids', async () => {
    const p = writeJson('C-M.json', { case_id: 'C-M', category: 'access', scenarios: [null, { triggers: ['Urgency', 5] }], signal_ids: [42, 'SIG-UNKNOWN'] });
    await new RecalcConfidence().recalc(p);
    const out = readJson(p);
    expect(out.confidence).toBeGreaterThan(0);
    expect(out.confidence_raw).toBeGreaterThan(0);
  });

  test('updates a case under a top-level category array', async () => {
    const p = writeJson('C-CAT.json', { ACCESS: [{ case_id: 'C-CAT-1', category: 'access', scenarios: [{ triggers: ['urgency'] }] }] });
    const res = await new RecalcConfidence().recalc(p);
    expect(res.count).toBe(1);
    expect(readJson(p).ACCESS[0].confidence).toBeGreaterThan(0);
  });

  test('updates case objects and arrays nested under arbitrary top-level keys', async () => {
    const p = writeJson('C-GEN.json', {
      single: { case_id: 'C-GEN-1', category: 'access', scenarios: [] },
      list: [{ case_id: 'C-GEN-2', category: 'access', scenarios: [] }, { note: 'no id' }],
      label: 'text'
    });
    const res = await new RecalcConfidence().recalc(p);
    expect(res.count).toBe(2);
  });

  test.each([
    ['access', 1.5],
    ['Espionage', 1.5],
    ['extortion', 1.3],
    ['fraud', 1.3],
    ['manipulation', 1.2],
    ['misc', 1.0],
    ['   ', 1.0]
  ])('category multiplier for %p is %p', (category, expected) => {
    expect(RecalcConfidence.getCategoryMultiplier(category)).toBe(expected);
  });
});

describe('RecalcConfidence run() CLI', () => {
  let dir: string;
  const savedArgv = process.argv;
  const savedMinFloor = process.env.MIN_FLOOR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-recalc-cli-'));
    delete process.env.MIN_FLOOR;
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = savedArgv;
    if (savedMinFloor === undefined) delete process.env.MIN_FLOOR;
    else process.env.MIN_FLOOR = savedMinFloor;
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const runWith = (...args: string[]) => {
    process.argv = ['node', 'recalc_confidence', ...args];
    return new RecalcConfidence().run();
  };
  const writeCase = (rel: string, obj: unknown) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    return p;
  };
  const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const withTriggers = (id: string) => ({ case_id: id, category: 'access', scenarios: [{ triggers: ['urgency'] }] });

  test('parseArgs reads flags and falls back to the default directory', () => {
    const rc = new RecalcConfidence();
    expect(rc.parseArgs(['-f', 'a.json', '--dry-run', '--preserve-existing'])).toEqual({ file: 'a.json', dryRun: true, preserve: true });
    expect(rc.parseArgs(['--dir', 'd'])).toEqual({ file: 'd', dryRun: false, preserve: false });
    expect(rc.parseArgs([]).file).toBe(process.env.CASES_DIR || 'synthetic_cases');
  });

  test('run() rejects a path that does not exist', async () => {
    await expect(runWith('--file', path.join(dir, 'missing.json'))).rejects.toThrow('Path not found');
  });

  test('--dry-run reports without modifying the file or leaving a temp file', async () => {
    const p = writeCase('C-D.json', withTriggers('C-D'));
    const before = fs.readFileSync(p, 'utf8');
    await runWith('--file', p, '--dry-run');
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['C-D.json']);
  });

  test('--min sets the confidence floor', async () => {
    const p = writeCase('C-MIN.json', { case_id: 'C-MIN', category: 'access', scenarios: [] });
    await runWith('--file', p, '--min', '0.4');
    expect(readJson(p).confidence).toBe(0.4);
  });

  test('MIN_FLOOR env sets the floor when --min is absent', async () => {
    process.env.MIN_FLOOR = '0.25';
    const p = writeCase('C-ENV.json', { case_id: 'C-ENV', category: 'access', scenarios: [] });
    await runWith('--file', p);
    expect(readJson(p).confidence).toBe(0.25);
  });

  test('walks nested directories and reports files that failed', async () => {
    const ok = writeCase('ok.json', withTriggers('C-OK'));
    const nested = writeCase('sub/nested.json', withTriggers('C-NESTED'));
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ broken', 'utf8');
    await expect(runWith('--file', dir)).rejects.toThrow('1 file(s) failed');
    expect(readJson(ok).confidence).toBeGreaterThan(0);
    expect(readJson(nested).confidence).toBeGreaterThan(0);
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

    // Case B: mapped signal_id -> triggers should be expanded using the temporary mapping only
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-recalc-'));
    const cfgDir = path.join(tmpB, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    // temporary mapping: SIG-MAP -> ['urgency / pressure'] (explicit weight 0.03 in trigger-weights)
    const mapBPath = path.join(cfgDir, 'signal-mapping.json');
    fs.writeFileSync(mapBPath, JSON.stringify({ signals: { 'SIG-MAP': ['urgency / pressure'] } }, null, 2), 'utf8');
    const filePathB = path.join(tmpB, 'C-B.json');
    // category 'misc' keeps the multiplier at 1.0 so raw sums are exact (access would scale by 1.5)
    const sampleB = { case_id: 'C-B', category: 'misc', scenarios: [], signal_ids: ['SIG-MAP'] };
    fs.writeFileSync(filePathB, JSON.stringify(sampleB, null, 2), 'utf8');
    const r2 = new RecalcConfidence({ signalMappingPath: mapBPath });
    // minFloor 0 so the mapping's weight is not hidden by the 0.5 floor
    const resB = await r2.recalc(filePathB, false, 0);
    expect(resB).toBeTruthy();
    const updatedB = JSON.parse(fs.readFileSync(filePathB, 'utf8'));
    expect(typeof updatedB.confidence).toBe('number');

    // Same case with an empty temporary mapping: SIG-MAP is unmapped and uses SIGNAL_ID_WEIGHT.
    // The mapped run must differ, otherwise the temporary mapping was ignored.
    const tmpBFallback = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-recalc-'));
    const mapFallbackPath = path.join(tmpBFallback, 'signal-mapping.json');
    fs.writeFileSync(mapFallbackPath, JSON.stringify({ signals: {} }, null, 2), 'utf8');
    const filePathBFallback = path.join(tmpBFallback, 'C-B.json');
    fs.writeFileSync(filePathBFallback, JSON.stringify(sampleB, null, 2), 'utf8');
    await new RecalcConfidence({ signalMappingPath: mapFallbackPath }).recalc(filePathBFallback, false, 0);
    const updatedBFallback = JSON.parse(fs.readFileSync(filePathBFallback, 'utf8'));
    // Compare raw evidence sums: `confidence` is normalized with normAlpha=0.3 and rounds both runs to 0.
    // Mapped: urgency / pressure = 0.03. Fallback: unmapped SIG-MAP = SIGNAL_ID_WEIGHT = 0.01.
    expect(updatedB.confidence_raw).toBeCloseTo(0.03, 5);
    expect(updatedBFallback.confidence_raw).toBeCloseTo(0.01, 5);

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
    expect(updatedC.confidence).toBeGreaterThan(0);

    // cleanup
    try { fs.rmSync(tmpA, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(tmpB, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(tmpBFallback, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(tmpC, { recursive: true, force: true }); } catch (e) {}
  });
});
