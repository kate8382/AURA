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
        const arr = signals[sid] || [];
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
        else {
          // fallback: deterministically derive a SID from the normalized trigger
          const fid = deriveSignalId(n);
          if (fid) set.add(fid);
        }
      }
    }
    return Array.from(set);
  }

  /**
   * Вычисляет карту весов на основе подсчёта встречаемости триггеров.
   * Формула: weight = max(minWeight, round((count/maxCount) * topWeight, 2)).
   * Возвращает объект с ключами-триггерами и значениями-весами, отсортированный по весу.
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
        if (Array.isArray((c as any).signal_ids)) for (const t of (c as any).signal_ids) {
          const n = this.normalizeTrigger(t);
          if (n) uniq.add(n);
        }
        for (const trig of uniq) counts[trig] = (counts[trig] || 0) + 1;
      }
    }

    // Preserve existing triggers from current config so we don't drop keys that are expected by other parts of the code/tests.
    const cfgPath = path.join(this.repoRoot, 'config', 'trigger-weights.json');
    if (fs.existsSync(cfgPath)) {
      try {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.triggerWeights && typeof parsed.triggerWeights === 'object') {
          for (const k of Object.keys(parsed.triggerWeights)) {
            if (!(k in counts)) counts[k] = 0;
          }
        }
      } catch (err) {
        // ignore parse errors and continue
      }
    }

    const { triggerWeights, entries } = this.computeWeights(counts);
    const out = {
      triggerWeights,
      defaultTriggerWeight: this.minWeight,
      crossCheckWeight: this.crossCheckWeight,
      signalIdWeight: this.signalIdWeight,
      maxBoost: this.maxBoost
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
