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

  test('accepts legacy dialogue and optional typed cross-check questions', () => {
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
          id: 'authorization',
          title: 'Authorization check',
          type: 'boolean',
          evidence_weight: 0.1,
          threshold: { operator: 'gte', value: 1 },
          enforcement: { actionOnFail: 'mark_pending' }
        }]
      }
    };

    expect(validateCase(legacy)).toBe(true);
    expect(validateCase(typed)).toBe(true);
    expect(validateCase({ ...typed, cross_check: { questions: [{ ...typed.cross_check.questions[0], evidence_weight: -1 }] } })).toBe(false);
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

  test('declared_shape carries no signal_ids; signals come from the case-level signal_ids', () => {
    const validator = new ValidatePerCases();
    const ok = { declared_shape: { operation_type: 'read' }, signal_ids: ['camouflage:naive'] };
    const duplicated = { declared_shape: { operation_type: 'read', signal_ids: ['camouflage:naive'] }, signal_ids: ['camouflage:naive'] };
    expect(validator.validateOptionalMetadata(ok)).toEqual([]);
    expect(validator.validateOptionalMetadata(duplicated)).toEqual([
      'declared_shape.signal_ids is not allowed; use the case-level signal_ids'
    ]);
  });

  test('validates every public case', () => {
    const out = execFileSync(process.execPath, ['-r', 'ts-node/register', 'scripts/validate-percases.ts', 'synthetic_cases'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    expect(out).toContain('Validation complete');
    expect(out).toContain('Invalid files: 0');
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
