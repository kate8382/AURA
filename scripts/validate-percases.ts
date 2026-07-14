// Script to validate per-case JSON files against the schema
import fs from 'fs/promises';
import path from 'path';
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

async function loadSchema() {
  const s = await fs.readFile(path.join(__dirname, '..', 'schemas', 'per-case-schema.json'), 'utf8');
  return JSON.parse(s);
}

async function walk(dir: string, cb: (p: string) => Promise<void>) {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, cb);
    else if (e.isFile() && e.name.endsWith('.json')) await cb(full);
  }
}

async function main() {
  const schema = await loadSchema();
  const validate = ajv.compile(schema);
  // directory can be provided as first arg, -d/--dir, or via CASES_DIR env var
  const envDir = process.env.CASES_DIR;
  let target = envDir || process.argv[2] || 'public_cases';
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-d' || a === '--dir') { target = argv[i + 1] || target; break; }
  }
  let errors = 0;
  const invalidFiles: Array<{file:string, errs:any}> = [];

  await walk(target, async (p) => {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const obj = JSON.parse(raw);
      const valid = validate(obj);
      if (!valid) {
        errors += 1;
        invalidFiles.push({ file: p, errs: validate.errors });
        console.log('\nINVALID:', p);
        console.log(validate.errors);
      }
    } catch (e:any) {
      errors += 1;
      invalidFiles.push({ file: p, errs: e.message });
      console.log('\nERROR reading/parsing:', p, e.message);
    }
  });

  console.log('\nValidation complete. Invalid files:', errors);
  if (errors > 0) process.exit(2);
}

main().catch(err => { console.error(err); process.exit(1); });
