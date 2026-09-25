import fs from 'fs/promises';
import path from 'path';
import { reorderCaseKeys, deriveSignalId } from './utils';
import GenerateTriggerWeights from './generate-trigger-weights';
import { DEFAULT_CONFIDENCE } from './recalc_confidence';
import { getSharedExtractor, normalizeTriggerIdentity } from './extract-triggers';

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

  /**
   * maybeExtractTriggers (opt-in via `--extract-triggers`)
   * Inspects `scenarios[].text` with the lightweight rule-based extractor and
   * augments `scenarios[].triggers`. Existing triggers are preserved exactly
   * (never replaced, reordered, or respelled); extracted canonical labels are
   * appended after them, deduplicated by normalized trigger identity. Missing
   * or empty `triggers` are populated only when extraction finds candidates.
   * In dry-run mode the additions are previewed (`[dry] WOULD ADD triggers
   * <case> scenario <i>`) and callers still skip all writes.
   */
  private maybeExtractTriggers(obj: AnyObj, fileLabel: string) {
    if (!process.argv.includes('--extract-triggers')) return;
    const scenarios = (obj as AnyObj).scenarios;
    if (!Array.isArray(scenarios)) return;
    // Throws clearly on broken extraction configuration (never silent).
    const extractor = getSharedExtractor();
    const caseLabel = typeof obj.case_id === 'string' && obj.case_id ? obj.case_id : fileLabel;
    scenarios.forEach((s: AnyObj, idx: number) => {
      if (!s || typeof s !== 'object') return;
      // Operates on scenario.text only; scenario.name is never evidence.
      const candidates = extractor.extract(s.text);
      if (candidates.length === 0) return;
      const existing: unknown[] = Array.isArray(s.triggers) ? s.triggers : [];
      const seen = new Set<string>();
      for (const t of existing) {
        const n = normalizeTriggerIdentity(t);
        if (n) seen.add(n);
      }
      const added: string[] = [];
      for (const c of candidates) {
        const n = normalizeTriggerIdentity(c);
        if (n && !seen.has(n)) {
          seen.add(n);
          added.push(c);
        }
      }
      if (added.length === 0) return;
      if (this.dry) {
        console.log(`[dry] WOULD ADD triggers ${caseLabel} scenario ${idx}:`);
        for (const a of added) console.log(`  - ${a}`);
      }
      // In-memory only; dry-run callers skip all file writes.
      if (Array.isArray(s.triggers)) s.triggers.push(...added);
      else s.triggers = added.slice();
    });
  }

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
        if (typeof obj.confidence === 'undefined') obj.confidence = DEFAULT_CONFIDENCE;
        // Ensure decision field exists; default to 'pending' when normalizing
        if (typeof obj.decision === 'undefined') obj.decision = 'pending';

        // Opt-in trigger extraction (must run before signal-ID derivation so
        // newly extracted triggers participate in it).
        this.maybeExtractTriggers(obj, filePath);

        // Optionally (re)generate signal_ids for the case when requested.
        // IMPORTANT: when --apply-signal-ids is present we recompute based on
        // current `scenarios[].triggers` — this overwrites existing `signal_ids`
        // to avoid drift between triggers and signal_ids.
        if (process.argv.includes('--apply-signal-ids')) {
          try {
            const gw = new GenerateTriggerWeights(process.cwd());
            gw.loadSignalMapping();
            const sset = new Set<string>();
            if (Array.isArray(obj.scenarios)) {
              for (const s of obj.scenarios) {
                if (!s || !Array.isArray(s.triggers)) continue;
                for (const t of s.triggers) {
                  const n = gw.normalizeTrigger(t);
                  if (!n) continue;
                  const sid = (gw as any).signalMap[n];
                  if (sid) sset.add(sid);
                  else sset.add(deriveSignalId(n));
                }
              }
            }
            const arr = Array.from(sset);
            if (arr.length) obj.signal_ids = arr;
            else {
              // empty result: clear existing signal_ids to avoid stale mappings
              if (Array.isArray(obj.signal_ids) && obj.signal_ids.length > 0) {
                if (this.dry) console.log(`[dry] WOULD CLEAR signal_ids for ${obj.case_id || filePath}`);
                else {
                  obj.signal_ids = [];
                }
              }
            }
          } catch (err) {
            const msg = (err as any && (err as any).message) ? (err as any).message : String(err);
            console.error('Error generating signal_ids for', obj.case_id || filePath, msg);
            if (this.dry) {
              console.warn(`Dry-run: signal_ids were NOT calculated for ${obj.case_id || filePath}: ${msg}`);
            } else {
              throw err;
            }
          }
        }

        const ordered = reorderCaseKeys(obj);
        const merged = { ...metadata, ...ordered };
        // Ensure `confidence_raw` appears at the end of the serialized object for auditability
        if (typeof ordered.confidence_raw !== 'undefined') merged.confidence_raw = ordered.confidence_raw;
        else if (typeof obj.confidence_raw !== 'undefined') merged.confidence_raw = obj.confidence_raw;
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
      if (typeof obj.confidence === 'undefined') obj.confidence = DEFAULT_CONFIDENCE;
      // Ensure decision field exists; default to 'pending' when normalizing
      if (typeof obj.decision === 'undefined') obj.decision = 'pending';

      // Opt-in trigger extraction (must run before signal-ID derivation so
      // newly extracted triggers participate in it).
      this.maybeExtractTriggers(obj, filePath);

      // Optionally (re)generate signal_ids for the case when requested.
      if (process.argv.includes('--apply-signal-ids')) {
        try {
          const gw = new GenerateTriggerWeights(process.cwd());
          gw.loadSignalMapping();
          const sset = new Set<string>();
          if (Array.isArray(obj.scenarios)) {
            for (const s of obj.scenarios) {
              if (!s || !Array.isArray(s.triggers)) continue;
              for (const t of s.triggers) {
                const n = gw.normalizeTrigger(t);
                if (!n) continue;
                const sid = (gw as any).signalMap[n];
                if (sid) sset.add(sid);
                else sset.add(deriveSignalId(n));
              }
            }
          }
          const arr = Array.from(sset);
          if (arr.length) obj.signal_ids = arr;
          else {
            if (Array.isArray(obj.signal_ids) && obj.signal_ids.length > 0) {
              if (this.dry) console.log(`[dry] WOULD CLEAR signal_ids for ${obj.case_id || filePath}`);
              else obj.signal_ids = [];
            }
          }
        } catch (err) {
          const msg = (err as any && (err as any).message) ? (err as any).message : String(err);
          console.error('Error generating signal_ids for', obj.case_id || filePath, msg);
          if (this.dry) {
            console.warn(`Dry-run: signal_ids were NOT calculated for ${obj.case_id || filePath}: ${msg}`);
          } else {
            throw err;
          }
        }
      }
      const ordered = reorderCaseKeys(obj);
      const merged = { ...metadata, ...ordered };
      // Ensure `confidence_raw` appears at the end of the serialized object for auditability
      if (typeof ordered.confidence_raw !== 'undefined') merged.confidence_raw = ordered.confidence_raw;
      else if (typeof obj.confidence_raw !== 'undefined') merged.confidence_raw = obj.confidence_raw;
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
