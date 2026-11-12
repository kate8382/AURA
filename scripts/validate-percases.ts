import fs from 'fs/promises';
import path from 'path';
import Ajv from 'ajv';
import { loadNoticeSources, NoticeSources, NOTICE_PATH } from './lib/notice';
import { CASE_ID_PATTERN, DOMAIN_BY_LETTER, isRealCasePath } from './lib/case-id';
import { BENIGN_CASES_DIR } from './lib/cases-cli';

// ValidatePerCases - класс-обёртка для валидации per-case JSON файлов против схемы.
// Методы:
// - validateOptionalMetadata(): проверяет опциональные метаданные
// - validateSourceId(): проверяет, что provenance.source_id есть в real_cases/NOTICE.md
// - loadSchema(): загружает JSON Schema
// - walk(): рекурсивно обходит директорию
// - validateFile(): валидирует один файл
// - parseArgs(): парсит аргументы командной строки
// - run(): выполняет процесс валидации для директории

export class ValidatePerCases {
  private ajv: Ajv;
  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
  }

  // Real cases (case_type "real" or files under real_cases/) must cite a Source ID from NOTICE.
  // Conditional sources are allowed only as pointer_only, so no full text is stored for them.
  validateSourceId(obj: any, p: string, sources: NoticeSources): string[] {
    const segments = path.resolve(p).split(path.sep);
    const isRealPath = segments.includes('real_cases') || (segments.includes(BENIGN_CASES_DIR) && segments.includes('real'));
    if (!isRealPath && obj?.case_type !== 'real') return [];
    const sourceId = obj?.provenance?.source_id;
    if (typeof sourceId !== 'string' || sourceId.trim() === '') {
      return ['provenance.source_id is required for real cases and must match a Source ID in real_cases/NOTICE.md'];
    }
    if (sources.conditional.has(sourceId)) {
      if (obj?.provenance?.redaction_status !== 'pointer_only') {
        return [`provenance.source_id "${sourceId}" is a Conditional source in real_cases/NOTICE.md and requires provenance.redaction_status "pointer_only"`];
      }
      return [];
    }
    if (!sources.approved.has(sourceId)) {
      return [`provenance.source_id "${sourceId}" is not an approved Source ID in real_cases/NOTICE.md`];
    }
    return [];
  }

  // case_id prefix must match the case kind: RC- for real cases, SC- for synthetic cases.
  validateCaseIdPrefix(obj: any, p: string): string[] {
    const caseId = obj?.case_id;
    if (typeof caseId !== 'string' || !CASE_ID_PATTERN.test(caseId)) {
      return [`case_id ${JSON.stringify(caseId)} must match ${CASE_ID_PATTERN} (for example SC-A-001 or RC-M-001)`];
    }
    const expected = isRealCasePath(p) || obj?.case_type === 'real' ? 'RC' : 'SC';
    const actual = caseId.split('-')[0];
    if (actual !== expected) {
      return [`case_id "${caseId}" must use the ${expected}- prefix for ${expected === 'RC' ? 'real' : 'synthetic'} cases`];
    }
    return [];
  }

  // The domain letter must match the top-level domain and the folder, and case_id must equal the file name.
  validateCaseIdConsistency(obj: any, p: string): string[] {
    const caseId = obj?.case_id;
    if (typeof caseId !== 'string' || !CASE_ID_PATTERN.test(caseId)) return [];
    const errors: string[] = [];
    const letter = caseId.split('-')[1];
    const domain = DOMAIN_BY_LETTER[letter];
    if (!domain) {
      return [`case_id "${caseId}" uses unknown domain letter "${letter}"`];
    }
    if (obj.domain !== undefined && obj.domain !== domain) {
      errors.push(`case_id "${caseId}" has domain letter "${letter}" but domain is "${obj.domain}" (expected "${domain}")`);
    }
    const folder = path.basename(path.dirname(path.resolve(p)));
    const knownFolders = Object.values(DOMAIN_BY_LETTER).map(d => d.toUpperCase());
    if (knownFolders.includes(folder) && folder !== domain.toUpperCase()) {
      errors.push(`case_id "${caseId}" has domain letter "${letter}" but is stored in folder "${folder}" (expected "${domain.toUpperCase()}")`);
    }
    if (path.basename(p, '.json') !== caseId) {
      errors.push(`case_id "${caseId}" must match the file name "${path.basename(p)}"`);
    }
    return errors;
  }

  // Benign cases under benign_cases/: a safe-case label, no hard cross-check, and no restriction on the answer.
  validateBenignCase(obj: any, p: string): string[] {
    if (!path.resolve(p).split(path.sep).includes(BENIGN_CASES_DIR)) return [];
    const errors: string[] = [];
    const status = obj?.negative_labels?.status;
    if (status !== 'benign' && status !== 'confirmed_negative') {
      errors.push('benign_cases files must set negative_labels.status to "benign" or "confirmed_negative"');
    }
    if (obj?.suggested_action !== 'allow') {
      errors.push('benign_cases files must set suggested_action to "allow" (cross_check is not used for benign cases)');
    }
    if (obj?.response_constraint !== 'none') {
      errors.push('benign_cases files must set response_constraint to "none"');
    }
    if (obj?.decision !== 'allow') {
      errors.push('benign_cases files must have decision "allow" (run recalc:confidence on benign_cases first)');
    }
    const scenarios = Array.isArray(obj?.scenarios) ? obj.scenarios : [];
    if (scenarios.some((s: any) => !Array.isArray(s?.triggers) || s.triggers.length > 0)) {
      errors.push('benign_cases files must have empty scenarios[].triggers');
    }
    const questions = obj?.cross_check?.questions;
    if (!Array.isArray(questions) || questions.length > 0) {
      errors.push('benign_cases files must have cross_check.questions = [] (any question moves the decision to pending)');
    }
    return errors;
  }

  // Validate optional trial metadata without breaking legacy records that do not declare any of it.
  validateOptionalMetadata(obj: any): string[] {
    const errors: string[] = [];

    if (obj && obj.declared_shape !== undefined) {
      if (obj.declared_shape === null || typeof obj.declared_shape !== 'object') {
        errors.push('declared_shape must be an object when present');
      } else {
        const shape = obj.declared_shape;
        if (typeof shape.operation_type !== 'string' || shape.operation_type.trim() === '') {
          errors.push('declared_shape.operation_type must be a non-empty string when declared_shape is present');
        }
        if (shape.signal_ids !== undefined) {
          errors.push('declared_shape.signal_ids is not allowed; use the case-level signal_ids');
        }
      }
    }

    if (obj && obj.negative_labels !== undefined) {
      if (obj.negative_labels === null || typeof obj.negative_labels !== 'object') {
        errors.push('negative_labels must be an object when present');
      } else {
        const labels = obj.negative_labels;
        if (labels.status !== undefined && !['confirmed_negative', 'benign', 'unknown'].includes(labels.status)) {
          errors.push('negative_labels.status must be one of confirmed_negative, benign, or unknown');
        }
        if (labels.reason !== undefined && typeof labels.reason !== 'string') {
          errors.push('negative_labels.reason must be a string when present');
        }
        if (labels.source !== undefined && typeof labels.source !== 'string') {
          errors.push('negative_labels.source must be a string when present');
        }
      }
    }

    return errors;
  }

  // Load the JSON Schema for per-case validation
  async loadSchema() {
    const s = await fs.readFile(path.join(__dirname, '..', 'schemas', 'per-case-schema.json'), 'utf8');
    return JSON.parse(s);
  }

  // Recursively walk a directory and apply a callback to each JSON file
  async walk(dir: string, cb: (p: string) => Promise<void>) {
    const ents = await fs.readdir(dir, { withFileTypes: true });
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(full, cb);
      else if (e.isFile() && e.name.endsWith('.json')) await cb(full);
    }
  }

  // Validate a single JSON file against the schema
  async validateFile(validate: any, p: string, sources: NoticeSources = { approved: new Set(), conditional: new Set() }) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const obj = JSON.parse(raw);
      const valid = validate(obj);
      if (!valid) {
        return { ok: false, errs: validate.errors };
      }
      const metadataErrors = this.validateOptionalMetadata(obj);
      if (metadataErrors.length > 0) {
        return { ok: false, errs: metadataErrors };
      }
      const sourceErrors = this.validateSourceId(obj, p, sources);
      if (sourceErrors.length > 0) {
        return { ok: false, errs: sourceErrors };
      }
      const caseIdErrors = [
        ...this.validateCaseIdPrefix(obj, p),
        ...this.validateCaseIdConsistency(obj, p),
        ...this.validateBenignCase(obj, p)
      ];
      if (caseIdErrors.length > 0) {
        return { ok: false, errs: caseIdErrors };
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, errs: e.message };
    }
  }

  // Parse command-line arguments to determine the target directory for validation.
  private parseArgs(argv: string[]) {
    let optionDir: string | undefined;
    let positionalDir: string | undefined;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--dry-run') continue;
      if (arg === '--dir' || arg === '-d') {
        const value = argv[++i];
        if (!value || value.startsWith('-')) throw new Error(`${arg} requires a directory path`);
        optionDir = value;
        continue;
      }
      if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
      if (positionalDir) throw new Error(`Unexpected argument: ${arg}`);
      positionalDir = arg;
    }
    return optionDir || positionalDir || process.env.CASES_DIR || 'synthetic_cases';
  }

  // Run the validation process on a target directory (or default to synthetic_cases)
  async run(targetDir?: string) {
    const schema = await this.loadSchema();
    const validate = this.ajv.compile(schema);
    const target = path.resolve(targetDir || this.parseArgs(process.argv.slice(2)));
    const targetStats = await fs.stat(target).catch(() => null);
    if (!targetStats || !targetStats.isDirectory()) throw new Error(`Directory not found: ${target}`);
    if (process.argv.includes('--dry-run')) console.log('Dry-run mode: validation does not modify files.');

    let errors = 0;
    const noticeSources = await loadNoticeSources(NOTICE_PATH);
    await this.walk(target, async (p) => {
      const res = await this.validateFile(validate, p, noticeSources);
      if (!res.ok) {
        errors += 1;
        console.log('\nINVALID:', p);
        console.log(res.errs);
      }
    });

    console.log(`\nValidation complete. Invalid files: ${errors}`);
    if (errors > 0) process.exit(2);
  }
}

if (require.main === module) {
  const v = new ValidatePerCases();
  v.run().catch(err => { console.error(err); process.exit(1); });
}
