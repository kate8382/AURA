import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/** Upper bound on directories visited during a single traversal (Power-of-10 loop guard). */
export const MAX_WALK_DIRS = 100_000;

/** Upper bound on parallel file workers to avoid file-descriptor exhaustion. */
export const MAX_CONCURRENCY = 32;

/** Default worker count when `--parallel` is passed without an explicit `--concurrency`. */
export const DEFAULT_PARALLEL_CONCURRENCY = Math.min(8, Math.max(2, os.cpus().length || 4));

export interface BulkConcurrencyOptions {
  concurrency: number;
  writeDelayMs: number;
  backup: boolean;
}

export interface WriteWithBackupOptions {
  backup?: boolean;
  writeLimiter?: WriteLimiter;
}

export type WriteLimiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Parses `--concurrency <n>`, `--workers <n>`, `--parallel`, `--write-delay-ms <n>`,
 * and `--backup` from CLI arguments and environment variables.
 */
export function parseConcurrencyOptions(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): BulkConcurrencyOptions {
  // 1. Parse explicit concurrency flag or env override
  let concurrency = 1;
  const rawEnv = env.AURA_CONCURRENCY;
  if (rawEnv && /^\d+$/.test(rawEnv)) {
    concurrency = Number(rawEnv);
  }
  const flagIndex = argv.findIndex((a) => a === '--concurrency' || a === '--workers');
  if (flagIndex !== -1) {
    const rawVal = argv[flagIndex + 1];
    if (!rawVal || !/^\d+$/.test(rawVal)) {
      throw new Error(`${argv[flagIndex]} requires a positive integer`);
    }
    concurrency = Number(rawVal);
  } else if (argv.includes('--parallel') && concurrency <= 1) {
    concurrency = DEFAULT_PARALLEL_CONCURRENCY;
  }

  // 2. Clamp concurrency to [1, MAX_CONCURRENCY]
  const clampedConcurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(concurrency)));

  // 3. Parse optional write rate-limit delay in milliseconds
  let writeDelayMs = 0;
  const delayIndex = argv.findIndex((a) => a === '--write-delay-ms');
  if (delayIndex !== -1) {
    const rawDelay = argv[delayIndex + 1];
    if (!rawDelay || !/^\d+$/.test(rawDelay)) {
      throw new Error('--write-delay-ms requires a non-negative integer');
    }
    writeDelayMs = Math.min(60_000, Number(rawDelay));
  }

  // 4. Enable per-file backups automatically in parallel mode or when `--backup` is passed
  const backup = argv.includes('--backup') || clampedConcurrency > 1;
  return { concurrency: clampedConcurrency, writeDelayMs, backup };
}

/**
 * Iteratively walks `rootDir` using `fs/promises` and returns sorted `.json` file paths.
 * Returns an empty array if `rootDir` does not exist.
 */
export async function walkJsonFilesAsync(
  rootDir: string,
  maxDirs: number = MAX_WALK_DIRS
): Promise<string[]> {
  if (!rootDir || typeof rootDir !== 'string') {
    throw new Error('walkJsonFilesAsync requires a non-empty directory path');
  }
  if (maxDirs < 1) {
    throw new Error('maxDirs must be >= 1');
  }

  // 1. Verify root directory exists; return empty list for ENOENT
  try {
    await fs.access(rootDir);
  } catch (err: any) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  // 2. Iterative breadth-first traversal bounded by maxDirs
  const queue: string[] = [rootDir];
  const jsonFiles: string[] = [];
  let visitedDirs = 0;

  while (queue.length > 0 && visitedDirs < maxDirs) {
    const currentDir = queue.shift()!;
    visitedDirs++;

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        jsonFiles.push(fullPath);
      }
    }
  }

  if (queue.length > 0) {
    throw new Error(`walkJsonFilesAsync exceeded directory limit (${maxDirs}) at ${rootDir}`);
  }

  // 3. Sort paths for deterministic processing order across platforms
  jsonFiles.sort((a, b) => a.localeCompare(b));
  return jsonFiles;
}

/**
 * Runs `worker` over `items` using a bounded pool of at most `concurrency` async workers.
 * Preserves input order in the returned results array.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Array.isArray(items)) {
    throw new Error('runWithConcurrency requires an items array');
  }
  if (items.length === 0) return [];

  const boundedConcurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(concurrency || 1)));
  const workerCount = Math.min(boundedConcurrency, items.length);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(runWorker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Creates a write limiter that serializes writes when `minIntervalMs > 0`
 * (spacing writes by at least `minIntervalMs` ms) or passes through directly when 0.
 */
export function createWriteLimiter(minIntervalMs = 0): WriteLimiter {
  const interval = Math.max(0, Math.floor(minIntervalMs));
  if (interval === 0) {
    return async <T>(task: () => Promise<T>): Promise<T> => task();
  }

  let tail: Promise<void> = Promise.resolve();
  let lastWriteFinishedAt = 0;

  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(async () => {
      const elapsed = Date.now() - lastWriteFinishedAt;
      if (lastWriteFinishedAt > 0 && elapsed < interval) {
        await new Promise((resolve) => setTimeout(resolve, interval - elapsed));
      }
      try {
        return await task();
      } finally {
        lastWriteFinishedAt = Date.now();
      }
    });
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

/**
 * Writes `content` to `filePath` using `fs/promises`, optionally creating a `.bak` backup
 * of the existing file first and routing the I/O through `writeLimiter`.
 */
export async function writeFileWithBackup(
  filePath: string,
  content: string,
  options: WriteWithBackupOptions = {}
): Promise<void> {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('writeFileWithBackup requires a non-empty filePath');
  }
  const { backup = true, writeLimiter } = options;

  const executeWrite = async (): Promise<void> => {
    if (backup) {
      try {
        await fs.copyFile(filePath, `${filePath}.bak`);
      } catch (err: any) {
        if (!err || err.code !== 'ENOENT') throw err;
      }
    }
    await fs.writeFile(filePath, content, 'utf8');
  };

  if (writeLimiter) {
    await writeLimiter(executeWrite);
  } else {
    await executeWrite();
  }
}
