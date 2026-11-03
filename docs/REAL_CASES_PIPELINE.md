# Case Pipeline (step by step): SC- and RC- cases

This guide covers the full path for a case in `synthetic_cases/` (`SC-`) or `real_cases/` (`RC-`):
generate a template, fill the fields, add triggers, map triggers to signal IDs, assign weights,
normalize, recalculate confidence and validate. The steps are the same for both folders. Only the
`provenance` block and the real-write guard apply to `real_cases/` alone.

Command details are in [SCRIPTS.md](./SCRIPTS.md). Licensing rules are in
[DATA_HANDLING_POLICY.md](./DATA_HANDLING_POLICY.md) and [real_cases/NOTICE.md](../real_cases/NOTICE.md).

Run all commands from the repository root. On Windows, use Git Bash or PowerShell.

## 1. Naming

- Synthetic cases: `SC-<domain>-<NNN>`, for example `SC-M-001`, stored in `synthetic_cases/<LETTER>/`.
- Real cases: `RC-<domain>-<NNN>`, for example `RC-M-001`, stored in `real_cases/<LETTER>/`.
- `<domain>` is a single letter (`A`, `F`, `M`, ...). The top-level `domain` field holds the full name (`manipulation`).

## 2. Generate a template

Interactive prompts run only in a TTY. Git Bash, pipes and CI must pass flags.

```bash
npm run new-case:real:dry -- -l M -n 1   # preview only, writes nothing
npm run new-case:real -- -l M -n 1       # writes real_cases/M/RC-M-001.json
npm run new-case:real -- -l M -a         # auto-increment the next number
```

Writes into `real_cases/` require `--allow-real-write`; the npm script already passes it.
The template contains `case_id`, `domain`, `category`, `provenance`, `signal_ids`, `scenarios`
(placeholders), `negative_labels`, `suggested_action`, `legal_risk`, `behavioral_patterns`,
`cross_check`, `deception_threshold`. It does **not** contain `confidence`, `confidence_raw`,
`decision` or `decision_reasons`: those are written only by the scripts in step 5.

## 3. Fill the fields

| Field | What to fill |
|-------|--------------|
| `case_id` | Keep the generated ID. |
| `domain` | Full domain name, for example `manipulation`, `access`, `fraud`. |
| `category` | Snake_case category, for example `instruction_override_and_system_prompt_extraction`. |
| `provenance` | Required for real cases: `source_id` (must exist in `real_cases/NOTICE.md`), `source_url`, `license` (must match NOTICE), `authors` (array, as required for attribution), `redaction_status` (`full_text`, `redacted`, `sanitized`, `pointer_only`, `none`). |
| `signal_ids` | Canonical IDs from `config/signal-mapping.json`, for example `instruction:override`. |
| `scenarios` | One object per text variant (see step 4). |
| `negative_labels` | `{ "status": "unknown" }` unless the case is confirmed negative or benign. |
| `declared_shape` | Optional. If present, `operation_type` must be non-empty and is a sub-operation (for example `system_prompt_extraction`), not the domain. |
| `suggested_action` | Usually `cross_check`. |
| `legal_risk`, `behavioral_patterns`, `cross_check`, `deception_threshold` | Analysis text. Keep the template structure. |

Keep the key order from the template: `case_id, domain, category, provenance, signal_ids, scenarios,
negative_labels, declared_shape, suggested_action, legal_risk, behavioral_patterns, cross_check,
deception_threshold`. The canonical order is defined in `schemas/per-case-schema.json`.

## 4. Scenarios and translations

Each scenario is an object with `name`, `text` and `triggers`.

- The **first** scenario is the original text in its source language (for example German).
- A **translation** is a separate scenario with its own `name` (state "English Translation" in the name),
  its own `text`, and its own `triggers` list. Never put the translation inside the original `text`.
- Triggers are short labels taken from the analysis, written in English so they match across languages.

See [RC-M-001](../real_cases/MANIPULATION/RC-M-001.json) for an example with two scenarios.

## 5. Add triggers

A trigger is a short English label for one behavioral cue found in a scenario `text`.
Triggers come from two sources: manual entry in `scenarios[].triggers`, and the rule-based extractor.

The extractor only emits labels that already exist in `config/signal-mapping.json`. A new label must
therefore be added to the mapping (step 6) before extraction can find it.

```bash
# Synthetic: preview what would be added, then apply
npm run normalize:percases:extract:dry
node -r ts-node/register scripts/normalize-percases.ts synthetic_cases --extract-triggers

# Real: preview, then apply (writes into real_cases/ need the guard flag)
node -r ts-node/register scripts/normalize-percases.ts --dir real_cases --dry-run --extract-triggers
node -r ts-node/register scripts/normalize-percases.ts --dir real_cases --extract-triggers --allow-real-write
```

- Existing triggers are never replaced, reordered or respelled. Extracted labels are appended.
- Only `scenarios[].text` is analysed. `scenarios[].name` is never used as evidence.
- A translation scenario gets its own triggers. They are not copied from the original scenario.

## 6. Map triggers to signal IDs

`config/signal-mapping.json` is maintained by hand. It maps each trigger label to a signal ID
under `signals.<signal_id>.triggers`.

1. Find the signal in `signals`. If it does not exist, add a new entry with `id`, `description`,
   `implied_action` and `triggers`. Check `schemas/signal-mapping-schema.json`.
2. Add the new trigger label to that signal's `triggers` list, in the same style as the others
   (lowercase, short, English).
3. Check the mapping:

```bash
npm run validate:triggers
```

A case's `signal_ids` are derived from its triggers through this mapping. Do not write
`signal_ids` into `signal-mapping.json`.

## 7. Assign weights

`config/trigger-weights.json` holds the weight of each trigger, grouped by severity section
(`=== CRITICAL ... ===`, `=== HIGH ... ===`, and so on).

1. Add the new trigger to the section that matches its severity, with an explicit weight:
   `"new trigger label": 0.3,`.
   A trigger with no explicit weight falls back to the `camo` category by default.
2. Regenerate the weights and signal IDs from the mapping:

```bash
npm run gen:triggers                 # recalculates weights; curated keys are preserved
npm run gen:triggers:apply           # also writes signal_ids into synthetic_cases/ files
```

For real cases, `gen:triggers:apply` does not run automatically. Run it only with the real-write
guard, after reviewing the diff.

3. Delete `config/trigger-weights.json.bak`, which the generator creates. Do not commit it.
4. Review `git diff config/` before committing.

## 8. Normalize and recalculate

Run both in dry-run first and read the output before applying.

```bash
npm run normalize:percases:real                 # dry-run: shows what would change
npm run normalize:percases:real:apply           # writes (adds decision='pending' if missing)
npm run recalc:confidence:real                  # dry-run: shows computed confidence and decision
npm run recalc:confidence:real:apply            # writes confidence, confidence_raw, decision, decision_reasons
```

- `normalize-percases.ts` fills `decision` with `pending` when it is absent.
- `recalc_confidence.ts` writes `confidence`, `confidence_raw`, `decision` and `decision_reasons`
  from the trigger weights and the cross-check adapter.
- The schema accepts all of these fields as optional, so a source file without them is valid.

## 9. Validate

```bash
npm run validate             # synthetic_cases/: schema, case_id prefix
npm run validate:real        # real_cases/: schema, case_id prefix, provenance.source_id against NOTICE, Gandalf pointer_only rule
npm run validate:triggers    # trigger labels against config/signal-mapping.json
npx tsc --noEmit             # type check
npm test                     # unit and integration tests
```

Validation rules for real cases:

- `case_id` must start with `RC-`.
- `provenance.source_id` is required and must be listed in `real_cases/NOTICE.md`.
- `provenance.license` and `provenance.authors` are required for attribution.
- Sources marked conditional in NOTICE (for example `lakera-gandalf-ignore-instructions`) must use
  `redaction_status: "pointer_only"`; `full_text` is rejected.

## 10. Checklist before committing

- [ ] `case_id` uses `SC-<letter>-<NNN>` or `RC-<letter>-<NNN>`, and the file is in the matching `<LETTER>/` folder.
- [ ] For `RC-`: `provenance` is complete and `source_id` matches NOTICE.
- [ ] Original text and translation are separate scenarios.
- [ ] New trigger labels are in `config/signal-mapping.json` and pass `npm run validate:triggers`.
- [ ] New triggers have explicit weights in `config/trigger-weights.json`.
- [ ] `config/trigger-weights.json.bak` is deleted.
- [ ] `declared_shape.operation_type` (if present) is a sub-operation, not the domain.
- [ ] Dynamic fields (`confidence`, `decision`, ...) come from the scripts, not from hand edits.
- [ ] Dry-run output of extract, normalize and recalc was reviewed before applying.
- [ ] `npm run validate`, `npm run validate:real`, `npm run validate:triggers`, `npx tsc --noEmit` and `npm test` pass.
