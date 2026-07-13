#!/usr/bin/env node
/**
 * recalc_confidence.ts
 *
 * Пересчитывает поле `confidence` в kate-notes/kates-training_data.json по детерминистической
 * эвристике (категория + бонус за количество сигналов).
 *
 * Usage:
 *  npx ts-node scripts/recalc_confidence.ts             # применяет к default файлу
 *  npx ts-node scripts/recalc_confidence.ts --dry-run  # не сохраняет, только отчёт
 *  npx ts-node scripts/recalc_confidence.ts -f path/to.json --preserve-existing
 */

import { promises as fs } from 'fs';
import path from 'path';

type Entry = { [k: string]: any };

// Baselines:
// PROMPT_BASE: an "ordinary prompt" base score (pre-risk, used for confidence_raw when absent)
// MAP_DEFAULT_BASE: default base used by the risk-mapping heuristic
export const PROMPT_BASE = 0.5;
export const MAP_DEFAULT_BASE = 0.75;

// Maps category and signal count to a confidence score using heuristics.
export function mapConfidence(category: string, signalCount: number): number {
  const cat = (category || '').toLowerCase();
  let base = MAP_DEFAULT_BASE; // default base confidence for uncategorized cases (risk-mapped)
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

// Recalculates confidence for all entries in the given file, applying the mapping heuristic.
export async function recalc(filePath: string, preserveExisting = false, minFloor = 0.6): Promise<{ count: number; changes: Array<[string, any, any]> }> {
  const raw = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(raw);
  const changes: Array<[string, any, any]> = [];
  let count = 0;

  // Helper to update a single case object in-place (structure preserved by caller)
  function updateCase(e: Entry) {
    const old = e.confidence;
    if (preserveExisting && (typeof old === 'number')) return null;
    const signals: string[] = e.signal_ids || [];
    const rawVal = (typeof e.confidence_raw === 'number')
      ? e.confidence_raw
      : (typeof old === 'number') ? old : PROMPT_BASE;
    let newVal = mapConfidence(e.category || '', signals.length);
    newVal = Math.round(Math.max(minFloor, newVal) * 100) / 100;
    if (old !== newVal) {
      if (typeof e.confidence_raw === 'undefined') e.confidence_raw = rawVal;
      e.confidence = newVal;
      changes.push([e.case_id || '<no-id>', old, newVal]);
      count += 1;
      return true;
    }
    return null;
  }

  // Determine where case objects live inside the file and update them
  // Common patterns observed:
  // 1) wrapper with category arrays: { "MANIPULATION": [ { case... } ] }
  // 2) single case object at top-level: { "case_id": "...", ... }
  const topKeys = Object.keys(data);
  const categoryKeys = topKeys.filter(k => ['MANIPULATION', 'FRAUD', 'ACCESS'].includes(k));
  if (categoryKeys.length > 0) {
    for (const ck of categoryKeys) {
      const arr: Entry[] = (data as any)[ck] || [];
      for (const e of arr) updateCase(e);
    }
  } else if (data.case_id) {
    updateCase(data as Entry);
  } else {
    // fallback: scan for arrays containing objects with case_id
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

// Parses command-line arguments for file path, dry-run mode, and preserve-existing flag.
export function parseArgs(argv: string[]) {
  const result: { file: string; dryRun: boolean; preserve: boolean } = { file: 'premium_matrices', dryRun: false, preserve: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') { result.file = argv[++i]; continue; }
    if (a === '--dry-run') { result.dryRun = true; continue; }
    if (a === '--preserve-existing') { result.preserve = true; continue; }
  }
  return result;
}

// Main function to execute the confidence recalculation based on provided arguments.
async function main() {
  const args = parseArgs(process.argv.slice(2));
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

  try {
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats) throw new Error(`Path not found: ${filePath}`);

    let totalCount = 0;
    const totalChanges: Array<[string, any, any]> = [];

    async function processSingleFile(p: string) {
      const content = await fs.readFile(p, 'utf8');
      if (args.dryRun) {
        const tmpPath = p + '.tmp.recalc.json';
        await fs.writeFile(tmpPath, content, 'utf8');
        const res = await recalc(tmpPath, args.preserve, minFloor);
        await fs.unlink(tmpPath).catch(() => {});
        return res;
      } else {
        return await recalc(p, args.preserve, minFloor);
      }
    }

    if (stats.isDirectory()) {
      // recursively find .json files
      async function walk(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const ent of entries) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) await walk(full);
          else if (ent.isFile() && ent.name.endsWith('.json')) {
            const { count, changes } = await processSingleFile(full);
            totalCount += count;
            totalChanges.push(...changes);
            if (changes.length) console.log(`Updated ${full}: ${changes.length} changes`);
          }
        }
      }
      await walk(filePath);
    } else if (stats.isFile()) {
      const { count, changes } = await processSingleFile(filePath);
      totalCount += count;
      totalChanges.push(...changes);
    }

    console.log(`Total updated entries: ${totalCount}`);
    if (totalChanges.length) {
      console.log('Examples (case_id, old, new):');
      for (const it of totalChanges.slice(0, 20)) console.log(it);
    }
    if (args.dryRun) console.log('Dry-run: исходные файлы не изменены.');
  } catch (err: any) {
    console.error('Error:', err.message || err);
    process.exit(1);
  }
}

if (require.main === module) main();
