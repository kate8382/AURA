import fs from 'fs';
import path from 'path';
import { deriveSignalId } from './utils';

type CountMap = { [k: string]: number };

/**
 * GenerateTriggerWeights
 * Класс, инкапсулирующий логику сканирования кейсов и генерации файла
 * `config/trigger-weights.json` на основе триггеров, встречающихся в `public_cases`.
 *
 * Поведение:
 * - собирает уникальные триггеры по каждому кейсу (из `scenarios[].triggers` и `signal_ids`),
 * - считает число кейсов, в которых встречается каждый триггер,
 * - нормализует строки (trim + toLowerCase),
 * - сопоставляет частоты в веса в диапазоне [minWeight, topWeight] (линейная нормализация),
 * - записывает результат в `config/trigger-weights.json` и создаёт резервную копию предыдущего.
 */
export class GenerateTriggerWeights {
  repoRoot: string;
  /** Метод расчёта весов: 'linear' или 'tfidf' */
  weightMethod: 'linear' | 'tfidf' = 'linear';
  /** Сглаживание для IDF (по умолчанию 1) */
  idfSmoothing = 1;
  /** Верхняя граница веса для самого часто встречающегося триггера */
  topWeight = 0.05;
  /** Минимальный вес по умолчанию для редко встречающихся триггеров */
  minWeight = 0.01;
  /** Вес за вопрос в cross_check */
  crossCheckWeight = 0.005;
  /** Вес за наличе signal_id */
  signalIdWeight = 0.01;
  /** Максимальный суммарный буст */
  maxBoost = 0.1;

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

  /**
   * Рекурсивно обходит директорию и возвращает список всех JSON-файлов.
   * Возвращает пустой массив, если директория не существует.
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
   * Извлекает объекты кейсов из файла.
   * Поддерживает несколько форматов входных файлов:
   * - файлы, где верхний ключ — `MANIPULATION`/`FRAUD`/`ACCESS` (массив кейсов),
   * - одиночный кейс (объект с `case_id`),
   * - файлы с вложенными объектами/массивами, содержащими объекты с `case_id`.
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
   * Приводит триггер к каноническому виду: trim + toLowerCase.
   * Возвращает `null` для невалидных значений.
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
   * Вычисляет карту весов на основе подсчёта встречаемости триггеров.
   * Формула: weight = max(minWeight, round((count/maxCount) * topWeight, 2)).
   * Возвращает объект с ключами-триггерами и значениями-весами, отсортированный по весу.
   */
  computeWeights(counts: CountMap, totalDocs?: number) {
    // filter out visual section headers or invalid keys (e.g. lines starting with '===')
    const entries = Object.keys(counts)
      .filter(k => {
        if (!k || typeof k !== 'string') return false;
        const s = k.trim();
        if (s.startsWith('===')) return false;
        // require at least one letter/number in the key
        if (!/[a-z0-9]/i.test(s)) return false;
        return true;
      })
      .map(k => ({ k, c: counts[k] }));
    if (entries.length === 0) return { triggerWeights: {}, entries: [] };
    // support different weighting methods
    const N = typeof totalDocs === 'number' && totalDocs > 0 ? totalDocs : 0;
    // compute a raw score per entry depending on method
    const raws: { trig: string; count: number; raw: number }[] = entries.map(e => {
      if (this.weightMethod === 'tfidf' && N > 0) {
        // df = document frequency = e.c
        const df = e.c;
        // raw = df * log(1 + N/df) with optional smoothing
        const raw = df * Math.log(1 + (N / Math.max(df, 1 + this.idfSmoothing)));
        return { trig: e.k, count: e.c, raw };
      }
      // default linear: use count as raw score (will be normalized by max)
      return { trig: e.k, count: e.c, raw: e.c };
    });
    const maxRaw = Math.max(...raws.map(r => r.raw));
    // Scaling strategy for TF-IDF: preserve relative ordering but scale absolute magnitude
    // so that the top trigger maps to desiredTopWeight (e.g. 0.6). For linear method we
    // keep original topWeight behavior to preserve backward compatibility.
    const desiredTop = (this.weightMethod === 'tfidf') ? 0.6 : this.topWeight;
    const computed = raws.map(r => {
      const baseNorm = maxRaw > 0 ? r.raw / maxRaw : 0;
      // Optional non-linear compression could be applied here; for now keep linear mapping
      const scaled = baseNorm * desiredTop;
      const w = Math.max(this.minWeight, Math.round(scaled * 100) / 100);
      return { trig: r.trig, count: r.count, weight: w };
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
   * Записывает финальный JSON-конфиг в `config/trigger-weights.json`, создавая резервную копию
   * предыдущей версии как `trigger-weights.json.bak`.
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
   * Основной запуск: ищет все JSON-файлы в `public_cases` (или в `process.env.CASES_DIR`),
   * собирает статистику триггеров, вычисляет веса и записывает конфиг.
   */
  run() {
    const casesDir = process.env.CASES_DIR || path.join(this.repoRoot, 'public_cases');
    const files = this.walkDir(casesDir);
    const counts: CountMap = Object.create(null);
    let totalCases = 0;
    // determine weighting method from ENV or CLI
    const envMethod = (process.env.TRIGGER_WEIGHT_METHOD || '').toLowerCase();
    const methodArg = process.argv.find(a => a.startsWith('--method='));
    const method = methodArg ? methodArg.split('=')[1] : (envMethod || 'linear');
    if (method === 'tfidf') this.weightMethod = 'tfidf';
    for (const f of files) {
      const cases = this.extractCasesFromFile(f);
      for (const c of cases) {
        totalCases++;
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
    // Load existing config to preserve any human-maintained keys (including visual
    // section headers of the form "=== ... ===") and to reuse global parameters
    // if present. We will NOT treat section headers as triggers when computing weights.
    let existingConfig: any = null;
    const preservedSections: Record<string, any> = {};
    const cfgPath = path.join(this.repoRoot, 'config', 'trigger-weights.json');
    if (fs.existsSync(cfgPath)) {
      try {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        existingConfig = JSON.parse(raw);
        if (existingConfig && existingConfig.triggerWeights && typeof existingConfig.triggerWeights === 'object') {
          for (const k of Object.keys(existingConfig.triggerWeights)) {
            const s = String(k || '').trim();
            // preserve visual/section header entries verbatim for output, but DO NOT
            // include them in counts used for weight computation
            if (s.startsWith('===')) {
              preservedSections[k] = existingConfig.triggerWeights[k];
              continue;
            }
            // keep human-maintained trigger keys present in existing config so they are
            // not dropped; but add them to counts only as zero if they don't appear in corpus
            if (/^sig[-_]/i.test(k)) continue; // skip SID-like keys
            if (!(k in counts)) counts[k] = 0;
          }
        }
      } catch (err) {
        // ignore parse errors and continue
        existingConfig = null;
      }
    }

    // Compute both linear and tfidf maps for calibration and selection
    const originalMethod = this.weightMethod;
    this.weightMethod = 'linear';
    const linearResult = this.computeWeights(counts, totalCases);
    const linearMap = linearResult.triggerWeights;
    this.weightMethod = 'tfidf';
    const tfidfResult = this.computeWeights(counts, totalCases);
    const tfidfMap = tfidfResult.triggerWeights;
    // restore original
    this.weightMethod = originalMethod;

    // Choose which weights to output
    const baseMap = (originalMethod === 'tfidf') ? tfidfMap : linearMap;

     // Choose which weights to output. If TF-IDF is selected, apply percentile-based
    // tiering to map raw tfidf scores into curator-friendly ranges (critical, high, camo).
    /**
     const baseMap = (originalMethod === 'tfidf') ? (() => {
      const raw = Object.assign({}, tfidfMap);
      // build scored list excluding preserved section headers and non-positive values
      const scored = Object.keys(raw)
        .filter(k => !preservedSections[k])
        .map(k => ({ k, v: Number(raw[k] || 0) }))
        .filter(x => Number.isFinite(x.v) && x.v > 0);

      if (scored.length === 0) return raw;

      const values = scored.map(s => s.v).sort((a, b) => a - b);
      const n = values.length;
      // tiers (configurable if needed)
      const pctCritical = 0.10; // top 10%
      const pctHigh = 0.30; // next 30%
      // thresholds (value at which groups split)
      const idxCrit = Math.max(0, Math.floor((1 - pctCritical) * n));
      const idxHigh = Math.max(0, Math.floor((1 - pctCritical - pctHigh) * n));
      const threshCrit = values[Math.min(n - 1, idxCrit)];
      const threshHigh = values[Math.min(n - 1, idxHigh)];

      // output ranges per tier
      const CRIT_MIN = 0.40, CRIT_MAX = 0.60;
      const HIGH_MIN = 0.25, HIGH_MAX = 0.40;
      const CAMO_MIN = 0.01, CAMO_MAX = 0.05;

      const groupMap: Record<string, number> = {};

      const groupValues: { crit: number[]; high: number[]; camo: number[] } = { crit: [], high: [], camo: [] };
      for (const s of scored) {
        if (s.v >= threshCrit) groupValues.crit.push(s.v);
        else if (s.v >= threshHigh) groupValues.high.push(s.v);
        else groupValues.camo.push(s.v);
      }

      const minMax = (arr: number[]) => ({ min: arr.length ? Math.min(...arr) : 0, max: arr.length ? Math.max(...arr) : 0 });
      const critMM = minMax(groupValues.crit);
      const highMM = minMax(groupValues.high);
      const camoMM = minMax(groupValues.camo);

      const scale = (v: number, inMin: number, inMax: number, outMin: number, outMax: number) => {
        if (inMax <= inMin) return Number(((outMin + outMax) / 2).toFixed(2));
        const t = (v - inMin) / (inMax - inMin);
        return Number((outMin + t * (outMax - outMin)).toFixed(2));
      };

      for (const s of scored) {
        let scaled = 0;
        if (s.v >= threshCrit) {
          scaled = scale(s.v, critMM.min || threshCrit, critMM.max || s.v, CRIT_MIN, CRIT_MAX);
        } else if (s.v >= threshHigh) {
          scaled = scale(s.v, highMM.min || threshHigh, highMM.max || s.v, HIGH_MIN, HIGH_MAX);
        } else {
          scaled = scale(s.v, camoMM.min || 0, camoMM.max || s.v, CAMO_MIN, CAMO_MAX);
        }
        groupMap[s.k] = scaled;
      }

      // apply scaled values back into raw map (leave preserved sections untouched)
      for (const k of Object.keys(groupMap)) raw[k] = groupMap[k];
      return raw;
    })() : linearMap;
    **/

    // Calibrate normAlpha: prefer a stable heuristic and clamp to avoid tiny values
    let chosenAlpha = (existingConfig && typeof existingConfig.normAlpha === 'number') ? existingConfig.normAlpha : (originalMethod === 'tfidf' ? 0.35 : 0.3);
    try {
      const files2 = this.walkDir(casesDir);
      const linearRaws: number[] = [];
      const tfidfRaws: number[] = [];
      for (const f of files2) {
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
          let lsum = 0;
          let tsum = 0;
          for (const trig of uniq) {
            lsum += linearMap[trig] || 0;
            tsum += tfidfMap[trig] || 0;
          }
          linearRaws.push(lsum);
          tfidfRaws.push(tsum);
        }
      }
      if (linearRaws.length > 0 && tfidfRaws.length === linearRaws.length) {
        const alphaLinear = 0.3;
        const meanLinear = linearRaws.reduce((s, v) => s + v, 0) / linearRaws.length;
        const meanTfidf = tfidfRaws.reduce((s, v) => s + v, 0) / tfidfRaws.length;
        if (meanTfidf > 0) {
          let a = alphaLinear * (meanLinear / meanTfidf);
          if (!Number.isFinite(a) || Number.isNaN(a)) a = chosenAlpha;
          if (a < 0.1) a = 0.1;
          if (a > 1.0) a = 1.0;
          if (originalMethod === 'tfidf') chosenAlpha = Number(a.toFixed(2));
        }
      }
    } catch (err) {
      // ignore calibration errors and fall back to defaults
    }

    // Merge preserved section headers back into the output map so comments remain in the file
    const triggerWeights: Record<string, any> = Object.assign({}, baseMap);
    for (const hk of Object.keys(preservedSections)) triggerWeights[hk] = preservedSections[hk];

    const entries = Object.keys(triggerWeights).map(k => ({ trig: k, count: counts[k] || 0, weight: triggerWeights[k] }));

    // Respect existing global params if present in previous config; otherwise fall back to class defaults
    const out = {
      triggerWeights,
      defaultTriggerWeight: (existingConfig && typeof existingConfig.defaultTriggerWeight === 'number') ? existingConfig.defaultTriggerWeight : this.minWeight,
      crossCheckWeight: (existingConfig && typeof existingConfig.crossCheckWeight === 'number') ? existingConfig.crossCheckWeight : this.crossCheckWeight,
      signalIdWeight: (existingConfig && typeof existingConfig.signalIdWeight === 'number') ? existingConfig.signalIdWeight : this.signalIdWeight,
      maxBoost: (existingConfig && typeof existingConfig.maxBoost === 'number') ? existingConfig.maxBoost : this.maxBoost,
      normAlpha: chosenAlpha,
      weightMethod: this.weightMethod
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
