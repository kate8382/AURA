import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Ajv from 'ajv';
import CrossCheckAdapter from '../policy/crossCheckAdapter';
import GenerateTriggerWeights from '../generate-trigger-weights';
import { NormalizePerCases } from '../normalize-percases';
import { RecalcConfidence } from '../recalc_confidence';

const repoRoot = path.resolve(__dirname, '..', '..');
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const validateCase = new Ajv({ allErrors: true, strict: false }).compile(
  readJson(path.join(repoRoot, 'schemas', 'per-case-schema.json'))
);

function snapshotTree(dir: string, base = dir, out: Record<string, string> = {}) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) snapshotTree(full, base, out);
    else out[path.relative(base, full)] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

// generate-trigger-weights.test.ts rewrites these in a parallel worker.
const isSharedWithOtherSuites = (rel: string) => rel.startsWith('trigger-weights.json');

function snapshotRepoState() {
  const config = snapshotTree(path.join(repoRoot, 'config'));
  for (const rel of Object.keys(config)) if (isSharedWithOtherSuites(rel)) delete config[rel];
  return { public_cases: snapshotTree(path.join(repoRoot, 'public_cases')), config };
}

function auditSummary(id: string, weight: number) {
  return {
    auditEntries: [{ id, verifier: 'adapter:test-delay', result: true, ok: true, weight_applied: weight, ts: new Date().toISOString() }],
    total_weight: weight,
    failed_requirements: [],
    decisionHints: { veto: false, require_manual_review: false, pending: false }
  };
}

function typedCase(caseId: string) {
  return {
    case_id: caseId,
    category: 'access/example',
    scenarios: [{ name: 'Urgent request', text: 'Please act now.', triggers: ['urgency'] }],
    cross_check: { questions: [{ id: `q-${caseId}`, title: 'Is access justified?', type: 'boolean', evidence_weight: 0.1 }] },
    confidence: 0.01,
    decision: 'pending'
  };
}

describe('recalc pipeline integration', () => {
  const repoBefore = snapshotRepoState();
  const originalArgv = process.argv.slice();
  const adapter = CrossCheckAdapter;
  let tmp: string;

  afterAll(() => {
    expect(snapshotRepoState()).toEqual(repoBefore);
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-pipeline-'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (adapter as any).evaluateCrossChecks;
    delete process.env.CASES_DIR;
    delete process.env.TRIGGER_WEIGHTS;
    process.argv = originalArgv.slice();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('normalize -> generate weights -> recalc yields an updated, schema-valid case', async () => {
    const casesDir = path.join(tmp, 'cases', 'ACCESS');
    fs.mkdirSync(casesDir, { recursive: true });
    const casePath = path.join(casesDir, 'EX-EXAMPLE-001.json');
    fs.copyFileSync(path.join(repoRoot, 'examples', 'sample_case.json'), casePath);
    const initialConfidence = readJson(casePath).confidence;

    process.argv.push('--extract-triggers', '--apply-signal-ids');
    await new NormalizePerCases(false).walkDir(path.join(tmp, 'cases'));
    const normalized = readJson(casePath);
    const triggers = normalized.scenarios.flatMap((s: any) => s.triggers || []);
    expect(triggers.length).toBeGreaterThan(0);
    expect(normalized.signal_ids.length).toBeGreaterThan(0);

    const isolatedRepo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(isolatedRepo, 'config'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'config', 'signal-mapping.json'), path.join(isolatedRepo, 'config', 'signal-mapping.json'));
    process.env.CASES_DIR = path.join(tmp, 'cases');
    const { outPath } = new GenerateTriggerWeights(isolatedRepo).run();
    expect(outPath.startsWith(isolatedRepo)).toBe(true);
    process.env.TRIGGER_WEIGHTS = JSON.stringify(readJson(outPath).triggerWeights);

    adapter.evaluateCrossChecks = async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return auditSummary('cc-delay', 0.1);
    };
    const result = await new RecalcConfidence().recalc(casePath, false, 0.0);

    const out = readJson(casePath);
    expect(result.count).toBe(1);
    expect(out.confidence).toBeGreaterThan(initialConfidence);
    expect(out.confidence_raw).toBeGreaterThan(0);
    expect(['allow', 'review', 'block', 'pending']).toContain(out.decision);
    expect(out.cross_check_audit.map((a: any) => a.id)).toEqual(['cc-delay']);
    expect(validateCase(out)).toBe(true);
  });

  test('does not write to disk until a delayed cross-check completes', async () => {
    const casePath = path.join(tmp, 'delayed.json');
    fs.writeFileSync(casePath, JSON.stringify(typedCase('DELAYED-1'), null, 2), 'utf8');
    const before = fs.readFileSync(casePath, 'utf8');

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    adapter.evaluateCrossChecks = async () => {
      entered();
      await gate;
      return auditSummary('q-DELAYED-1', 0.1);
    };

    const pending = new RecalcConfidence().recalc(casePath, false, 0.0);
    await started;
    expect(fs.readFileSync(casePath, 'utf8')).toBe(before);

    release();
    await pending;
    const out = readJson(casePath);
    expect(out.cross_check_audit).toHaveLength(1);
    expect(out.confidence).toBeGreaterThan(0.01);
  });

  test('concurrent recalcs with different delays do not cross-contaminate files', async () => {
    const delays: Record<string, number> = { 'RACE-A': 60, 'RACE-B': 5 };
    const weights: Record<string, number> = { 'RACE-A': 0.1, 'RACE-B': 0.5 };
    const completed: string[] = [];
    adapter.evaluateCrossChecks = async (caseObj: any) => {
      const id = caseObj.case_id as string;
      await new Promise(resolve => setTimeout(resolve, delays[id]));
      completed.push(id);
      return auditSummary(`audit-${id}`, weights[id]);
    };

    const paths = ['RACE-A', 'RACE-B'].map(id => {
      const p = path.join(tmp, `${id}.json`);
      fs.writeFileSync(p, JSON.stringify(typedCase(id), null, 2), 'utf8');
      return p;
    });
    await Promise.all(paths.map(p => new RecalcConfidence().recalc(p, false, 0.0)));

    const [a, b] = paths.map(readJson);
    expect(completed).toEqual(['RACE-B', 'RACE-A']);
    expect(a.cross_check_audit.map((x: any) => x.id)).toEqual(['audit-RACE-A']);
    expect(b.cross_check_audit.map((x: any) => x.id)).toEqual(['audit-RACE-B']);
    expect(b.confidence_raw).toBeGreaterThan(a.confidence_raw);
  });

  test('--dry-run leaves case files unchanged for recalc and normalize', () => {
    const casePath = path.join(tmp, 'dry-run.json');
    fs.copyFileSync(path.join(repoRoot, 'examples', 'sample_case.json'), casePath);
    const before = fs.readFileSync(casePath, 'utf8');
    const env = { ...process.env };
    delete env.CASES_DIR;

    const recalc = spawnSync(process.execPath, ['-r', 'ts-node/register', 'scripts/recalc_confidence.ts', '--dry-run', '--file', casePath], { cwd: repoRoot, env, encoding: 'utf8' });
    const normalize = spawnSync(process.execPath, ['-r', 'ts-node/register', 'scripts/normalize-percases.ts', tmp, '--dry-run', '--extract-triggers'], { cwd: repoRoot, env, encoding: 'utf8' });

    expect(recalc.status).toBe(0);
    expect(recalc.stdout).toContain('Dry-run: files not modified.');
    expect(normalize.status).toBe(0);
    expect(fs.readFileSync(casePath, 'utf8')).toBe(before);
    expect(fs.readdirSync(tmp)).toEqual(['dry-run.json']);
  }, 30000);
});
