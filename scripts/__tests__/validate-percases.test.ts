import { execFileSync, spawnSync } from 'child_process';
import Ajv from 'ajv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NewCaseTemplate } from '../new-case-template';
import { ValidatePerCases } from '../validate-percases';

const repoRoot = path.resolve(__dirname, '..', '..');
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'schemas', 'per-case-schema.json'), 'utf8'));
const validateCase = new Ajv({ allErrors: true, strict: false }).compile(schema);

// Minimal typed cross-check question that passes the schema.
const typedQuestion = (id: string) => ({
  id,
  title: 'Check',
  type: 'boolean',
  evidence_weight: 0.1,
  threshold: { operator: 'gte', value: 1 },
  enforcement: { actionOnFail: 'mark_pending' }
});

// Write a case under a temp directory and run the per-file validator on it.
async function runValidateFile(obj: unknown, name = 'SC-A-001.json') {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
  const p = path.join(tmp, name);
  await fs.promises.writeFile(p, JSON.stringify(obj));
  try {
    return await new ValidatePerCases().validateFile(validateCase, p);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

describe('ValidatePerCases.validateSourceId', () => {
  const sources = { approved: new Set(['SRC-OK']), conditional: new Set(['SRC-COND']) };
  const realCase = (provenance: Record<string, unknown>) => ({ case_type: 'real', provenance });

  test('non-real cases skip the source check', () => {
    expect(new ValidatePerCases().validateSourceId({ case_type: 'synthetic' }, 'x.json', sources)).toEqual([]);
  });

  test('real cases without source_id are rejected', () => {
    const errs = new ValidatePerCases().validateSourceId(realCase({}), 'x.json', sources);
    expect(errs.join('\n')).toMatch(/provenance\.source_id is required/);
  });

  test('unknown real source_id is rejected', () => {
    const errs = new ValidatePerCases().validateSourceId(realCase({ source_id: 'SRC-NOPE' }), 'x.json', sources);
    expect(errs.join('\n')).toMatch(/"SRC-NOPE" is not an approved Source ID/);
  });

  test('approved real source_id passes', () => {
    expect(new ValidatePerCases().validateSourceId(realCase({ source_id: 'SRC-OK' }), 'x.json', sources)).toEqual([]);
  });

  test('conditional source requires pointer_only redaction', () => {
    const v = new ValidatePerCases();
    expect(v.validateSourceId(realCase({ source_id: 'SRC-COND', redaction_status: 'full' }), 'x.json', sources).join('\n'))
      .toMatch(/requires provenance\.redaction_status "pointer_only"/);
    expect(v.validateSourceId(realCase({ source_id: 'SRC-COND', redaction_status: 'pointer_only' }), 'x.json', sources)).toEqual([]);
  });
});

describe('ValidatePerCases.parseArgs', () => {
  const parse = (argv: string[]) =>
    (new ValidatePerCases() as unknown as { parseArgs(a: string[]): string }).parseArgs(argv);

  test('accepts --dir/-d and a positional directory', () => {
    expect(parse(['--dry-run', '-d', 'some/dir'])).toBe('some/dir');
    expect(parse(['positional/dir'])).toBe('positional/dir');
  });

  test('rejects unknown options, extra positionals and a missing --dir value', () => {
    expect(() => parse(['--bogus'])).toThrow('Unknown option: --bogus');
    expect(() => parse(['a', 'b'])).toThrow('Unexpected argument: b');
    expect(() => parse(['--dir'])).toThrow('--dir requires a directory path');
  });
});

describe('validate-percases script', () => {
  test('accepts benign case IDs in benign_cases/ with the B domain letter', () => {
    const validator = new ValidatePerCases();
    const synthetic = path.join(repoRoot, 'benign_cases', 'synthetic', 'SC-B-001.json');
    const real = path.join(repoRoot, 'benign_cases', 'real', 'RC-B-001.json');

    expect(validator.validateCaseIdConsistency({ case_id: 'SC-B-001', domain: 'benign' }, synthetic)).toEqual([]);
    expect(validator.validateCaseIdPrefix({ case_id: 'RC-B-001', case_type: 'real' }, real)).toEqual([]);
  });

  test('generated benign template passes the schema and benign rules after recalc', () => {
    const validator = new ValidatePerCases();
    const p = path.join(repoRoot, 'benign_cases', 'synthetic', 'SC-B-001.json');
    const tpl = new NewCaseTemplate().createTemplate(undefined, 'synthetic', true);

    expect(tpl.case_id).toBe('SC-B-000');
    expect(validateCase(tpl)).toBe(true);
    // The template has no decision yet; recalc:confidence writes decision "allow" for benign cases.
    expect(validator.validateBenignCase(tpl, p)).toHaveLength(1);
    expect(validator.validateBenignCase({ ...tpl, decision: 'allow', confidence: 0 }, p)).toEqual([]);
  });

  test('rejects benign cases with a non-allow decision, triggers or cross-check questions', () => {
    const validator = new ValidatePerCases();
    const p = path.join(repoRoot, 'benign_cases', 'synthetic', 'SC-B-001.json');
    const tpl = new NewCaseTemplate().createTemplate('SC-B-001', 'synthetic', true);
    const ok = { ...tpl, decision: 'allow', confidence: 0 };

    expect(validator.validateBenignCase({ ...ok, decision: 'pending' }, p)).toHaveLength(1);
    expect(validator.validateBenignCase({ ...ok, scenarios: [{ name: 'x', text: 'y', triggers: ['z'] }] }, p)).toHaveLength(1);
    expect(validator.validateBenignCase({ ...ok, cross_check: { questions: [{ name: 'q' }] } }, p)).toHaveLength(1);
  });

  test('rejects cross_check as the action for a benign case', () => {
    const validator = new ValidatePerCases();
    const p = path.join(repoRoot, 'benign_cases', 'synthetic', 'SC-B-001.json');
    const tpl = new NewCaseTemplate().createTemplate('SC-B-001', 'synthetic', true);

    expect(validator.validateBenignCase({ ...tpl, decision: 'allow', suggested_action: 'cross_check' }, p)).toHaveLength(1);
  });

  test('rejects mock_* keys at top level, in meta and inside arrays, naming the key', () => {
    const validator = new ValidatePerCases();
    const tpl = new NewCaseTemplate().createTemplate('SC-B-001', 'synthetic', true);

    const top = validator.validateNoMockKeys({ ...tpl, mock_ip_geo: true });
    expect(top).toHaveLength(1);
    expect(top[0]).toContain('mock_ip_geo (at $.mock_ip_geo)');

    const nested = validator.validateNoMockKeys({ ...tpl, meta: { mock_email_verified: true } });
    expect(nested).toHaveLength(1);
    expect(nested[0]).toContain('mock_email_verified (at $.meta.mock_email_verified)');

    const inArray = validator.validateNoMockKeys({ cross_check: { questions: [{ mock_bounty_scope: true }] } });
    expect(inArray).toHaveLength(1);
    expect(inArray[0]).toContain('mock_bounty_scope (at $.cross_check.questions[0].mock_bounty_scope)');
  });

  test('does not reject keys that merely contain "mock" without the mock_ prefix', () => {
    const validator = new ValidatePerCases();
    expect(validator.validateNoMockKeys({ meta: { remock_count: 1, mockery: 'x', mock: 'y' } })).toEqual([]);
  });

  test('benign_cases/clarify requires pending decision and at least one question, but allows triggers', () => {
    const validator = new ValidatePerCases();
    const p = path.join(repoRoot, 'benign_cases', 'clarify', 'synthetic', 'SC-B-002.json');
    const clarify = {
      case_id: 'SC-B-002',
      negative_labels: { status: 'benign' },
      decision: 'pending',
      scenarios: [{ name: 's', text: 't', triggers: ['weak context'] }],
      cross_check: { questions: [{ name: 'Experience level', full_text: ['Are you just starting?'] }] }
    };

    expect(validator.validateBenignCase(clarify, p)).toEqual([]);
    expect(validator.validateBenignCase({ ...clarify, decision: 'allow' }, p)).toHaveLength(1);
    expect(validator.validateBenignCase({ ...clarify, cross_check: { questions: [] } }, p)).toHaveLength(1);
  });

  test('clarify template has one question, allows triggers and passes clarify rules once pending', () => {
    const validator = new ValidatePerCases();
    const p = path.join(repoRoot, 'benign_cases', 'clarify', 'synthetic', 'SC-B-003.json');
    const tpl = new NewCaseTemplate().createTemplate('SC-B-003', 'synthetic', true, true);

    expect(tpl.suggested_action).toBe('cross_check');
    expect(tpl.cross_check.questions).toHaveLength(1);
    expect(validator.validateBenignCase({ ...tpl, decision: 'pending' }, p)).toEqual([]);
  });

  test('benign_cases/clarify/real requires provenance like other real cases', () => {
    const validator = new ValidatePerCases();
    const p = path.join(repoRoot, 'benign_cases', 'clarify', 'real', 'RC-B-001.json');
    expect(validator.validateSourceId({ case_id: 'RC-B-001', case_type: 'real' }, p, { approved: new Set(), conditional: new Set() })).not.toEqual([]);
  });

  test('accepts a minimal case and the generated new-case template', () => {
    const minimal = {
      case_id: 'SC-M-001',
      category: 'access/example',
      scenarios: [{ name: 'Minimal scenario', text: 'Example prompt text.' }]
    };
    const generated = new NewCaseTemplate().createTemplate('SC-X-001');

    expect(validateCase(minimal)).toBe(true);
    expect(validateCase(generated)).toBe(true);
  });

  test('requires id, title and an allowed type on cross-check questions', () => {
    const base = {
      case_id: 'SC-M-002',
      category: 'access/example',
      scenarios: [{ name: 'Scenario', text: 'Example prompt text.' }]
    };
    const legacy = {
      ...base,
      cross_check: {
        questions: [{ name: 'Authorization check', full_text: ['Question A', 'Question B'] }]
      }
    };
    const typed = {
      ...base,
      cross_check: {
        questions: [{
          id: 'q1-authorization',
          title: 'Authorization check',
          type: 'boolean',
          evidence_weight: 0.1,
          threshold: { operator: 'gte', value: 1 },
          enforcement: { actionOnFail: 'mark_pending' }
        }]
      }
    };

    expect(validateCase(typed)).toBe(true);
    expect(validateCase(legacy)).toBe(false);
    expect(validateCase({ ...typed, cross_check: { questions: [{ ...typed.cross_check.questions[0], evidence_weight: -1 }] } })).toBe(false);
    expect(validateCase({ ...typed, cross_check: { questions: [{ ...typed.cross_check.questions[0], id: undefined }] } })).toBe(false);
    expect(validateCase({ ...typed, cross_check: { questions: [{ ...typed.cross_check.questions[0], type: 'text' }] } })).toBe(false);
    expect(validateCase({ ...typed, cross_check: { questions: [{ ...typed.cross_check.questions[0], id: 'foo' }] } })).toBe(false);
    expect(validateCase({ ...typed, cross_check: { questions: [{ ...typed.cross_check.questions[0], title: '' }] } })).toBe(false);
  });

  test('rejects a file that still has a TODO question placeholder from the template', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
    const p = path.join(tmp, 'SC-X-001.json');
    const tpl = new NewCaseTemplate().createTemplate('SC-X-001');
    await fs.promises.writeFile(p, JSON.stringify(tpl));

    const result = await new ValidatePerCases().validateFile(validateCase, p);
    expect(result.ok).toBe(false);
    expect(String(result.errs)).toContain('TODO placeholder');

    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  test('validateFile accepts a complete synthetic case whose file name matches case_id', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
    const p = path.join(tmp, 'SC-A-001.json');
    await fs.promises.copyFile(path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'SC-A-001.json'), p);

    const result = await new ValidatePerCases().validateFile(validateCase, p);
    expect(result.ok).toBe(true);

    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  test('validateFile reports schema errors for a case missing required fields', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
    const p = path.join(tmp, 'SC-X-002.json');
    await fs.promises.writeFile(p, JSON.stringify({ case_id: 'SC-X-002' }));

    const result = await new ValidatePerCases().validateFile(validateCase, p);
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errs) && result.errs.length > 0).toBe(true);

    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  test('validateFile rejects a case with a mock_* flag and names the key', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
    const p = path.join(tmp, 'SC-A-001.json');
    const src = JSON.parse(await fs.promises.readFile(path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'SC-A-001.json'), 'utf8'));
    await fs.promises.writeFile(p, JSON.stringify({ ...src, meta: { mock_ip_geo: true } }));

    const result = await new ValidatePerCases().validateFile(validateCase, p);
    expect(result.ok).toBe(false);
    expect(String(result.errs)).toContain('mock_ip_geo');

    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  test('validateFile returns ok=false with the parse error for broken JSON', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
    const p = path.join(tmp, 'SC-X-003.json');
    await fs.promises.writeFile(p, '{ "case_id": ');

    const result = await new ValidatePerCases().validateFile(validateCase, p);
    expect(result.ok).toBe(false);
    expect(typeof result.errs).toBe('string');

    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  test('accepts a complete case from synthetic_cases', () => {
    const casePath = path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'SC-A-001.json');
    const caseObj = JSON.parse(fs.readFileSync(casePath, 'utf8'));
    expect(validateCase(caseObj)).toBe(true);
  });

  test('schema rejects legacy case_id formats and accepts SC-/RC- ids', () => {
    const base = { category: 'access/example', scenarios: [{ name: 'S', text: 'Example.' }] };
    expect(validateCase({ ...base, case_id: 'A-CASE-001' })).toBe(false);
    expect(validateCase({ ...base, case_id: 'SC-A-1' })).toBe(false);
    expect(validateCase({ ...base, case_id: 'SC-A-001' })).toBe(true);
    expect(validateCase({ ...base, case_id: 'RC-M-001' })).toBe(true);
  });

  test('case_id prefix must be RC- under real_cases and SC- elsewhere', () => {
    const validator = new ValidatePerCases();
    const synthPath = path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'SC-A-001.json');
    const realPath = path.join(repoRoot, 'real_cases', 'M', 'RC-M-001.json');
    expect(validator.validateCaseIdPrefix({ case_id: 'SC-A-001' }, synthPath)).toEqual([]);
    expect(validator.validateCaseIdPrefix({ case_id: 'RC-M-001' }, realPath)).toEqual([]);
    expect(validator.validateCaseIdPrefix({ case_id: 'SC-M-001' }, realPath)).not.toEqual([]);
    expect(validator.validateCaseIdPrefix({ case_id: 'RC-M-001' }, synthPath)).not.toEqual([]);
    expect(validator.validateCaseIdPrefix({ case_id: 'RC-M-001', case_type: 'real' }, synthPath)).toEqual([]);
  });

  test('case_id prefix check reports malformed ids instead of passing silently', () => {
    const validator = new ValidatePerCases();
    const synthPath = path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'SC-A-001.json');
    expect(validator.validateCaseIdPrefix({ case_id: 'A-CASE-001' }, synthPath)).not.toEqual([]);
    expect(validator.validateCaseIdPrefix({}, synthPath)).not.toEqual([]);
  });

  test('domain letter must match domain, folder and file name', () => {
    const validator = new ValidatePerCases();
    const fraudPath = path.join(repoRoot, 'real_cases', 'FRAUD', 'RC-F-001.json');
    const ok = { case_id: 'RC-F-001', domain: 'fraud' };
    expect(validator.validateCaseIdConsistency(ok, fraudPath)).toEqual([]);
    expect(validator.validateCaseIdConsistency({ case_id: 'RC-F-001' }, fraudPath)).toEqual([]);
    expect(validator.validateCaseIdConsistency({ case_id: 'RC-A-001', domain: 'access' }, fraudPath)).not.toEqual([]);
    expect(validator.validateCaseIdConsistency({ case_id: 'RC-F-001', domain: 'access' }, fraudPath)).not.toEqual([]);
    expect(validator.validateCaseIdConsistency({ case_id: 'RC-F-001', domain: 'fraud' }, path.join(repoRoot, 'real_cases', 'ACCESS', 'RC-F-001.json'))).not.toEqual([]);
    expect(validator.validateCaseIdConsistency({ case_id: 'RC-F-002', domain: 'fraud' }, fraudPath)).not.toEqual([]);
    expect(validator.validateCaseIdConsistency({ case_id: 'RC-X-001' }, fraudPath)).not.toEqual([]);
  });

  test('validates every public case', () => {
    const out = execFileSync(process.execPath, ['-r', 'ts-node/register', 'scripts/validate-percases.ts', 'synthetic_cases'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    expect(out).toContain('Validation complete');
    expect(out).toContain('Invalid files: 0');
  });

  test('validateFile rejects duplicate cross_check question ids inside one case', async () => {
    const synthA = JSON.parse(fs.readFileSync(path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'SC-A-001.json'), 'utf8'));
    const result = await runValidateFile({ ...synthA, cross_check: { questions: [typedQuestion('q1-alpha'), typedQuestion('q1-alpha')] } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errs)).toContain('duplicate cross_check question id \\"q1-alpha\\"');
  });

  test('the same question id in two different case files is not a duplicate', async () => {
    const synthA = JSON.parse(fs.readFileSync(path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'SC-A-001.json'), 'utf8'));
    const first = await runValidateFile({ ...synthA, cross_check: { questions: [typedQuestion('q1-alpha')] } }, 'SC-A-001.json');
    const second = await runValidateFile({ ...synthA, case_id: 'SC-A-002', cross_check: { questions: [typedQuestion('q1-alpha')] } }, 'SC-A-002.json');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  test('validateFile rejects a cross_check question missing title through the schema', async () => {
    const synthA = JSON.parse(fs.readFileSync(path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'SC-A-001.json'), 'utf8'));
    const { title: _omitted, ...withoutTitle } = typedQuestion('q1-alpha');
    const result = await runValidateFile({ ...synthA, cross_check: { questions: [withoutTitle] } });
    expect(result.ok).toBe(false);
  });

  test('validateFile accepts a case without the optional cross_check block', async () => {
    const synthA = JSON.parse(fs.readFileSync(path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'SC-A-001.json'), 'utf8'));
    delete synthA.cross_check;
    expect((await runValidateFile(synthA)).ok).toBe(true);
  });

  test('validateFile names the negative_labels field when an optional block has a wrong value', async () => {
    const synthA = JSON.parse(fs.readFileSync(path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'SC-A-001.json'), 'utf8'));
    const result = await runValidateFile({ ...synthA, negative_labels: { status: 'maybe' } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.errs)).toContain('negative_labels');
  });

  test('run() passes a directory of valid cases without exiting', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
    await fs.promises.copyFile(path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'SC-A-001.json'), path.join(tmp, 'SC-A-001.json'));
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await new ValidatePerCases().run(tmp);
      expect(exit).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Invalid files: 0'));
    } finally {
      exit.mockRestore();
      log.mockRestore();
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  test('run() exits with code 2 when a case in the directory is invalid', async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
    await fs.promises.writeFile(path.join(tmp, 'SC-X-004.json'), JSON.stringify({ case_id: 'SC-X-004' }));
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await new ValidatePerCases().run(tmp);
      expect(exit).toHaveBeenCalledWith(2);
    } finally {
      exit.mockRestore();
      log.mockRestore();
      await fs.promises.rm(tmp, { recursive: true, force: true });
    }
  });

  test('run() rejects unknown options and --dir without a value', async () => {
    const argv = process.argv;
    try {
      process.argv = ['node', 'validate', '--bogus'];
      await expect(new ValidatePerCases().run()).rejects.toThrow('Unknown option: --bogus');
      process.argv = ['node', 'validate', '--dir'];
      await expect(new ValidatePerCases().run()).rejects.toThrow('--dir requires a directory path');
    } finally {
      process.argv = argv;
    }
  });

  test('--dir overrides a positional directory argument', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-schema-dir-'));
    const invalidCasePath = path.join(tempDir, 'invalid.json');
    fs.writeFileSync(invalidCasePath, JSON.stringify({ case_id: 'MISSING-REQUIRED-FIELDS' }), 'utf8');

    try {
      const result = spawnSync(process.execPath, [
        '-r', 'ts-node/register',
        'scripts/validate-percases.ts',
        'synthetic_cases',
        '--dir', tempDir
      ], { cwd: repoRoot, encoding: 'utf8' });

      expect(result.status).toBe(2);
      expect(result.stdout).toContain(`INVALID: ${invalidCasePath}`);
      expect(result.stdout).toContain('Invalid files: 1');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
