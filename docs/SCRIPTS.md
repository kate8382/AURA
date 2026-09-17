# Scripts & Configuration — developer guide

This document contains the detailed developer-oriented description of the generator, the
confidence recalculation pipeline, and helper scripts. The main `README.md` contains only
high-level commands and links to this file.

1) Generator: `scripts/generate-trigger-weights.ts`

- Purpose: scan `public_cases/`, normalize triggers, and compute per-trigger weights written to
  `config/trigger-weights.json`.
- Uses `config/signal-mapping.json` as the canonical mapping between `signal_id` and normalized
  trigger strings. Mapped `signal_id`s are expanded to triggers when computing weights.
- Main commands:

```bash
npm run gen:triggers
CASES_DIR=public_cases npm run gen:triggers
npm run gen:triggers:apply   # run generator and apply `signal_ids` into case files (.bak created)
```

Notes:
- The generator preserves curated keys in `config/trigger-weights.json` to avoid accidental deletion.
- Use `gen:triggers:apply` only when you want `signal_ids` persisted into the case files for auditing
  or external integration.

2) Recalculator: `scripts/recalc_confidence.ts`

- Purpose: recompute `confidence` fields for cases using `config/trigger-weights.json` and
  other heuristic weights.
- Behavior:
  - Loads `config/trigger-weights.json` and `config/signal-mapping.json`.
  - Expands any mapped `signal_ids` into normalized triggers for weight calculation.
  - Unmapped `signal_ids` count toward `signalIdWeight` as a fallback (avoids double-counting).
  - Computes `boost = min(MAX_BOOST, totalTriggerWeight + crossCheckWeight*questions + signalIdWeight*unmappedSignalCount)`.
  - Additionally, `recalc_confidence.ts` now evaluates an operational `decision` for each case and writes `decision` and `decision_reasons` based on a configurable policy (`config/policy.json`). The recalculator preserves an explicit `confidence_raw` when present; otherwise it initializes `confidence_raw` to `0.0` (presumption of innocence).

Usage examples:

```bash
# dry-run
node -r ts-node/register scripts/recalc_confidence.ts --dry-run --dir public_cases

# apply changes
npm run recalc:confidence -- --dir public_cases
```

3) Helper scripts (small, idempotent)

- `scripts/tools/collect-triggers.js` — collects normalized triggers from `public_cases/` and writes
  `tmp/collected-triggers.json`.
- `scripts/tools/audit-categories.js` — simple directory-vs-category audit; writes `tmp/audit-output.json`.

Run via npm shortcuts added to `package.json`:

```bash
npm run collect:triggers
npm run audit:categories
```

4) Signal mapping

- Canonical mapping file: `config/signal-mapping.json`.
- New format: mapping uses compact namespaced keys (for example `camouflage:naive`) where each key maps to an object with `id`, `description`, and a `triggers` array. The generator and recalculator expand mapped keys into normalized triggers when computing weights.
- See [SIGNAL_IDS.md](./SIGNAL_IDS.md) for the recommended workflow to collect triggers and update the mapping.

5) Files and outputs

- Generated configs and intermediate outputs are written to `config/` and `tmp/`. Add `tmp/` to
  `.gitignore` (already recommended) to avoid checking generated artifacts into Git.
- One-off migration helpers live in `scripts/tools/`. Relevant npm shortcuts were added:
  - `npm run migrate:categories` — migrate legacy `category` field into `domain` + human `category` label in `public_cases/`.
  - `npm run migrate:signals` — preview and apply signal ID compaction and update `public_cases.signal_ids`.

6) Automation suggestions

- Consider a CI workflow that runs the generator on changes to `public_cases/`, writes updated
  `config/trigger-weights.json` to a branch and opens a PR for review.

7) Tests

Unit tests for the scripts are located in `scripts/__tests__/` and include:

- `scripts/__tests__/config.test.ts`
- `scripts/__tests__/generate-trigger-weights.test.ts`
- `scripts/__tests__/new-case-template.test.ts`
- `scripts/__tests__/new-case-template.stdin.test.ts`
- `scripts/__tests__/normalize-percases.test.ts`
- `scripts/__tests__/recalc_confidence.test.ts`
- `scripts/__tests__/validate-percases.test.ts`

Run the full test suite with `npm test`.
