import fs from 'fs/promises';
import path from 'path';
import { reorderCaseKeys } from './utils';

type AnyObj = { [k: string]: any };

/** NormalizePerCases - класс для нормализации per-case файлов: распаковывает обёртки (MANIPULATION/FRAUD/ACCESS) и приводит к каноническому порядку ключей. */

export class NormalizePerCases {
  dry: boolean;
  constructor(dry = false) { this.dry = dry; }

  // Recursively walk a directory and process each JSON file
  async walkDir(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await this.walkDir(full);
      else if (ent.isFile() && ent.name.endsWith('.json')) await this.processFile(full);
    }
  }

  // Canonical ordering is provided by `reorderCaseKeys` from scripts/utils.ts
  async processFile(filePath: string) {
    const raw = await fs.readFile(filePath, 'utf8');
    let data: AnyObj;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error("Invalid JSON:", filePath, e);
      return;
    }

    // find category wrapper keys (uppercase words)
    const topKeys = Object.keys(data);
    const categoryKey = topKeys.find(k => Array.isArray((data as AnyObj)[k]) && /^[A-Z_]+$/.test(k));

    let caseObjs: AnyObj[] = [];
    if (categoryKey) {
      const arr = (data as AnyObj)[categoryKey];
      if (Array.isArray(arr)) caseObjs = arr;
    } else if ((data as AnyObj).case_id) {
      caseObjs = [(data as AnyObj)];
      for (const k of ['export_date', 'source', 'anonymized']) delete (data as AnyObj)[k];
    } else {
      for (const k of Object.keys(data)) {
        const v = (data as AnyObj)[k];
        if (Array.isArray(v)) {
          for (const item of v) if (item && typeof item === 'object' && item.case_id) caseObjs.push(item);
        } else if (v && typeof v === 'object' && v.case_id) caseObjs.push(v);
      }
    }

    if (caseObjs.length === 0) return;

    const metadata: AnyObj = {};
    for (const k of ['export_date', 'source', 'anonymized']) {
      if (k in data) metadata[k] = (data as AnyObj)[k];
    }

    if (caseObjs.length > 1) {
      const dir = path.dirname(filePath);
      const base = path.basename(filePath, '.json');
      for (let i = 0; i < caseObjs.length; i++) {
        let obj = caseObjs[i];
        if ('behavioral_pattern' in obj && !('behavioral_patterns' in obj)) {
          const tmp: AnyObj = {};
          for (const key of Object.keys(obj)) {
            if (key === 'behavioral_pattern') tmp['behavioral_patterns'] = obj[key];
            else tmp[key] = obj[key];
          }
          obj = tmp;
        }
        // If confidence_raw missing but confidence present, keep it; otherwise initialize
        if (typeof obj.confidence_raw === 'undefined' && typeof obj.confidence === 'number') obj.confidence_raw = obj.confidence;
        // Ensure confidence default after cross_check if missing
        if (typeof obj.confidence === 'undefined') obj.confidence = 0.95;

        const ordered = reorderCaseKeys(obj);
        const merged = { ...metadata, ...ordered };
        const newName = `${base}-${i+1}.json`;
        const outPath = path.join(dir, newName);
        if (this.dry) console.log("[dry] WOULD WRITE", outPath);
        else {
          await fs.writeFile(outPath, JSON.stringify(merged, null, 2), 'utf8');
          console.log("WROTE", outPath);
        }
      }
      if (this.dry) console.log('[dry] WOULD REMOVE original', filePath);
      else {
        await fs.unlink(filePath);
        console.log("REMOVED original", filePath);
      }
    } else {
      let obj = caseObjs[0];
      if ('behavioral_pattern' in obj && !('behavioral_patterns' in obj)) {
        const orderedTmp: AnyObj = {};
        for (const key of Object.keys(obj)) {
          if (key === 'behavioral_pattern') orderedTmp['behavioral_patterns'] = obj[key];
          else orderedTmp[key] = obj[key];
        }
        obj = orderedTmp;
      }
      if (typeof obj.confidence_raw === 'undefined' && typeof obj.confidence === 'number') obj.confidence_raw = obj.confidence;
      if (typeof obj.confidence === 'undefined') obj.confidence = 0.95;
      const ordered = reorderCaseKeys(obj);
      const merged = { ...metadata, ...ordered };
      if (this.dry) console.log("[dry] WOULD NORMALIZE", filePath);
      else {
        await fs.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf8');
        console.log('NORMALIZED', filePath);
      }
    }
  }

  // Run the normalization process on a target directory (or default to public_cases)
  async run(target?: string) {
    const envDir = process.env.CASES_DIR;
    const dir = envDir || target || process.argv[2] || 'public_cases';
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) if (argv[i] === '-d' || argv[i] === '--dir') dir && (argv[i+1]);
    const dry = process.argv.includes('--dry-run');
    if (dry) this.dry = true;
    if (this.dry) console.log("Dry-run mode: no files will be written.");
    await this.walkDir(dir);
  }
}

if (require.main === module) {
  const N = new NormalizePerCases(process.argv.includes('--dry-run'));
  N.run().catch(err => { console.error(err); process.exit(1); });
}
