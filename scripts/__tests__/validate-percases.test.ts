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
  test('accepts a minimal case and the generated new-case template', () => {
    const minimal = {
      case_id: 'MIN-CASE-001',
      category: 'access/example',
      scenarios: [{ name: 'Minimal scenario', text: 'Example prompt text.' }]
    };
    const generated = new NewCaseTemplate().createTemplate('TEMPLATE-001');

    expect(validateCase(minimal)).toBe(true);
    expect(validateCase(generated)).toBe(true);
  });

  test('accepts legacy dialogue and optional typed cross-check questions', () => {
    const base = {
      case_id: 'CROSSCHECK-001',
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

  test('accepts a complete case from public_cases', () => {
    const casePath = path.join(repoRoot, 'public_cases', 'ACCESS', 'A-CASE-001.json');
    const caseObj = JSON.parse(fs.readFileSync(casePath, 'utf8'));
    expect(validateCase(caseObj)).toBe(true);
  });

  test('validates every public case', () => {
    const out = execFileSync(process.execPath, ['-r', 'ts-node/register', 'scripts/validate-percases.ts', 'public_cases'], {
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
        'public_cases',
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
