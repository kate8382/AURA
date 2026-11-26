import fsSync from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { logError, logWarn, runCli } from './core/logger';
import { REPO_ROOT } from './lib/paths';
import { assertRealWriteAllowed, BENIGN_CASES_DIR, REAL_CASES_NAME, resolveCasesDir } from './lib/cases-cli';
import {
  createWriteLimiter,
  parseConcurrencyOptions,
  runWithConcurrency,
  walkJsonFilesAsync,
  writeFileWithBackup,
  WriteLimiter,
} from './lib/bulk-io';

interface CachedSignalMap {
  mtimeMs: number;
  size: number;
  map: Record<string, string>;
}

const signalMapCache = new Map<string, CachedSignalMap>();
const sharedGeneratorCache = new Map<string, GenerateTriggerWeights>();

/** Clears the cached signal-mapping and shared generator instances (for tests). */
export function clearSignalMapCache(): void {
  signalMapCache.clear();
  sharedGeneratorCache.clear();
}

type CountMap = { [k: string]: number };
/** Safe-case status that never contributes to attack trigger weights (benign_cases/ is also excluded by path). */
const EXCLUDED_NEGATIVE_STATUSES = ['benign'];
/**
 * GenerateTriggerWeights
 *
 * Это основной класс для генерации `config/trigger-weights.json` на основе
 * триггеров, найденных в `synthetic_cases`. Он собирает уникальные триггеры по
 * каждому кейсу, подсчитывает число кейсов, в которых встречается каждый триггер,
 * вычисляет TF‑IDF внутри экспертных категорий и выдаёт итоговую карту весов.
 *
 * Важные свойства:
 * - Используется канонический маппинг категорий из существующего `config/trigger-weights.json`.
 * - Триггеры строго привязываются к категориям (critical/high/medium/low/camo).
 * - Вес триггера = Category_Min + normalized_raw * (Category_Max - Category_Min).
 *
 * Формула raw-оценки: использована гибридная TF‑IDF‑подобная функция, чтобы избежать двух опасностей:
 *  - чисто линейного взвешивания (которое игнорирует распространенность в корпусе),
 *  - и наивного TF*IDF, который умножает на сырую df и тем самым усиливает часто встречающиеся триггеры.
 *
 *  raw = tfidfScale * log(1 + N/(df + idfSmoothing)) * log(1 + df)
 *
 * Где первая лог-часть даёт IDF‑стайл штраф для очень частых триггеров, а вторая лог‑часть
 * даёт мягкое усиление по частоте внутри категории (soft TF), не приводя к экспонентному росту.
 * Поведение:
 * - собирает уникальные триггеры по каждому кейсу (из `scenarios[].triggers`).
 *   Mapped `signal_ids` не разворачиваются автоматически при генерации; используйте
 *   `--apply-signal-ids` / `gen:triggers:apply` чтобы применить `signal_ids` в файлах кейсов.
 * - считает число кейсов, в которых встречается каждый триггер,
 * - нормализует строки (trim + toLowerCase),
 * - вычисляет гибридную raw-оценку (см. формулу выше) для каждого триггера, затем нормализует
 *   значения `raw` внутри каждой категории в диапазон [0..1] (см. обработку single-item ниже) и
 *   линейно отображает нормализованные значения в настроенные диапазоны категории (Category_Min..Category_Max),
 * - записывает результат в `config/trigger-weights.json` и создаёт резервную копию предыдущего.
 */
export class GenerateTriggerWeights {
  // Highest weight for the most frequently occurring trigger
  repoRoot: string;
  // Lowest weight for the least frequently occurring trigger
  topWeight = 0.05;
  // Minimum weight for the least frequently occurring trigger
  minWeight = 0.01;
  // Weight for a question in cross_check
  crossCheckWeight = 0.005;
  // Weight for the presence of a signal_id
  signalIdWeight = 0.01;
  // Maximum cumulative boost
  maxBoost = 0.1;
    // Smoothing for IDF (default 1)
    idfSmoothing = 1;
    // Sensitivity multiplier for the hybrid TF-IDF-like raw score (before normalization)
    tfidfScale = 1.5;

  constructor(repoRoot?: string) {
    this.repoRoot = repoRoot || REPO_ROOT;
  }
  signalMap: Record<string, string> = {};
  private signalMapLoaded = false;
  // Files that could not be processed; run() aborts before writing when this is non-empty.
  fileErrors: string[] = [];

  /** Populates `this.signalMap` from parsed `signal-mapping.json` data and caches it by `repoRoot` + file stat. */
  private populateSignalMap(parsed: any, stat: { mtimeMs: number; size: number }): void {
    const mapped: Record<string, string> = {};
    const signals = (parsed && parsed.signals) ? parsed.signals : {};
    for (const sid of Object.keys(signals)) {
      const val = signals[sid];
      const arr = Array.isArray(val) ? val : (val && Array.isArray(val.triggers) ? val.triggers : []);
      for (const t of arr) {
        if (typeof t !== 'string') continue;
        const n = this.normalizeTrigger(t);
        if (n) mapped[n] = sid;
      }
    }
    this.signalMap = { ...mapped };
    signalMapCache.set(path.resolve(this.repoRoot), {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      map: mapped,
    });
    this.signalMapLoaded = true;
  }

  /** Synchronously loads and caches `config/signal-mapping.json` for this `repoRoot`, invalidating on file change. */
  loadSignalMapping() {
    const cacheKey = path.resolve(this.repoRoot);
    const mapPath = path.join(this.repoRoot, 'config', 'signal-mapping.json');
    let stat: fsSync.Stats;
    try {
      stat = fsSync.statSync(mapPath);
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        signalMapCache.delete(cacheKey);
        if (!this.signalMapLoaded) {
          logWarn('signal mapping not found, signal ids will not be mapped', { file: mapPath });
          this.signalMapLoaded = true;
        }
        return;
      }
      throw new Error(`cannot read signal mapping ${mapPath}: ${err instanceof Error ? err.message : err}`);
    }

    const cached = signalMapCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.signalMap = { ...cached.map };
      this.signalMapLoaded = true;
      return;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(fsSync.readFileSync(mapPath, 'utf8'));
    } catch (err) {
      throw new Error(`cannot read signal mapping ${mapPath}: ${err instanceof Error ? err.message : err}`);
    }
    this.populateSignalMap(parsed, stat);
  }

  /** Asynchronously loads and caches `config/signal-mapping.json` using `fs/promises`, invalidating on file change. */
  async loadSignalMappingAsync(): Promise<void> {
    const cacheKey = path.resolve(this.repoRoot);
    const mapPath = path.join(this.repoRoot, 'config', 'signal-mapping.json');
    let stat: fsSync.Stats;
    try {
      stat = await fs.stat(mapPath);
    } catch (err: any) {
      if (err && err.code === 'ENOENT') {
        signalMapCache.delete(cacheKey);
        if (!this.signalMapLoaded) {
          logWarn('signal mapping not found, signal ids will not be mapped', { file: mapPath });
          this.signalMapLoaded = true;
        }
        return;
      }
      throw new Error(`cannot read signal mapping ${mapPath}: ${err instanceof Error ? err.message : err}`);
    }

    const cached = signalMapCache.get(cacheKey);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.signalMap = { ...cached.map };
      this.signalMapLoaded = true;
      return;
    }

    let parsed: any;
    try {
      const raw = await fs.readFile(mapPath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`cannot read signal mapping ${mapPath}: ${err instanceof Error ? err.message : err}`);
    }
    this.populateSignalMap(parsed, stat);
  }

  /** detectCategory
   * Returns the canonical category based on the section header string.
   * Used when reconstructing the section structure from an existing config.
   */
  private detectCategory(hdr: string) {
    const s = String(hdr || '').toLowerCase();
    if (s.includes('critical')) return 'critical';
    if (s.includes('high')) return 'high';
    if (s.includes('medium')) return 'medium';
    if (s.includes('low')) return 'low';
    if (s.includes('camouflage') || s.includes('weak')) return 'camo';
    return 'camo';
  }

  /** Asynchronously walks through a directory and returns a sorted list of all JSON files.
   * Returns an empty array if the directory does not exist.
   */
  async walkDir(dir: string): Promise<string[]> {
    return walkJsonFilesAsync(dir);
  }

  /**
   * Extracts case objects from a file asynchronously using `fs/promises`.
   * Supports multiple input file formats:
   * - files where the top-level key is `MANIPULATION`/`FRAUD`/`ACCESS` (array of cases),
   * - a single case (object with `case_id`),
   * - files with nested objects/arrays containing objects with `case_id`.
   */
  async extractCasesFromFile(file: string): Promise<any[]> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const data = JSON.parse(raw);
      const cases: any[] = [];
      const topKeys = Object.keys(data || {});
      const categoryKeys = topKeys.filter(k => ['MANIPULATION', 'FRAUD', 'ACCESS'].includes(k));
      if (categoryKeys.length) {
        for (const k of categoryKeys) {
          const arr = (data as any)[k] || [];
          if (Array.isArray(arr)) cases.push(...arr);
        }
        return cases;
      }
      if (data && typeof data === 'object' && (data as any).case_id) return [data];

      for (const k of Object.keys(data || {})) {
        const v = (data as any)[k];
        if (Array.isArray(v)) {
          for (const item of v) if (item && typeof item === 'object' && item.case_id) cases.push(item);
        } else if (v && typeof v === 'object' && v.case_id) cases.push(v);
      }
      return cases;
    } catch (err) {
      logError('cannot read case file', { file, error: err });
      this.fileErrors.push(file);
      return [];
    }
  }

  /**
   * Normalizes a trigger to its canonical form: trim + toLowerCase.
   * Returns `null` for invalid values.
   */
  normalizeTrigger(t: unknown): string | null {
    if (!t || typeof t !== 'string') return null;
    let s = t.trim().toLowerCase();
    // strip common trailing tokens like ' request' to match existing curated keys
    s = s.replace(/\s+request$/i, '');
    // collapse multiple spaces
    s = s.replace(/\s+/g, ' ');
    return s;
  }

  /**
   * Generate `signal_ids` from scenarios using the TRIGGER_TO_SIGNAL_MAP.
   * Returns unique list of signal ids.
   */
  generateSignalIdsFromScenarios(scenarios: any[]): string[] {
    const set = new Set<string>();
    if (!Array.isArray(scenarios)) return [];
    // ensure mapping loaded
    if (!this.signalMap || Object.keys(this.signalMap).length === 0) this.loadSignalMapping();
    for (const s of scenarios) {
      if (!s || !Array.isArray(s.triggers)) continue;
      for (const t of s.triggers) {
        const n = this.normalizeTrigger(t);
        if (!n) continue;
        const sid = (this.signalMap as any)[n];
        if (sid) set.add(sid);
      }
    }
    return Array.from(set);
  }

  /**
   * Asynchronously writes the final JSON config to `config/trigger-weights.json`, creating a backup
   * of the previous version as `trigger-weights.json.bak`.
   */
  async writeConfig(payload: any, writeLimiter?: WriteLimiter): Promise<string> {
    const cfgDir = path.join(this.repoRoot, 'config');
    await fs.mkdir(cfgDir, { recursive: true });
    const outPath = path.join(cfgDir, 'trigger-weights.json');
    await writeFileWithBackup(outPath, JSON.stringify(payload, null, 2), {
      backup: true,
      writeLimiter,
    });
    return outPath;
  }

  /**
   * Main run: searches for all JSON files in `synthetic_cases` (or in the `--dir` / `CASES_DIR` override),
   * optionally adds `real_cases` with `--include-real`, collects trigger statistics, computes weights, and writes the config.
   */
  async run(argv: string[] = process.argv.slice(2)) {
    const concurrencyOpts = parseConcurrencyOptions(argv);
    const writeLimiter = createWriteLimiter(concurrencyOpts.writeDelayMs);
    const dirs = [resolveCasesDir(argv, this.repoRoot)];
    if (argv.includes('--include-real')) dirs.push(path.resolve(this.repoRoot, REAL_CASES_NAME));
    const uniqueDirs = [...new Set(dirs)];
    const perDirFiles = await Promise.all(uniqueDirs.map((d) => walkJsonFilesAsync(d)));
    // Safe cases (benign_cases/, including clarify/) must never raise attack weights.
    const files = [...new Set(perDirFiles.flat())]
      .filter((f) => !path.resolve(f).split(path.sep).includes(BENIGN_CASES_DIR))
      .sort((a, b) => a.localeCompare(b));

    const perFileCases = await runWithConcurrency(
      files,
      concurrencyOpts.concurrency,
      (f) => this.extractCasesFromFile(f)
    );
    const counts: CountMap = Object.create(null);
    let totalCases = 0;
    for (const rawCases of perFileCases) {
      const cases = rawCases.filter((c: any) => !EXCLUDED_NEGATIVE_STATUSES.includes(c?.negative_labels?.status));
      totalCases += cases.length;
      for (const c of cases) {
        const uniq = new Set<string>();
        if (Array.isArray((c as any).scenarios)) {
          for (const s of (c as any).scenarios) {
            if (s && Array.isArray(s.triggers)) for (const t of s.triggers) {
              const n = this.normalizeTrigger(t);
              if (n) uniq.add(n);
            }
          }
        }
        // Count unique triggers per case only (not signal_ids).
        for (const trig of uniq) counts[trig] = (counts[trig] || 0) + 1;
      }
    }
    if (this.fileErrors.length > 0) {
      throw new Error(`${this.fileErrors.length} case file(s) could not be read; trigger weights were not written`);
    }
    // Preserve existing triggers from current config so we don't drop keys that are expected by other parts of the code/tests.
    const cfgPath = path.join(this.repoRoot, 'config', 'trigger-weights.json');
    let existingConfig: any = null;
    const preservedSections: Record<string, any> = {};
    let existingConfigRaw: string | null = null;
    try {
      existingConfigRaw = await fs.readFile(cfgPath, 'utf8');
    } catch (err: any) {
      if (!err || err.code !== 'ENOENT') {
        throw new Error(`cannot read existing config ${cfgPath}; refusing to regenerate without its curated keys: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (existingConfigRaw !== null) {
      try {
        const parsed = JSON.parse(existingConfigRaw);
        existingConfig = parsed;
        if (parsed && parsed.triggerWeights && typeof parsed.triggerWeights === 'object') {
          for (const k of Object.keys(parsed.triggerWeights)) {
            const s = String(k || '').trim();
            // preserve section headers verbatim but do not count them as triggers
            if (s.startsWith('===')) {
              preservedSections[k] = parsed.triggerWeights[k];
              continue;
            }
            // Skip SID-like keys when preserving
            if (/^sig[-_]/i.test(k)) continue;
            if (!(k in counts)) counts[k] = 0;
          }
        }
      } catch (err) {
        throw new Error(`cannot read existing config ${cfgPath}; refusing to regenerate without its curated keys: ${err instanceof Error ? err.message : err}`);
      }
    }

    // totalCases computed above in the main pass

    // Tier-based TF-IDF mapping
    const CATEGORY_RANGES: Record<string, { lower: number; upper: number }> = {
      critical: { lower: 0.50, upper: 0.60 },
      high: { lower: 0.30, upper: 0.40 },
      medium: { lower: 0.15, upper: 0.20 },
      low: { lower: 0.04, upper: 0.05 },
      camo: { lower: 0.01, upper: 0.03 }
    };

    // use this.detectCategory helper defined on the class

    // Build category mapping from existingConfig sections
    const triggerCategory: Record<string, string> = {};
    if (existingConfig && existingConfig.triggerWeights && typeof existingConfig.triggerWeights === 'object') {
      let currentCat = 'camo';
      for (const k of Object.keys(existingConfig.triggerWeights)) {
        const s = String(k || '').trim();
        if (s.startsWith('===')) {
          currentCat = this.detectCategory(s);
          continue;
        }
        if (/^sig[-_]/i.test(k)) continue;
        triggerCategory[k] = currentCat;
      }
    }

    // canonical mapping: enforce expert-assigned categories for known critical/high/medium/low triggers
    const canonicalCategoryMap: Record<string, string> = {
      'actionable payload': 'critical',
      'actionable hardware exploit': 'critical',
      'functional exploit / weaponization': 'critical',

      'automated exploitation': 'high',
      'privilege escalation': 'high',
      'direct fraud intent': 'high',
      'security control evasion': 'high',

      'automated reconnaissance / osint': 'medium',

      'compliance evasion': 'low',
      'false naivety / persona discrepancy': 'low',
      'unjustified domain knowledge': 'low'
    };

    // apply canonical map only for triggers that don't already have a category
    for (const k of Object.keys(canonicalCategoryMap)) {
      if (!triggerCategory[k]) triggerCategory[k] = canonicalCategoryMap[k];
    }

    // default any remaining missing triggers into camo (also map camo/alibi heuristics)
    for (const t of Object.keys(counts)) {
      if (triggerCategory[t]) continue;
      // Default all remaining unmapped triggers to `camo` (weak/benign heuristics)
      triggerCategory[t] = 'camo';
    }

    // compute TF‑IDF-like score per trigger (favor rare but important triggers)
    // Use inverse document frequency style scoring (do NOT multiply by df).
    const N = Math.max(1, totalCases);
    const rawPerTrig: Record<string, number> = {};
    for (const t of Object.keys(counts)) {
      const df = Math.max(0, counts[t] || 0);
      if (df <= 0) {
        rawPerTrig[t] = 0;
      } else {
        // hybrid score: IDF-style term downweights very common terms, but include
        // a soft TF component so that within the same category more frequent
        // triggers tend to score higher. Use log(1+df) as a gentle TF factor.
        rawPerTrig[t] = this.tfidfScale * Math.log(1 + N / (df + this.idfSmoothing)) * Math.log(1 + df);
      }
    }

    // group raws by category
    const perCat: Record<string, number[]> = {};
    for (const t of Object.keys(rawPerTrig)) {
      const c = triggerCategory[t] || 'camo';
      perCat[c] = perCat[c] || [];
      perCat[c].push(rawPerTrig[t]);
    }

    const perCatMinMax: Record<string, { min: number; max: number }> = {};
    for (const c of Object.keys(perCat)) {
      const arr = perCat[c];
      perCatMinMax[c] = { min: Math.min(...arr), max: Math.max(...arr) };
    }

    // Build ordered output: for each expert category (in preferred order)
    // insert header then sorted triggers for that category.
    const CATEGORY_ORDER = ['critical', 'high', 'medium', 'low', 'camo'];
    const headerForCategory: Record<string, string | null> = {};
    for (const hk of Object.keys(preservedSections)) {
      const cat = this.detectCategory(hk);
      headerForCategory[cat] = hk;
    }

    const triggerWeights: Record<string, any> = {};
    for (const cat of CATEGORY_ORDER) {
      // header
      const hk = headerForCategory[cat];
      if (hk) triggerWeights[hk] = preservedSections[hk];

      // collect triggers for this category
      const tris = Object.keys(counts).filter(t => !preservedSections[t] && (triggerCategory[t] || 'camo') === cat);
      const scored = tris.map(t => {
        const mm = perCatMinMax[cat] || { min: 0, max: 0 };
        const raw = rawPerTrig[t] || 0;
        let norm = 0;
        // If category has a single element or all raws equal, give it full normalized score
        const arr = perCat[cat] || [];
        if (arr.length <= 1 || mm.max === mm.min) {
          norm = 1;
        } else {
          norm = (raw - mm.min) / (mm.max - mm.min);
        }
        const range = CATEGORY_RANGES[cat] || CATEGORY_RANGES.camo;
        const weight = Number((range.lower + norm * (range.upper - range.lower)).toFixed(2));
        // clamp
        const clamped = Math.max(range.lower, Math.min(range.upper, weight));
        return { trig: t, weight: clamped };
      });
      scored.sort((a, b) => b.weight - a.weight || a.trig.localeCompare(b.trig));
      for (const it of scored) triggerWeights[it.trig] = it.weight;
    }
    const entries = Object.keys(triggerWeights)
      .filter(k => !preservedSections[k])
      .map(k => ({ trig: k, count: counts[k] || 0, weight: triggerWeights[k] }))
      .sort((a, b) => (b.weight || 0) - (a.weight || 0));

    // Hand-maintained routing/audit settings must survive a weights rewrite:
    // dropping `crossCheckAdapters` would silently route every pgp-verify
    // requirement back to the `noop` adapter.
    const preservedCrossCheckAdapters =
      existingConfig && typeof existingConfig.crossCheckAdapters === 'object' && existingConfig.crossCheckAdapters !== null
        ? existingConfig.crossCheckAdapters
        : undefined;
    const preservedWriteCrossCheckAudit =
      existingConfig && typeof existingConfig.writeCrossCheckAudit === 'boolean'
        ? existingConfig.writeCrossCheckAudit
        : undefined;

    const out = {
      triggerWeights,
      defaultTriggerWeight: this.minWeight,
      crossCheckWeight: this.crossCheckWeight,
      signalIdWeight: this.signalIdWeight,
      maxBoost: this.maxBoost,
      normAlpha: (existingConfig && typeof existingConfig.normAlpha === 'number') ? existingConfig.normAlpha : 0.3,
      weightMethod: 'tfidf-tiered',
      ...(preservedCrossCheckAdapters !== undefined ? { crossCheckAdapters: preservedCrossCheckAdapters } : {}),
      ...(preservedWriteCrossCheckAudit !== undefined ? { writeCrossCheckAudit: preservedWriteCrossCheckAudit } : {})
    };
    if (argv.includes('--apply-signal-ids')) dirs.forEach((d) => assertRealWriteAllowed(d, argv));
    const outPath = await this.writeConfig(out, writeLimiter);

    // CLI: optionally apply generated signal_ids back into case files
    const applySignalIds = argv.includes('--apply-signal-ids');
    if (applySignalIds) {
      await this.loadSignalMappingAsync();
      const changedFlags = await runWithConcurrency(files, concurrencyOpts.concurrency, async (f) => {
        try {
          const raw = await fs.readFile(f, 'utf8');
          const parsed = JSON.parse(raw);
          const before = JSON.stringify(parsed);

          // Iterative traversal avoids unbounded recursion on nested JSON structures.
          const stack: any[] = [parsed];
          const maxNodes = 100_000;
          let visited = 0;
          while (stack.length > 0 && visited < maxNodes) {
            const obj = stack.pop();
            visited++;
            if (!obj || typeof obj !== 'object') continue;
            if (Array.isArray(obj)) {
              for (const it of obj) stack.push(it);
              continue;
            }
            if (obj.case_id) {
              if (!Array.isArray(obj.signal_ids) || obj.signal_ids.length === 0) {
                const sids = this.generateSignalIdsFromScenarios(obj.scenarios || []);
                if (sids.length) obj.signal_ids = sids;
              }
              continue;
            }
            for (const k of Object.keys(obj)) {
              const v = obj[k];
              if (v && typeof v === 'object') stack.push(v);
            }
          }

          const after = JSON.stringify(parsed);
          if (after !== before) {
            await writeFileWithBackup(f, JSON.stringify(parsed, null, 2), {
              backup: concurrencyOpts.backup,
              writeLimiter,
            });
            return 1;
          }
          return 0;
        } catch (err) {
          logError('cannot apply signal_ids', { file: f, error: err });
          this.fileErrors.push(f);
          return 0;
        }
      });
      const changed = changedFlags.reduce<number>((sum, n) => sum + n, 0);
      console.log('Applied signal_ids to', changed, 'files');
      if (this.fileErrors.length > 0) {
        throw new Error(`${this.fileErrors.length} case file(s) failed while applying signal_ids`);
      }
    }
    return { outPath, top: entries ? entries.slice(0, 30) : [] };
  }
}

/**
 * Exported helper for external use: generate signal ids from scenarios.
 * Reuses a cached generator instance per repoRoot to avoid reloading signal-mapping.json.
 */
export function generateSignalIds(scenarios: any[], repoRoot?: string): string[] {
  const key = path.resolve(repoRoot || REPO_ROOT);
  let generator = sharedGeneratorCache.get(key);
  if (!generator) {
    generator = new GenerateTriggerWeights(key);
    generator.loadSignalMapping();
    sharedGeneratorCache.set(key, generator);
  }
  return generator.generateSignalIdsFromScenarios(scenarios);
}

if (require.main === module) {
  runCli(async () => {
    const res = await new GenerateTriggerWeights().run();
    console.log('WROTE', res.outPath);
    console.log('Top triggers:');
    for (const it of res.top) console.log(it.trig, it.count, it.weight);
  });
}

export default GenerateTriggerWeights;
