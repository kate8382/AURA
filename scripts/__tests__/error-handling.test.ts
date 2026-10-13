import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import CrossCheckAdapter from '../policy/crossCheckAdapter';
import GenerateTriggerWeights from '../generate-trigger-weights';
import { RecalcConfidence } from '../recalc_confidence';
import { loadTriggerConfig } from '../config';
import { MigrateCategories } from '../tools/migrate-categories';

const repoRoot = path.resolve(__dirname, '..', '..');
const tsNode = require.resolve('ts-node/register');
const goodCase = { case_id: 'OK-1', category: 'access/example', scenarios: [{ name: 's', text: 't', triggers: ['urgency'] }] };

function runScript(script: string, args: string[], cwd = repoRoot, env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, TS_NODE_PROJECT: path.join(repoRoot, 'tsconfig.json'), ...env };
  delete base.CASES_DIR;
  return spawnSync(process.execPath, ['-r', tsNode, path.join(repoRoot, script), ...args], { cwd, env: base, encoding: 'utf8' });
}

describe('error handling policy', () => {
  let tmp: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-errors-'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (CrossCheckAdapter as any).evaluateCrossChecks;
    process.env = { ...savedEnv };
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeCases() {
    fs.writeFileSync(path.join(tmp, 'good.json'), JSON.stringify(goodCase), 'utf8');
    fs.writeFileSync(path.join(tmp, 'broken.json'), '{ not json', 'utf8');
  }

  test('normalize-percases exits 1 in --dry-run on invalid JSON but still processes other files', () => {
    writeCases();
    const res = runScript('scripts/normalize-percases.ts', [tmp, '--dry-run']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[ERROR] invalid JSON');
    expect(res.stderr).toContain('broken.json');
    expect(res.stdout).toContain('[dry] WOULD NORMALIZE');
    expect(fs.readFileSync(path.join(tmp, 'broken.json'), 'utf8')).toBe('{ not json');
  }, 30000);

  test('recalc_confidence exits 1 in --dry-run on invalid JSON, reports the file, and leaves no temp files', () => {
    writeCases();
    const res = runScript('scripts/recalc_confidence.ts', ['--dir', tmp, '--dry-run']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[ERROR] recalc failed');
    expect(res.stderr).toContain('broken.json');
    expect(res.stdout).toContain('Total updated entries');
    expect(fs.readdirSync(tmp).sort()).toEqual(['broken.json', 'good.json']);
  }, 30000);

  test('JSON log format is machine-readable', () => {
    writeCases();
    const res = runScript('scripts/recalc_confidence.ts', ['--dir', tmp, '--dry-run'], repoRoot, { AURA_LOG_FORMAT: 'json' });
    const entry = res.stderr.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(e => e.level === 'error');
    expect(entry).toMatchObject({ level: 'error', message: 'recalc failed' });
    expect(entry.file).toContain('broken.json');
  }, 30000);

  test('clean-public-cases exits 1 when a case file cannot be parsed', () => {
    const cases = path.join(tmp, 'public_cases');
    fs.mkdirSync(cases);
    fs.writeFileSync(path.join(cases, 'broken.json'), '{ not json', 'utf8');
    const res = runScript('scripts/tools/clean-public-cases.ts', [], tmp);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('[ERROR] cannot clean case file');
  }, 30000);

  test('generate-trigger-weights refuses to write when a case file is unreadable', () => {
    const repo = path.join(tmp, 'repo');
    const cases = path.join(tmp, 'cases');
    fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
    fs.mkdirSync(cases);
    fs.writeFileSync(path.join(cases, 'good.json'), JSON.stringify(goodCase), 'utf8');
    fs.writeFileSync(path.join(cases, 'broken.json'), '{ not json', 'utf8');
    process.env.CASES_DIR = cases;
    expect(() => new GenerateTriggerWeights(repo).run()).toThrow(/could not be read/);
    expect(fs.existsSync(path.join(repo, 'config', 'trigger-weights.json'))).toBe(false);
  });

  test('generate-trigger-weights refuses to regenerate when the existing config is unreadable', () => {
    const repo = path.join(tmp, 'repo');
    const cases = path.join(tmp, 'cases');
    const cfg = path.join(repo, 'config', 'trigger-weights.json');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.mkdirSync(cases);
    fs.writeFileSync(cfg, '{ broken', 'utf8');
    fs.writeFileSync(path.join(cases, 'good.json'), JSON.stringify(goodCase), 'utf8');
    process.env.CASES_DIR = cases;
    expect(() => new GenerateTriggerWeights(repo).run()).toThrow(/cannot read existing config/);
    expect(fs.readFileSync(cfg, 'utf8')).toBe('{ broken');
  });

  test('loadTriggerConfig rejects a malformed TRIGGER_WEIGHTS override', () => {
    process.env.TRIGGER_WEIGHTS = '{ nope';
    expect(() => loadTriggerConfig()).toThrow(/TRIGGER_WEIGHTS is not valid JSON/);
  });

  test('recalc propagates a failure of evaluateCrossChecks and leaves the file untouched', async () => {
    const casePath = path.join(tmp, 'case.json');
    const body = JSON.stringify({
      ...goodCase,
      cross_check: { questions: [{ id: 'q1', title: 'Q', type: 'boolean', evidence_weight: 0.1 }] }
    });
    fs.writeFileSync(casePath, body, 'utf8');
    (CrossCheckAdapter as any).evaluateCrossChecks = async () => { throw new Error('adapter bug'); };
    await expect(new RecalcConfidence().recalc(casePath, false, 0)).rejects.toThrow('adapter bug');
    expect(fs.readFileSync(casePath, 'utf8')).toBe(body);
  });

  test('migrate-categories records unreadable files instead of ignoring them', () => {
    fs.mkdirSync(path.join(tmp, 'public_cases', 'ACCESS'), { recursive: true });
    const broken = path.join(tmp, 'public_cases', 'ACCESS', 'broken.json');
    fs.writeFileSync(broken, '{ not json', 'utf8');
    const migrator = new MigrateCategories(tmp);
    migrator.migrate();
    expect(migrator.failures).toEqual([broken]);
  });
});
