import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import GenerateTriggerWeights, { clearSignalMapCache } from '../generate-trigger-weights';

/**
 * Generates `caseCount` synthetic case JSON files in `targetDir` for benchmarking.
 */
async function seedBenchmarkCases(targetDir: string, caseCount: number): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  const batch: Promise<void>[] = [];
  for (let i = 0; i < caseCount; i++) {
    const payload = {
      case_id: `bench-case-${i}`,
      scenarios: [
        {
          name: 'sc-1',
          text: 'User demands urgent bypass of verification.',
          triggers: ['urgency / pressure', 'security control evasion'],
        },
      ],
    };
    batch.push(
      fs.writeFile(path.join(targetDir, `case-${i}.json`), JSON.stringify(payload, null, 2), 'utf8')
    );
  }
  await Promise.all(batch);
}

/**
 * Runs a micro-benchmark comparing sequential (`concurrency = 1`) vs parallel (`concurrency = 4`)
 * execution for `GenerateTriggerWeights` and `NormalizePerCases` on a temporary case set.
 */
export async function runBulkIoBenchmark(caseCount = 200): Promise<void> {
  const tmpSeqRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-bench-seq-'));
  const tmpParRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-bench-par-'));
  try {
    // 1. Seed two completely isolated temp repos so parallel runs do not share tmpRoot caches
    const casesSeq = path.join(tmpSeqRoot, 'cases');
    const casesPar = path.join(tmpParRoot, 'cases');
    for (const repoRoot of [tmpSeqRoot, tmpParRoot]) {
      await fs.mkdir(path.join(repoRoot, 'config'), { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, 'config', 'signal-mapping.json'),
        JSON.stringify({ signals: { 'sig-urgency': ['urgency / pressure'] } }, null, 2),
        'utf8'
      );
    }
    await seedBenchmarkCases(casesSeq, caseCount);
    await seedBenchmarkCases(casesPar, caseCount);

    // 2. Benchmark GenerateTriggerWeights sequential vs parallel (clearing cache between runs)
    clearSignalMapCache();
    const t0 = performance.now();
    await new GenerateTriggerWeights(tmpSeqRoot).run(['--dir', casesSeq, '--concurrency', '1']);
    const genSeqMs = performance.now() - t0;

    clearSignalMapCache();
    const t1 = performance.now();
    await new GenerateTriggerWeights(tmpParRoot).run(['--dir', casesPar, '--concurrency', '4']);
    const genParMs = performance.now() - t1;

    // 3. Benchmark NormalizePerCases sequential vs parallel (when runtime deps like openpgp are installed)
    let normSeqMs: number | null = null;
    let normParMs: number | null = null;
    try {
      const { NormalizePerCases } = await import('../normalize-percases');
      clearSignalMapCache();
      const t2 = performance.now();
      await new NormalizePerCases(true).walkDir(casesSeq, { concurrency: 1, backup: false });
      normSeqMs = performance.now() - t2;

      clearSignalMapCache();
      const t3 = performance.now();
      await new NormalizePerCases(true).walkDir(casesPar, { concurrency: 4, backup: false });
      normParMs = performance.now() - t3;
    } catch (err: any) {
      console.log(`  NormalizePerCases skipped (${err?.code || err?.message || err})`);
    }

    console.log(`Bulk I/O micro-benchmark (${caseCount} files, isolated temp dirs):`);
    console.log(`  GenerateTriggerWeights seq (c=1): ${genSeqMs.toFixed(1)} ms`);
    console.log(`  GenerateTriggerWeights par (c=4): ${genParMs.toFixed(1)} ms`);
    if (normSeqMs !== null && normParMs !== null) {
      console.log(`  NormalizePerCases      seq (c=1): ${normSeqMs.toFixed(1)} ms`);
      console.log(`  NormalizePerCases      par (c=4): ${normParMs.toFixed(1)} ms`);
    }
  } finally {
    await fs.rm(tmpSeqRoot, { recursive: true, force: true });
    await fs.rm(tmpParRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const countArg = process.argv[2];
  const caseCount = countArg && /^\d+$/.test(countArg) ? Number(countArg) : 200;
  runBulkIoBenchmark(caseCount).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
