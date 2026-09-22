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
  other heuristic weights. The recalculator is written to be auditable: it records the raw
  evidence sum in `confidence_raw` (an audit value) and writes a normalized `confidence` in
  the [0..1] range used by downstream policy and decision logic.
- Behavior:
  - Loads `config/trigger-weights.json` and `config/signal-mapping.json`.
  - Expands any mapped `signal_ids` into normalized triggers for weight calculation.
  - Unmapped `signal_ids` count toward `signalIdWeight` as a fallback (avoids double-counting).
  - Computes a raw evidence sum (`confidence_raw`) by summing per-case trigger weights, the
    cross-check contribution (`crossCheckWeight` * number of cross-check questions), and any
    unmapped `signal_id` fallback contribution. Optionally a category multiplier is applied.
  - The normalized `confidence` is derived from `confidence_raw` using a diminishing-returns
    transform to make the score probability-like:

  The normalization transform converts the auditable raw evidence sum (`confidence_raw`) into
  a probability-like score in the [0..1] interval using a diminishing-returns function:

  $$
  	ext{confidence} = 1 - e^{-\alpha \cdot \text{confidence\_raw}}
  $$

  - `\alpha` (configuration key: `normAlpha` in `config/trigger-weights.json`) controls how
    quickly raw evidence saturates toward 1.0. Smaller values of `\alpha` produce slower
    saturation (more conservative normalization); larger values saturate faster.
  - Recommended default: `normAlpha = 0.3` (matches `config/trigger-weights.json` and provides moderate sensitivity). Historically we
    used `1.0` as a fallback; current recommended tuning for AURA is `0.2-0.35` depending on
    desired sensitivity.
  - Example: if `confidence_raw = 3.0` and `normAlpha = 0.3`, then

  $$
  	ext{confidence} = 1 - e^{-0.3 \times 3.0} \approx 1 - e^{-0.75} \approx 0.59
  $$

  - Implementation note: `scripts/recalc_confidence.ts` reads `normAlpha` from
    `config/trigger-weights.json` and falls back to `1.0` when not present. It's recommended
    to set `normAlpha` explicitly in `config/trigger-weights.json` for reproducible results.
  - The recalculator also evaluates an operational `decision` for each case and writes
    `decision` and `decision_reasons` based on a configurable policy (`config/policy.json`).
    If a case already contains `confidence_raw` the recalculator preserves it unless the
    `--force` behavior is requested — this keeps `confidence_raw` usable as an auditable
    provenance field.

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
