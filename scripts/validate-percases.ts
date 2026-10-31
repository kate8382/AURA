import fs from 'fs/promises';
import path from 'path';
import Ajv from 'ajv';
import { loadNoticeSources, NoticeSources, NOTICE_PATH } from './lib/notice';

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
    const isRealPath = path.resolve(p).split(path.sep).includes('real_cases');
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
        if (shape.signal_ids !== undefined && (!Array.isArray(shape.signal_ids) || shape.signal_ids.some((v: any) => typeof v !== 'string'))) {
          errors.push('declared_shape.signal_ids must be a string array when present');
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
