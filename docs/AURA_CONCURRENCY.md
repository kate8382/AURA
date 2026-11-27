# AURA Concurrency and Bulk I/O

This document describes how the case-processing scripts read and write many JSON files in parallel, and which
options control it. The shared helpers live in `scripts/lib/bulk-io.ts`.

## Components

| Piece | Where | Purpose |
| --- | --- | --- |
| `walkJsonFilesAsync` | `scripts/lib/bulk-io.ts` | Iterative `fs/promises` traversal that collects `.json` files sorted by path. Returns `[]` for a missing directory and throws if the traversal exceeds `MAX_WALK_DIRS` directories. |
| `runWithConcurrency` | `scripts/lib/bulk-io.ts` | Bounded worker pool. Results keep the input order. On the first error, workers stop taking new items and the error is rethrown (fail-fast). |
| `createWriteLimiter` | `scripts/lib/bulk-io.ts` | Spaces file writes at least `--write-delay-ms` apart. |
| `writeFileWithBackup` | `scripts/lib/bulk-io.ts` | Writes a file and, when `backup` is set, first copies it to `<file>.bak`. |
| `parseConcurrencyOptions` | `scripts/lib/bulk-io.ts` | Reads CLI flags and `AURA_CONCURRENCY`. |
| Signal-map cache | `scripts/generators/generate-trigger-weights.ts` | Caches `signal-mapping.json` by path, invalidated when its mtime or size changes. |

`generate-trigger-weights.ts` and `normalize-percases.ts` use these helpers. Output of `generate-trigger-weights` is
verified to be identical across concurrency levels (see Determinism).

## Options

| Option | Effect |
| --- | --- |
| `--parallel` | Enables parallel processing. If the resulting worker count is 1 (no `--concurrency`/`--workers` and no `AURA_CONCURRENCY` above 1), uses `min(8, max(2, cpuCount))` workers. So `AURA_CONCURRENCY=1` together with `--parallel` also gets the default count. |
| `--concurrency <n>` / `--workers <n>` | Sets the worker count. Clamped to `1..32`. A value that is not a positive integer is an error. |
| `AURA_CONCURRENCY=<n>` | Environment default for the worker count. The flag overrides it. An invalid value (for example `abc` or `-2`) is silently ignored and the default `1` is used. |
| `--write-delay-ms <n>` | Minimum delay between file writes, in ms. Must be a non-negative integer, clamped to `0..60000`. |
| `--backup` | Opt-in `<file>.bak` backup before overwriting a per-case file. |

Per-case files get no `.bak` unless `--backup` is passed. The config file `config/trigger-weights.json` is written
with a `.bak` copy of the previous version on every run.

## Determinism

- Per-file results are merged in sorted file order, so trigger counts and weights do not depend on which worker
  finishes first.
- For `generate-trigger-weights`, running with `--concurrency 1` and `--concurrency 4` must produce identical output.
  `scripts/__tests__/lib/bulk-io.test.ts` checks this. No equivalent test exists yet for `normalize-percases`.

## Safety rules

- Worker count is always bounded by `MAX_CONCURRENCY = 32`. Values above that are clamped, not rejected.
- The `--allow-real-write` guard for `real_cases/` is unchanged and applies regardless of concurrency settings.
- Benign safe cases under `benign_cases/` are excluded from weight generation, as in the sequential mode.

## Benchmark

`scripts/tools/bench-bulk-io.ts` runs a micro-benchmark on generated cases:

```bash
node -r ts-node/register scripts/tools/bench-bulk-io.ts 100
```

Reference numbers from the PR (100 cases):

- `GenerateTriggerWeights`: 13.0 ms with 1 worker, 3.7 ms with 4 workers.
- `NormalizePerCases`: 11.9 ms with 1 worker, 2.4 ms with 4 workers.

Numbers depend on the machine and are for comparison only.
