import fs from 'fs';
import os from 'os';
import path from 'path';
import GenerateTriggerWeights, { clearSignalMapCache } from '../generators/generate-trigger-weights';
import {
  createWriteLimiter,
  MAX_CONCURRENCY,
  parseConcurrencyOptions,
  runWithConcurrency,
  walkJsonFilesAsync,
  writeFileWithBackup,
} from '../lib/bulk-io';

describe('bulk-io utilities and parallel-worker smoke tests', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-bulk-io-'));
    clearSignalMapCache();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('parseConcurrencyOptions parses flags, defaults, and clamps to MAX_CONCURRENCY', () => {
    expect(parseConcurrencyOptions([], {})).toEqual({
      concurrency: 1,
      writeDelayMs: 0,
      backup: false,
    });

    const parallel = parseConcurrencyOptions(['--parallel'], {});
    expect(parallel.concurrency).toBeGreaterThanOrEqual(2);
    expect(parallel.backup).toBe(false);

    const parallelWithBackup = parseConcurrencyOptions(['--parallel', '--backup'], {});
    expect(parallelWithBackup.backup).toBe(true);

    const clamped = parseConcurrencyOptions(['--concurrency', '999', '--write-delay-ms', '5'], {});
    expect(clamped).toEqual({
      concurrency: MAX_CONCURRENCY,
      writeDelayMs: 5,
      backup: false,
    });

    expect(() => parseConcurrencyOptions(['--concurrency', 'abc'], {})).toThrow(/positive integer/);
  });

  test('walkJsonFilesAsync returns sorted .json files and [] for missing dir', async () => {
    const missing = await walkJsonFilesAsync(path.join(tmpRoot, 'does-not-exist'));
    expect(missing).toEqual([]);

    fs.mkdirSync(path.join(tmpRoot, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'b.json'), '{}');
    fs.writeFileSync(path.join(tmpRoot, 'sub', 'a.json'), '{}');
    fs.writeFileSync(path.join(tmpRoot, 'ignore.txt'), 'hi');

    const files = await walkJsonFilesAsync(tmpRoot);
    expect(files).toEqual([
      path.join(tmpRoot, 'b.json'),
      path.join(tmpRoot, 'sub', 'a.json'),
    ]);
  });

  test('runWithConcurrency bounds active workers and preserves output order', async () => {
    let active = 0;
    let peakActive = 0;
    const items = [10, 20, 30, 40, 50, 60];

    const results = await runWithConcurrency(items, 2, async (item) => {
      active++;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return item * 2;
    });

    expect(peakActive).toBeLessThanOrEqual(2);
    expect(results).toEqual([20, 40, 60, 80, 100, 120]);
  });

  test('runWithConcurrency fails fast and stops pulling remaining items on error', async () => {
    const started: number[] = [];
    const items = [1, 2, 3, 4, 5, 6, 7, 8];

    await expect(
      runWithConcurrency(items, 2, async (item) => {
        started.push(item);
        if (item === 2) throw new Error('boom');
        await new Promise((resolve) => setTimeout(resolve, 15));
        return item;
      })
    ).rejects.toThrow('boom');

    expect(started.length).toBeLessThan(items.length);
  });

  test('writeFileWithBackup creates .bak and respects createWriteLimiter', async () => {
    const target = path.join(tmpRoot, 'case.json');
    fs.writeFileSync(target, '{"v":1}', 'utf8');

    const limiter = createWriteLimiter(15);
    const t0 = Date.now();
    await Promise.all([
      writeFileWithBackup(target, '{"v":2}', { backup: true, writeLimiter: limiter }),
      writeFileWithBackup(target, '{"v":3}', { backup: true, writeLimiter: limiter }),
    ]);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(12);
    expect(fs.readFileSync(`${target}.bak`, 'utf8')).toBe('{"v":2}');
    expect(fs.readFileSync(target, 'utf8')).toBe('{"v":3}');
  });

  test('GenerateTriggerWeights produces identical output with concurrency=1 and concurrency=4', async () => {
    const repoSeq = path.join(tmpRoot, 'repo-seq');
    const repoPar = path.join(tmpRoot, 'repo-par');

    for (const repo of [repoSeq, repoPar]) {
      fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
      fs.mkdirSync(path.join(repo, 'synthetic_cases'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, 'config', 'signal-mapping.json'),
        JSON.stringify({ signals: { 'sig-urgency': ['urgency / pressure'] } }, null, 2),
        'utf8'
      );
      for (let i = 0; i < 8; i++) {
        fs.writeFileSync(
          path.join(repo, 'synthetic_cases', `c-${i}.json`),
          JSON.stringify({
            case_id: `c-${i}`,
            scenarios: [{ triggers: ['urgency / pressure', i % 2 === 0 ? 'rare trigger' : 'common trigger'] }],
          }),
          'utf8'
        );
      }
    }

    const resSeq = await new GenerateTriggerWeights(repoSeq).run(['--concurrency', '1', '--apply-signal-ids']);
    const resPar = await new GenerateTriggerWeights(repoPar).run(['--concurrency', '4', '--apply-signal-ids']);

    const cfgSeq = JSON.parse(fs.readFileSync(resSeq.outPath, 'utf8'));
    const cfgPar = JSON.parse(fs.readFileSync(resPar.outPath, 'utf8'));
    expect(cfgPar).toEqual(cfgSeq);

    // Backups are strictly opt-in: concurrency=4 without --backup should not create per-case .bak files
    const sampleCase = JSON.parse(fs.readFileSync(path.join(repoPar, 'synthetic_cases', 'c-0.json'), 'utf8'));
    expect(sampleCase.signal_ids).toEqual(['sig-urgency']);
    expect(fs.existsSync(path.join(repoPar, 'synthetic_cases', 'c-0.json.bak'))).toBe(false);

    // Explicit --backup creates per-case .bak files when rewriting
    fs.writeFileSync(
      path.join(repoPar, 'synthetic_cases', 'c-0.json'),
      JSON.stringify({ case_id: 'c-0', scenarios: [{ triggers: ['urgency / pressure'] }] }),
      'utf8'
    );
    await new GenerateTriggerWeights(repoPar).run(['--concurrency', '4', '--apply-signal-ids', '--backup']);
    expect(fs.existsSync(path.join(repoPar, 'synthetic_cases', 'c-0.json.bak'))).toBe(true);
  });

  test('loadSignalMappingAsync caches unchanged files and invalidates when modified on disk', async () => {
    const repo = path.join(tmpRoot, 'repo-cache');
    const mapPath = path.join(repo, 'config', 'signal-mapping.json');
    fs.mkdirSync(path.dirname(mapPath), { recursive: true });
    fs.writeFileSync(mapPath, JSON.stringify({ signals: { 'sig-a': ['alpha'] } }), 'utf8');

    const g1 = new GenerateTriggerWeights(repo);
    await g1.loadSignalMappingAsync();
    expect(g1.signalMap['alpha']).toBe('sig-a');

    // Unchanged file hits cache
    const g2 = new GenerateTriggerWeights(repo);
    await g2.loadSignalMappingAsync();
    expect(g2.signalMap['alpha']).toBe('sig-a');

    // Modify file on disk -> cache invalidates and picks up new mapping
    fs.writeFileSync(mapPath, JSON.stringify({ signals: { 'sig-b': ['beta'] } }), 'utf8');
    const g3 = new GenerateTriggerWeights(repo);
    await g3.loadSignalMappingAsync();
    expect(g3.signalMap['beta']).toBe('sig-b');
    expect(g3.signalMap['alpha']).toBeUndefined();
  });
});
