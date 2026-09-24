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

    - Cross-check integration: the recalculator calls the `crossCheckAdapter` when a case
      contains `cross_check.questions`. The adapter evaluates machine-checkable requirements
      (via registered adapters) and returns an audited `cross_check_audit` array plus a
      numeric `total_weight` which is added to `confidence_raw`. See `scripts/policy/crossCheckAdapter.ts` for API and `scripts/__tests__/crosscheck.test.ts` for examples.



Usage examples:

```bash
# dry-run
node -r ts-node/register scripts/recalc_confidence.ts --dry-run --dir public_cases

# apply changes
npm run recalc:confidence -- --dir public_cases
```

3) Trigger extraction: `scripts/extract-triggers.ts` + `normalize-percases --extract-triggers`

- Purpose: lightweight, deterministic, rule-based extraction of trigger candidates from
  `scenarios[].text` (Issue #8). English-only; no ML, embeddings, TF-IDF, or external NLP
  libraries. Inspects `scenario.text` only — never `scenario.name` (avoids label leakage).
- Vocabulary: the extractor only emits labels that already exist in the canonical
  `config/signal-mapping.json` vocabulary (exact canonical spelling). Rules referencing an
  unknown label are a configuration error, not a new label.
- Configuration: `config/trigger-extraction.json` (human-readable; separate from
  `signal-mapping.json`) holds keyword/phrase rules, regex rules, stopwords, and scoring
  parameters. Invalid config (malformed rules, bad regex, unknown labels, bad threshold)
  fails clearly instead of being silently accepted.
- Matching (conservative, deterministic):
  - Regex rules, case-insensitive, with explicit word boundaries.
  - Keyword/phrase rules matched token-aware (punctuation-tolerant): `research` does not
    match `researcher`, `student` does not match `students`, `scrape` does not match
    `scraper`. Morphological variants are listed explicitly in config (no stemming).
  - Stopword-aware tokenizer (configurable stopwords; tolerates punctuation and
    bracketed placeholders such as `[ALERT: ]`).
  - Scoring fallback: per-trigger weak-cue token overlap. A trigger fires only when at
    least `minMatches` (default 2) distinct cues co-occur AND the matched fraction reaches
    `threshold` (default 0.5), so a single generic word can never create a trigger alone.
  - Results are deduplicated and ordered by canonical vocabulary order (stable).
- Normalizer integration (opt-in; default behavior unchanged):
  - Missing/empty `triggers` are populated only when candidates are found (never an
    invented empty list). Existing triggers are preserved exactly (never replaced,
    reordered, or respelled); extracted labels are appended, deduplicated by normalized
    trigger identity (same identity as trigger weighting). Running twice adds nothing.
  - Extraction runs BEFORE signal-ID derivation, so `--extract-triggers --apply-signal-ids`
    derives signal IDs from the augmented triggers. Applies to all case shapes (single
    cases, wrapped/multi-case files).
- Usage:

```bash
npm run normalize:percases:extract:dry   # preview additions, writes nothing
node -r ts-node/register scripts/normalize-percases.ts public_cases --extract-triggers --dry-run
node -r ts-node/register scripts/normalize-percases.ts public_cases --extract-triggers --apply-signal-ids
```

  Dry-run preview format: `[dry] WOULD ADD triggers <case_id> scenario <i>:` followed by
  one `  - <label>` line per addition. Scenarios with no candidates are not reported.
- Known limitations (by design): rule-based surface matching, not semantic understanding;
  English-only. Expect false negatives for persona/camouflage labels that need contextual
  interpretation (e.g. specific `naive * camouflage` roles), for machine-style labels with
  no surface cues (`bypass_auth`, `financial_request`), and for near-duplicate labels left
  to curator judgment (`academic/student framing`). Technique mentions inside naive
  disavowals (e.g. naming `Instaloader` while claiming ignorance) surface technique
  triggers even when curators labeled only the persona. Bare `immediately/immediate` is
  deliberately not an urgency cue (in the corpus it marks dispute/threat wording).
  Future directions (NOT implemented here; see Issue #9): TF-IDF weighting, embeddings,
  semantic similarity.
- Tests: `scripts/__tests__/extract-triggers.test.ts` (rules, tokenization, scoring,
  config validation) and `scripts/__tests__/normalize-percases-extract.test.ts`
  (augmentation, dedup, dry-run, idempotency, signal-ID composition). Tests use temp
  dirs/fixtures; `public_cases/` is never rewritten by this feature.

4) Helper scripts (small, idempotent)

- `scripts/tools/collect-triggers.js` — collects normalized triggers from `public_cases/` and writes
  `tmp/collected-triggers.json`.
- `scripts/tools/audit-categories.js` — simple directory-vs-category audit; writes `tmp/audit-output.json`.

Run via npm shortcuts added to `package.json`:

```bash
npm run collect:triggers
npm run audit:categories
```

5) Signal mapping

- Canonical mapping file: `config/signal-mapping.json`.
- New format: mapping uses compact namespaced keys (for example `camouflage:naive`) where each key maps to an object with `id`, `description`, and a `triggers` array. The generator and recalculator expand mapped keys into normalized triggers when computing weights.
- See [SIGNAL_IDS.md](./SIGNAL_IDS.md) for the recommended workflow to collect triggers and update the mapping.

6) Files and outputs

- Generated configs and intermediate outputs are written to `config/` and `tmp/`. Add `tmp/` to
  `.gitignore` (already recommended) to avoid checking generated artifacts into Git.
- One-off migration helpers live in `scripts/tools/`. Relevant npm shortcuts were added:
  - `npm run migrate:categories` — migrate legacy `category` field into `domain` + human `category` label in `public_cases/`.
  - `npm run migrate:signals` — preview and apply signal ID compaction and update `public_cases.signal_ids`.

7) Automation suggestions

- Consider a CI workflow that runs the generator on changes to `public_cases/`, writes updated
  `config/trigger-weights.json` to a branch and opens a PR for review.

8) Tests

Unit tests for the scripts are located in `scripts/__tests__/` and include:

- `scripts/__tests__/config.test.ts`
- `scripts/__tests__/extract-triggers.test.ts`
- `scripts/__tests__/generate-trigger-weights.test.ts`
- `scripts/__tests__/new-case-template.test.ts`
- `scripts/__tests__/new-case-template.stdin.test.ts`
- `scripts/__tests__/normalize-percases.test.ts`
- `scripts/__tests__/normalize-percases-extract.test.ts`
- `scripts/__tests__/recalc_confidence.test.ts`
- `scripts/__tests__/validate-percases.test.ts`

Run the full test suite with `npm test`.
