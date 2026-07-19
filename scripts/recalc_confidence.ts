import { promises as fs } from 'fs';
import path from 'path';
import { reorderCaseKeys } from './utils';

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
  static PROMPT_BASE = 0.5;
  static MAP_DEFAULT_BASE = 0.75;

  static mapConfidence(category: string, signalCount: number): number {
    const cat = (category || '').toLowerCase();
    let base = RecalcConfidence.MAP_DEFAULT_BASE;
    if (cat.includes('extort') || cat.includes('harass')) base = 0.9;
    else if (cat.includes('fraud') || cat.includes('financial')) base = 0.9;
    else if (cat.includes('access') || cat.includes('unauthorized') || cat.includes('infrastructure')) base = 0.95;
    else if (cat.includes('manipulation') || cat.includes('platform')) base = 0.8;
    else if (cat.includes('espionage') || cat.includes('insider')) base = 0.95;

    let boost = 0;
    if (signalCount > 1) boost = Math.min(0.05, 0.02 * (signalCount - 1));
    const value = Math.min(1.0, base + boost);
    return Math.round(value * 100) / 100;
  }

  // Note: canonical ordering handled by shared utility `reorderCaseKeys`
  async recalc(filePath: string, preserveExisting = false, minFloor = 0.6): Promise<{ count: number; changes: Array<[string, any, any]> }> {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    const changes: Array<[string, any, any]> = [];
    let count = 0;

    const updateCase = (e: Entry) => {
      const old = e.confidence;
      if (preserveExisting && (typeof old === 'number')) return null;
      const signals: string[] = e.signal_ids || [];
      const rawVal = (typeof e.confidence_raw === 'number') ? e.confidence_raw : (typeof old === 'number') ? old : RecalcConfidence.PROMPT_BASE;
      let newVal = RecalcConfidence.mapConfidence(e.category || '', signals.length);
      newVal = Math.round(Math.max(minFloor, newVal) * 100) / 100;
      if (old !== newVal) {
        if (typeof e.confidence_raw === 'undefined') e.confidence_raw = rawVal;
        e.confidence = newVal;
        changes.push([e.case_id || '<no-id>', old, newVal]);
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
    const minFloor = typeof (process.argv.find((a) => a === '--min')) !== 'undefined'
      ? Number(((): string | undefined => {
          const idx = process.argv.indexOf('--min');
          return idx >= 0 ? process.argv[idx + 1] : undefined;
        })())
      : 0.6;
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

if (require.main === module) {
  const runner = new RecalcConfidence();
  runner.run().catch(err => { console.error('Error:', err.message || err); process.exit(1); });
}
