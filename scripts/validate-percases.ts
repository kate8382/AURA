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

  // Run the validation process on a target directory (or default to public_cases)
  async run(targetDir?: string) {
    const schema = await this.loadSchema();
    const validate = this.ajv.compile(schema);
    const envDir = process.env.CASES_DIR;
    const target = envDir || targetDir || process.argv[2] || 'public_cases';
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '-d' || a === '--dir') { TargetHelper.setTarget(argv[i + 1]); break; } // TargetHelper.setTarget is a placeholder for compatibility with earlier argument parsing style
    }

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

// Helper to satisfy earlier argument parsing style without large change
const TargetHelper = {
  setTarget(_: string | undefined) { /* placeholder for compatibility */ }
};

if (require.main === module) {
  const v = new ValidatePerCases();
  v.run().catch(err => { console.error(err); process.exit(1); });
}
