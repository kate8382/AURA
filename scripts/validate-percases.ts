import fs from 'fs/promises';
import path from 'path';
import Ajv from 'ajv';

// ValidatePerCases - класс-обёртка для валидации per-case JSON файлов против схемы.
// Методы:
// - loadSchema(): загружает JSON Schema
// - walk(): рекурсивно обходит директорию
// - validateFile(): валидирует один файл
// - run(): выполняет процесс валидации для директории

export class ValidatePerCases {
  private ajv: Ajv;
  constructor() {
    this.ajv = new Ajv({ allErrors: true, strict: false });
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
  async validateFile(validate: any, p: string) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const obj = JSON.parse(raw);
      const valid = validate(obj);
      if (!valid) {
        return { ok: false, errs: validate.errors };
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
    return optionDir || positionalDir || process.env.CASES_DIR || 'public_cases';
  }

  // Run the validation process on a target directory (or default to public_cases)
  async run(targetDir?: string) {
    const schema = await this.loadSchema();
    const validate = this.ajv.compile(schema);
    const target = path.resolve(targetDir || this.parseArgs(process.argv.slice(2)));
    const targetStats = await fs.stat(target).catch(() => null);
    if (!targetStats || !targetStats.isDirectory()) throw new Error(`Directory not found: ${target}`);
    if (process.argv.includes('--dry-run')) console.log('Dry-run mode: validation does not modify files.');

    let errors = 0;
    await this.walk(target, async (p) => {
      const res = await this.validateFile(validate, p);
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
