import fs from 'fs';
import path from 'path';
import { deriveSignalId } from './utils';

type CountMap = { [k: string]: number };
/**
 * GenerateTriggerWeights
 *
 * Это основной класс для генерации `config/trigger-weights.json` на основе
 * триггеров, найденных в `public_cases`. Он собирает уникальные триггеры по
 * каждому кейсу, подсчитывает число кейсов, в которых встречается каждый триггер,
 * вычисляет TF‑IDF внутри экспертных категорий и выдаёт итоговую карту весов.
 *
 * Важные свойства:
 * - Используется канонический маппинг категорий из существующего `config/trigger-weights.json`.
 * - Триггеры строго привязываются к категориям (critical/high/medium/low/camo).
 * - Вес триггера = Category_Min + TFIDF_normalized * (Category_Max - Category_Min).
 * Поведение:
 * - собирает уникальные триггеры по каждому кейсу (из `scenarios[].triggers` и `signal_ids`),
 * - считает число кейсов, в которых встречается каждый триггер,
 * - нормализует строки (trim + toLowerCase),
 * - сопоставляет частоты в веса в диапазоне [minWeight, topWeight] (линейная нормализация),
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
    // Sensitivity multiplier for TF-IDF (increases the influence of raw tfidf before normalization)
    tfidfScale = 1.5;

  constructor(repoRoot?: string) {
    this.repoRoot = repoRoot || path.resolve(__dirname, '..');
  }
  signalMap: Record<string, string> = {};

  loadSignalMapping() {
    try {
      const mapPath = path.join(this.repoRoot, 'config', 'signal-mapping.json');
      if (!fs.existsSync(mapPath)) return;
      const raw = fs.readFileSync(mapPath, 'utf8');
      const parsed = JSON.parse(raw);
      const signals = (parsed && parsed.signals) ? parsed.signals : {};
      for (const sid of Object.keys(signals)) {
        const val = signals[sid];
        const arr = Array.isArray(val) ? val : (val && Array.isArray(val.triggers) ? val.triggers : []);
        for (const t of arr) {
          if (typeof t !== 'string') continue;
          const n = this.normalizeTrigger(t);
          if (n) this.signalMap[n] = sid;
        }
      }
    } catch (err) {
      // ignore
    }
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

  /** Recursively walks through a directory and returns a list of all JSON files.
   * Returns an empty array if the directory does not exist.
   */
  walkDir(dir: string, files: string[] = []): string[] {
    if (!fs.existsSync(dir)) return files;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) this.walkDir(full, files);
      else if (ent.isFile() && ent.name.endsWith('.json')) files.push(full);
    }
    return files;
  }

  /**
   * Extracts case objects from a file.
   * Supports multiple input file formats:
   * - files where the top-level key is `MANIPULATION`/`FRAUD`/`ACCESS` (array of cases),
   * - a single case (object with `case_id`),
   * - files with nested objects/arrays containing objects with `case_id`.
   */
  extractCasesFromFile(file: string): any[] {
    try {
      const raw = fs.readFileSync(file, 'utf8');
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
   * Computes the weight map based on trigger occurrence counts.
   * Formula: weight = max(minWeight, round((count/maxCount) * topWeight, 2)).
   * Returns an object with trigger keys and weight values, sorted by weight.
   */
  computeWeights(counts: CountMap) {
    const entries = Object.keys(counts).map(k => ({ k, c: counts[k] }));
    if (entries.length === 0) return { triggerWeights: {}, entries: [] };
    const max = Math.max(...entries.map(e => e.c));
    const computed = entries.map(e => {
      const w = Math.max(this.minWeight, Math.round((e.c / max) * this.topWeight * 100) / 100);
      return { trig: e.k, count: e.c, weight: w };
    });
    computed.sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.trig.localeCompare(b.trig);
    });
    const triggerWeights: { [k: string]: number } = {};
    for (const it of computed) triggerWeights[it.trig] = it.weight;
    return { triggerWeights, entries: computed };
  }

  /**
   * Writes the final JSON config to `config/trigger-weights.json`, creating a backup
   * of the previous version as `trigger-weights.json.bak`.
   */
  writeConfig(payload: any) {
    const cfgDir = path.join(this.repoRoot, 'config');
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    const outPath = path.join(cfgDir, 'trigger-weights.json');
    if (fs.existsSync(outPath)) fs.copyFileSync(outPath, outPath + '.bak');
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
    return outPath;
  }

  /**
   * Main run: searches for all JSON files in `public_cases` (or in `process.env.CASES_DIR`),
   * collects trigger statistics, computes weights, and writes the config.
   */
  run() {
    const casesDir = process.env.CASES_DIR || path.join(this.repoRoot, 'public_cases');
    const files = this.walkDir(casesDir);
    const counts: CountMap = Object.create(null);
    for (const f of files) {
      const cases = this.extractCasesFromFile(f);
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
        // Do NOT include `signal_ids` here — signal IDs are a separate concept (identifiers),
        // not human-readable trigger text. Including them pollutes `trigger-weights.json` with
        // SID-like keys (e.g. "SIG-...") which breaks downstream expectations.
        // If you need to account for mapped signals, expand them into trigger text via
        // `signal-mapping.json` elsewhere (recalc pipeline). For weight generation we only
        // count `scenarios[].triggers`.
        for (const trig of uniq) counts[trig] = (counts[trig] || 0) + 1;
      }
    }

    // Preserve existing triggers from current config so we don't drop keys that are expected by other parts of the code/tests.
    const cfgPath = path.join(this.repoRoot, 'config', 'trigger-weights.json');
    let existingConfig: any = null;
    const preservedSections: Record<string, any> = {};
    if (fs.existsSync(cfgPath)) {
      try {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        const parsed = JSON.parse(raw);
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
        existingConfig = null;
      }
    }

    let totalCases = 0;
    // recompute totalCases from files (count of case objects)
    for (const f of files) {
      const cases = this.extractCasesFromFile(f);
      totalCases += cases.length;
    }

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

    // apply canonical map first
    for (const k of Object.keys(canonicalCategoryMap)) triggerCategory[k] = canonicalCategoryMap[k];

    // default any remaining missing triggers into camo (also map camo/alibi heuristics)
    for (const t of Object.keys(counts)) {
      if (triggerCategory[t]) continue;
      const lt = String(t).toLowerCase();
      if (lt.includes('camouflage') || lt.includes('alibi') || lt.includes('naive') || lt.includes('persona')) {
        triggerCategory[t] = 'camo';
      } else {
        triggerCategory[t] = 'camo';
      }
    }

    // compute TF-IDF raw per trigger
    const N = totalCases;
    const rawPerTrig: Record<string, number> = {};
    for (const t of Object.keys(counts)) {
      const df = counts[t] || 0;
      rawPerTrig[t] = this.tfidfScale * df * Math.log(1 + (N / Math.max(df, 1 + this.idfSmoothing)));
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

    const boostMaxForCat = (cat: string) => {
      const r = CATEGORY_RANGES[cat] || CATEGORY_RANGES.camo;
      return Math.min(0.05, Math.max(0, r.upper - r.lower));
    };

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
        if (mm.max > mm.min) norm = (raw - mm.min) / (mm.max - mm.min);
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

    const out = {
      triggerWeights,
      defaultTriggerWeight: this.minWeight,
      crossCheckWeight: this.crossCheckWeight,
      signalIdWeight: this.signalIdWeight,
      maxBoost: this.maxBoost,
      normAlpha: (existingConfig && typeof existingConfig.normAlpha === 'number') ? existingConfig.normAlpha : 0.3,
      weightMethod: 'tfidf-tiered'
    };
    const outPath = this.writeConfig(out);

    // CLI: optionally apply generated signal_ids back into case files
    const applySignalIds = process.argv.includes('--apply-signal-ids');
    if (applySignalIds) {
      const files2 = this.walkDir(casesDir);
      let changed = 0;
      const self = this;
      for (const f of files2) {
        try {
          const raw = fs.readFileSync(f, 'utf8');
          const parsed = JSON.parse(raw);
          const before = JSON.stringify(parsed);

          function applyToObject(obj: any) {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
              for (const it of obj) applyToObject(it);
              return;
            }
            // single case
            if (obj.case_id) {
              if (!Array.isArray(obj.signal_ids) || obj.signal_ids.length === 0) {
                const sids = self.generateSignalIdsFromScenarios(obj.scenarios || []);
                if (sids.length) obj.signal_ids = sids;
              }
              return;
            }
            for (const k of Object.keys(obj)) {
              const v = obj[k];
              if (Array.isArray(v)) {
                for (const item of v) applyToObject(item);
              } else if (v && typeof v === 'object') applyToObject(v);
            }
          }

          applyToObject(parsed);
          const after = JSON.stringify(parsed);
          if (after !== before) {
            fs.copyFileSync(f, f + '.bak');
            fs.writeFileSync(f, JSON.stringify(parsed, null, 2), 'utf8');
            changed++;
          }
        } catch (err) {
          // ignore
        }
      }
      console.log('Applied signal_ids to', changed, 'files');
    }
    return { outPath, top: entries ? entries.slice(0, 30) : [] };
  }
}

/**
 * Exported helper for external use: generate signal ids from scenarios.
 */
export function generateSignalIds(scenarios: any[]): string[] {
  return new GenerateTriggerWeights().generateSignalIdsFromScenarios(scenarios);
}

if (require.main === module) {
  const g = new GenerateTriggerWeights();
  const res = g.run();
  console.log('WROTE', res.outPath);
  console.log('Top triggers:');
  for (const it of res.top) console.log(it.trig, it.count, it.weight);
}

export default GenerateTriggerWeights;
