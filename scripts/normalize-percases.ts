import fs from 'fs/promises';
import path from 'path';
import { reorderCaseKeys, deriveSignalId } from './core/utils';
import GenerateTriggerWeights from './generate-trigger-weights';
import { DEFAULT_CONFIDENCE } from './recalc_confidence';
import { getSharedExtractor, normalizeTriggerIdentity, defaultRepoRoot } from './extract-triggers';
import { logError, runCli } from './core/logger';
import { ValidatePerCases } from './validate-percases';
import { assertRealWriteAllowed, DEFAULT_CASES_DIR, getDirOption } from './lib/cases-cli';
import {
  BulkConcurrencyOptions,
  createWriteLimiter,
  parseConcurrencyOptions,
  runWithConcurrency,
  walkJsonFilesAsync,
  writeFileWithBackup,
  WriteLimiter,
} from './lib/bulk-io';

type AnyObj = { [k: string]: any };

export interface ProcessFileOptions {
  backup?: boolean;
  writeLimiter?: WriteLimiter;
}

/** NormalizePerCases - класс для нормализации per-case файлов: распаковывает обёртки (MANIPULATION/FRAUD/ACCESS) и приводит к каноническому порядку ключей. */
export class NormalizePerCases {
  dry: boolean;
  // Files that failed; run() reports them and fails after processing everything.
  failures: string[] = [];
  private metadataValidator = new ValidatePerCases();
  private cachedMapper: GenerateTriggerWeights | null = null;
  private cachedMapperPromise: Promise<GenerateTriggerWeights> | null = null;
  constructor(dry = false) { this.dry = dry; }

  /** Lazily loads and caches a single `GenerateTriggerWeights` signal mapper across all files/cases. */
  private async getSignalMapper(): Promise<GenerateTriggerWeights> {
    if (this.cachedMapper) return this.cachedMapper;
    if (!this.cachedMapperPromise) {
      this.cachedMapperPromise = (async () => {
        const repoRoot = defaultRepoRoot();
        const gw = new GenerateTriggerWeights(repoRoot || process.cwd());
        await gw.loadSignalMappingAsync();
        this.cachedMapper = gw;
        return gw;
      })();
    }
    return this.cachedMapperPromise;
  }

  // Logs invalid optional metadata and marks the file failed; values are never rewritten.
  private rejectInvalidMetadata(obj: AnyObj, filePath: string): boolean {
    const errors = this.metadataValidator.validateOptionalMetadata(obj);
    if (errors.length === 0) return false;
    logError('invalid optional metadata', { file: filePath, case_id: obj.case_id, error: errors.join('; ') });
    this.failures.push(filePath);
    return true;
  }

  /**
   * Walks `dir` asynchronously using `fs/promises` and processes all `.json` files
   * with bounded concurrency and optional rate-limited writes / per-file backups.
   */
  async walkDir(dir: string, options: Partial<BulkConcurrencyOptions> = {}) {
    // 1. Pre-warm shared resources once before spawning workers
    if (process.argv.includes('--extract-triggers')) {
      getSharedExtractor();
    }
    if (process.argv.includes('--apply-signal-ids')) {
      await this.getSignalMapper();
    }

    // 2. Discover JSON files iteratively and process with bounded concurrency
    const concurrency = options.concurrency ?? 1;
    const writeLimiter = createWriteLimiter(options.writeDelayMs ?? 0);
    const backup = options.backup ?? false;
    const files = await walkJsonFilesAsync(dir);
    await runWithConcurrency(files, concurrency, (filePath) =>
      this.processFile(filePath, { backup, writeLimiter })
    );
  }

  // Canonical ordering is provided by `reorderCaseKeys` from scripts/core/utils.ts

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

  /**
   * Normalizes a single case object: renames `behavioral_pattern`, validates optional metadata,
   * sets defaults, optionally extracts triggers and derives `signal_ids`, and returns the ordered object.
   * Returns `null` if metadata validation or signal-id generation fails (and records the failure).
   */
  private async prepareNormalizedCase(rawObj: AnyObj, metadata: AnyObj, filePath: string): Promise<AnyObj | null> {
    // 1. Rename singular `behavioral_pattern` to `behavioral_patterns` while preserving key order
    let obj = rawObj;
    if ('behavioral_pattern' in obj && !('behavioral_patterns' in obj)) {
      const tmp: AnyObj = {};
      for (const key of Object.keys(obj)) {
        if (key === 'behavioral_pattern') tmp['behavioral_patterns'] = obj[key];
        else tmp[key] = obj[key];
      }
      obj = tmp;
    }

    // 2. Validate optional metadata and populate default confidence / decision fields
    if (this.rejectInvalidMetadata(obj, filePath)) return null;
    if (typeof obj.confidence_raw === 'undefined' && typeof obj.confidence === 'number') obj.confidence_raw = obj.confidence;
    if (typeof obj.confidence === 'undefined') obj.confidence = DEFAULT_CONFIDENCE;
    if (typeof obj.decision === 'undefined') obj.decision = 'pending';

    // 3. Opt-in trigger extraction (must run before signal-ID derivation)
    this.maybeExtractTriggers(obj, filePath);

    // 4. Optionally (re)generate signal_ids using the cached signal mapper
    if (process.argv.includes('--apply-signal-ids')) {
      try {
        const gw = await this.getSignalMapper();
        const sset = new Set<string>();
        if (Array.isArray(obj.scenarios)) {
          for (const s of obj.scenarios) {
            if (!s || !Array.isArray(s.triggers)) continue;
            for (const t of s.triggers) {
              const n = gw.normalizeTrigger(t);
              if (!n) continue;
              const sid = gw.signalMap[n];
              if (sid) sset.add(sid);
              else sset.add(deriveSignalId(n));
            }
          }
        }
        const arr = Array.from(sset);
        if (arr.length) obj.signal_ids = arr;
        else if (Array.isArray(obj.signal_ids) && obj.signal_ids.length > 0) {
          if (this.dry) console.log(`[dry] WOULD CLEAR signal_ids for ${obj.case_id || filePath}`);
          else obj.signal_ids = [];
        }
      } catch (err) {
        logError('cannot generate signal_ids', { file: filePath, case_id: obj.case_id, error: err });
        this.failures.push(filePath);
        return null;
      }
    }

    // 5. Reorder keys and append `confidence_raw` at the end for auditability
    const ordered = reorderCaseKeys(obj);
    const merged = { ...metadata, ...ordered };
    if (typeof ordered.confidence_raw !== 'undefined') merged.confidence_raw = ordered.confidence_raw;
    else if (typeof obj.confidence_raw !== 'undefined') merged.confidence_raw = obj.confidence_raw;
    return merged;
  }

  async processFile(filePath: string, options: ProcessFileOptions = {}) {
    const raw = await fs.readFile(filePath, 'utf8');
    let data: AnyObj;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      logError('invalid JSON', { file: filePath, error: e });
      this.failures.push(filePath);
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

    const writeOpts = {
      backup: options.backup ?? false,
      writeLimiter: options.writeLimiter,
    };

    if (caseObjs.length > 1) {
      const dir = path.dirname(filePath);
      const base = path.basename(filePath, '.json');
      let fileFailed = false;
      for (let i = 0; i < caseObjs.length; i++) {
        const merged = await this.prepareNormalizedCase(caseObjs[i], metadata, filePath);
        if (!merged) {
          fileFailed = true;
          continue;
        }
        const newName = `${base}-${i + 1}.json`;
        const outPath = path.join(dir, newName);
        if (this.dry) console.log('[dry] WOULD WRITE', outPath);
        else {
          await writeFileWithBackup(outPath, JSON.stringify(merged, null, 2), writeOpts);
          console.log('WROTE', outPath);
        }
      }
      if (fileFailed) return; // keep the original so no case is lost
      if (this.dry) console.log('[dry] WOULD REMOVE original', filePath);
      else {
        await fs.unlink(filePath);
        console.log('REMOVED original', filePath);
      }
    } else {
      const merged = await this.prepareNormalizedCase(caseObjs[0], metadata, filePath);
      if (!merged) return;
      if (this.dry) console.log('[dry] WOULD NORMALIZE', filePath);
      else {
        await writeFileWithBackup(filePath, JSON.stringify(merged, null, 2), writeOpts);
        console.log('NORMALIZED', filePath);
      }
    }
  }

  // Run the normalization process on a target directory (or default to synthetic_cases)
  async run(target?: string) {
    const argv = process.argv.slice(2);
    const positional = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined;
    const dirOption = getDirOption(argv);
    const dir = path.resolve(dirOption || process.env.CASES_DIR || target || positional || DEFAULT_CASES_DIR);
    assertRealWriteAllowed(dir, argv);
    const dry = process.argv.includes('--dry-run');
    if (dry) this.dry = true;
    const concurrencyOpts = parseConcurrencyOptions(argv);
    if (this.dry) console.log('Dry-run mode: no files will be written.');
    await this.walkDir(dir, concurrencyOpts);
    if (this.failures.length > 0) {
      throw new Error(`${this.failures.length} file(s) failed: ${this.failures.join(', ')}`);
    }
  }
}

if (require.main === module) {
  const N = new NormalizePerCases(process.argv.includes('--dry-run'));
  runCli(() => N.run());
}
