import { promises as fs } from 'fs';
import path from 'path';
import PolicyEvaluator from './policy/evaluateDecision';
import { reorderCaseKeys } from './utils';
import { generateSignalIds } from './generate-trigger-weights';

type Entry = { [k: string]: any };

/**
 * RecalcConfidence
 * Класс для пересчёта поля `confidence` в JSON кейсах.
 * Методы:
 * - mapConfidence(): эвристика соответствия категории + сигналов
 * - recalc(): пересчитать один файл и записать изменения
 * - run(): обработать директорию/файл
 * При записи гарантируем порядок ключей: `confidence_raw` перед `scenarios`, `confidence` после `cross_check`.
 */
export class RecalcConfidence {
  static PROMPT_BASE = 0.0;
  static MAP_DEFAULT_BASE = 0.75;
  static DEFAULT_CONFIDENCE = 0.95;
  static mapConfidence(category: string, signalCount: number): number {
    // Backwards-compatible wrapper: compute base + small signal-based boost
    const base = RecalcConfidence.getBaseForCategory(category);
    let boost = 0;
    if (signalCount > 1) boost = Math.min(0.05, 0.02 * (signalCount - 1));
    const value = Math.min(1.0, base + boost);
    return Math.round(value * 100) / 100;
  }

  static getBaseForCategory(category: string): number {
    // Preserve method for backward-compatibility but base risk is always 0.0
    // per 'presumption of innocence' design: categories do NOT give base score.
    return RecalcConfidence.PROMPT_BASE;
  }

  static getCategoryMultiplier(category: string): number {
    const cat = (category || '').toLowerCase();
    // Categories influence how strongly triggers count (weight multiplier),
    // but do not provide an initial base score.
    if (!cat || !cat.trim()) return 1.0;
    if (cat.includes('access') || cat.includes('unauthorized') || cat.includes('infrastructure')) return 1.5;
    if (cat.includes('espionage') || cat.includes('insider')) return 1.5;
    if (cat.includes('extort') || cat.includes('harass')) return 1.3;
    if (cat.includes('fraud') || cat.includes('financial')) return 1.3;
    if (cat.includes('manipulation') || cat.includes('platform')) return 1.2;
    return 1.0;
  }

  // Note: canonical ordering handled by shared utility `reorderCaseKeys`
  async recalc(filePath: string, preserveExisting = false, minFloor = 0.0): Promise<{ count: number; changes: Array<[string, any, any]> }> {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    const changes: Array<[string, any, any]> = [];
    let count = 0;

    // Load config via helper (file + ENV)
    const { loadTriggerConfig } = await import('./config');
    const cfg = loadTriggerConfig();

    // Load signal mapping (signal_id -> [triggers] or { id, description, triggers }) if present
    let signalMapping: Record<string, any> = {};
    try {
      const mapPath = path.resolve(__dirname, '..', 'config', 'signal-mapping.json');
      const rawMap = await fs.readFile(mapPath, 'utf8').catch(() => null);
      if (rawMap) {
        const parsed = JSON.parse(rawMap);
        signalMapping = (parsed && parsed.signals) ? parsed.signals : {};
      }
    } catch (err) {
      signalMapping = {};
    }

    const normalize = (t: unknown) => {
      if (!t || typeof t !== 'string') return null;
      let s = t.trim().toLowerCase();
      s = s.replace(/\s+request$/i, '');
      s = s.replace(/\s+/g, ' ');
      return s;
    };

    const evaluator = new PolicyEvaluator();

    const updateCase = (e: Entry) => {
      const old = e.confidence;
      if (preserveExisting && (typeof old === 'number')) return null;
      const signals: string[] = Array.isArray(e.signal_ids) ? (e.signal_ids as string[]).slice() : generateSignalIds(e.scenarios || []);
      // Build set of unique triggers from scenarios (defensive typing)
      const uniqueTriggers = new Set<string>();
      const scenariosArr: any[] = Array.isArray(e.scenarios) ? e.scenarios : [];
      for (const s of scenariosArr) {
        if (!s || typeof s !== 'object') continue;
        const triggersArr: any[] = Array.isArray((s as any).triggers) ? (s as any).triggers : [];
        for (const t of triggersArr) if (typeof t === 'string') uniqueTriggers.add(t.trim().toLowerCase());
      }
      // Resolve signal_ids: if they map to known triggers (via signalMapping),
      // expand them into `uniqueTriggers` so trigger-weights apply. For signals
      // without mapping, count them for fallback SIGNAL_ID_WEIGHT.
      let unmappedSignalCount = 0;
      if (Array.isArray(signals)) {
        for (const sidRaw of signals) {
          if (typeof sidRaw !== 'string') continue;
          const sid = sidRaw;
          const entry: any = signalMapping[sid];
          const mapped: string[] = Array.isArray(entry) ? entry : (entry && Array.isArray(entry.triggers) ? entry.triggers : []);
          if (mapped.length) {
            for (const mt of mapped) {
              const n = normalize(mt);
              if (n) uniqueTriggers.add(n);
            }
          } else {
            unmappedSignalCount++;
          }
        }
      }

      const crossCheckQuestions = (e.cross_check && Array.isArray(e.cross_check.questions)) ? e.cross_check.questions.length : 0;

      const rawVal = (typeof e.confidence_raw === 'number') ? e.confidence_raw : (typeof old === 'number') ? old : RecalcConfidence.PROMPT_BASE;

      // Category no longer gives base; it only modifies trigger multipliers
      const base = RecalcConfidence.getBaseForCategory(e.category || '');

      // Weighted mapping for triggers (loaded from config/trigger-weights.json or ENV)
      const TRIGGER_WEIGHTS = cfg.triggerWeights || {};

      const DEFAULT_TRIGGER_WEIGHT = (typeof cfg.defaultTriggerWeight === 'number') ? cfg.defaultTriggerWeight : 0.01;
      const CROSS_CHECK_WEIGHT = (typeof cfg.crossCheckWeight === 'number') ? cfg.crossCheckWeight : 0.005; // per question
      const SIGNAL_ID_WEIGHT = (typeof cfg.signalIdWeight === 'number') ? cfg.signalIdWeight : 0.01; // per signal_id if present

      // Normalize trigger weight keys to lowercase for robust matching and coerce values to numbers
      const normalizedWeights: Record<string, number> = {};
      for (const k of Object.keys(TRIGGER_WEIGHTS)) {
        const rawVal = TRIGGER_WEIGHTS[k];
        const num = Number(rawVal);
        if (!Number.isNaN(num)) normalizedWeights[String(k).trim().toLowerCase()] = num;
      }

      let totalWeight = 0;
      for (const trig of Array.from(uniqueTriggers)) {
        const w = normalizedWeights[trig];
        if (typeof w === 'number') totalWeight += w;
        else totalWeight += DEFAULT_TRIGGER_WEIGHT;
      }
      // add contributions from cross_check and unmapped signal_ids (fallback)
      totalWeight += crossCheckQuestions * CROSS_CHECK_WEIGHT;
      if (unmappedSignalCount > 0) totalWeight += unmappedSignalCount * SIGNAL_ID_WEIGHT;
      // Apply category multiplier only to trigger-derived weight
      const catMultiplier = RecalcConfidence.getCategoryMultiplier(e.category || '');
      totalWeight = totalWeight * catMultiplier;

      // Determine final raw confidence as the honest sum of real signals (no category base)
      // Remove artificial global cap so raw reflects true summed evidence
      const computedRaw = totalWeight;

      // Round raw confidence to 2 decimals (honest aggregation)
      const computedRawRounded = Math.round(computedRaw * 100) / 100;

      // Normalize raw to [0,1] using diminishing-returns function:
      // normalized = 1 - exp(-alpha * raw)  (alpha default 1.0)
      const alpha = (typeof cfg.normAlpha === 'number') ? cfg.normAlpha : 1.0;
      const normalized = 1 - Math.exp(-alpha * computedRaw);
      let newVal = Math.round(normalized * 100) / 100;
      if (newVal < minFloor) newVal = minFloor;
      const oldDecision = (e as any).decision;
      // Store computed raw evidence as the auditable `confidence_raw` (honest sum)
      e.confidence_raw = computedRawRounded;
      e.confidence = newVal;
      // evaluate decision based on policy and cross-check history
      let newDecision = oldDecision;
      let decisionReasons: string[] = [];
      try {
        const decisionRes = evaluator.evaluate(e);
        if (decisionRes && decisionRes.decision) {
          newDecision = decisionRes.decision;
          decisionReasons = decisionRes.reasons || [];
        }
      } catch (err) {
        // swallow policy evaluation errors to avoid blocking recalc
      }
      (e as any).decision = newDecision;
      (e as any).decision_reasons = decisionReasons;

      if (old !== newVal || oldDecision !== newDecision) {
        changes.push([e.case_id || '<no-id>', { confidence_old: old, decision_old: oldDecision }, { confidence_new: newVal, decision_new: newDecision }]);
        count += 1;
        return true;
      }
      return null;
    };

    // legacy handling
    if ((data as any).legal_intent_logs && typeof (data as any).legal_intent_logs === 'object') {
      const logs = (data as any).legal_intent_logs || {};
      for (const table of Object.keys(logs)) {
        const entries: Entry[] = logs[table] || [];
        for (const e of entries) updateCase(e);
      }
      (data as any).legal_intent_logs = logs;
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
      return { count, changes };
    }

    const topKeys = Object.keys(data);
    const categoryKeys = topKeys.filter(k => ['MANIPULATION', 'FRAUD', 'ACCESS'].includes(k));
    if (categoryKeys.length > 0) {
      for (const ck of categoryKeys) {
        const arr: Entry[] = (data as any)[ck] || [];
        for (const e of arr) updateCase(e);
        // reorder entries in-place to canonical ordering
        (data as any)[ck] = arr.map((it: Entry) => reorderCaseKeys(it));
      }
    } else if (data.case_id) {
      updateCase(data as Entry);
      const ordered = reorderCaseKeys(data as Entry);
      Object.assign(data, ordered);
    } else {
      for (const k of Object.keys(data)) {
        const v = (data as any)[k];
        if (Array.isArray(v)) {
          for (const item of v) {
            if (item && typeof item === 'object' && item.case_id) updateCase(item);
          }
        } else if (v && typeof v === 'object' && v.case_id) {
          updateCase(v);
        }
      }
    }

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { count, changes };
  }

  // parse command-line args and run recalc on a file or directory
  parseArgs(argv: string[]) {
    const defaultDir = process.env.CASES_DIR || 'public_cases';
    const result: { file: string; dryRun: boolean; preserve: boolean } = { file: defaultDir, dryRun: false, preserve: false };
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--file' || a === '-f' || a === '--dir' || a === '-d') { result.file = argv[++i]; continue; }
      if (a === '--dry-run') { result.dryRun = true; continue; }
      if (a === '--preserve-existing') { result.preserve = true; continue; }
    }
    return result;
  }

  // run the recalc process on a file or directory, with optional dry-run and preserve flags
  async run() {
    const args = this.parseArgs(process.argv.slice(2));
    let filePath = args.file;
    // minFloor default may be configured via ENV `MIN_FLOOR`, otherwise default 0.5
    const envMin = process.env.MIN_FLOOR ? Number(process.env.MIN_FLOOR) : undefined;
    const minFloor = typeof (process.argv.find((a) => a === '--min')) !== 'undefined'
      ? Number(((): string | undefined => {
          const idx = process.argv.indexOf('--min');
          return idx >= 0 ? process.argv[idx + 1] : undefined;
        })())
      : (typeof envMin === 'number' && !Number.isNaN(envMin) ? envMin : 0.0);
    if (!path.isAbsolute(filePath)) {
      const repoRoot = path.resolve(__dirname, '..');
      filePath = path.resolve(repoRoot, filePath);
    }

    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats) throw new Error(`Path not found: ${filePath}`);

    let totalCount = 0;
    const totalChanges: Array<[string, any, any]> = [];

    const processSingleFile = async (p: string) => {
      const content = await fs.readFile(p, 'utf8');
      if (args.dryRun) {
        const tmpPath = p + '.tmp.recalc.json';
        await fs.writeFile(tmpPath, content, 'utf8');
        const res = await this.recalc(tmpPath, args.preserve, minFloor);
        await fs.unlink(tmpPath).catch(() => {});
        return res;
      } else {
        return await this.recalc(p, args.preserve, minFloor);
      }
    };

    if (stats.isDirectory()) {
      async function walk(dir: string, self: RecalcConfidence) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) await walk(full, self);
          else if (ent.isFile() && ent.name.endsWith('.json')) {
            const { count, changes } = await processSingleFile(full);
            totalCount += count;
            totalChanges.push(...changes);
            if (changes.length) console.log(`Updated ${full}: ${changes.length} changes`);
          }
        }
      }
      await walk(filePath, this);
    } else if (stats.isFile()) {
      const { count, changes } = await processSingleFile(filePath);
      totalCount += count;
      totalChanges.push(...changes);
    }

    console.log(`Total updated entries: ${totalCount}`);
    if (totalChanges.length) {
      console.log("Examples (case_id, old, new):");
      for (const it of totalChanges.slice(0, 20)) console.log(it);
    }
    if (args.dryRun) console.log("Dry-run: files not modified.");
  }
}

// Backwards-compatible exports for tests and scripts that expected functions
export const mapConfidence = RecalcConfidence.mapConfidence;
export const PROMPT_BASE = RecalcConfidence.PROMPT_BASE;
export const DEFAULT_CONFIDENCE = RecalcConfidence.DEFAULT_CONFIDENCE;

if (require.main === module) {
  const runner = new RecalcConfidence();
  runner.run().catch(err => { console.error('Error:', err.message || err); process.exit(1); });
}
