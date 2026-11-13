# Case Pipeline (step by step): SC-, RC- and benign cases

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
- Benign (safe) cases: `SC-B-<NNN>` or `RC-B-<NNN>`, where `B` is the `benign` domain letter. The
  `BC-` prefix is not allowed by `schemas/per-case-schema.json` (`^(SC|RC)-[A-Z]-\d{3,}$`).

## 1a. Benign cases (`benign_cases/`)

Safe cases live in a separate root folder, so attack metrics never mix them with attack data:

```
benign_cases/
  synthetic/          SC-B-001.json, SC-B-002.json, ...
  real/               RC-B-001.json, RC-B-002.json, ...
  clarify/
    synthetic/        SC-B-xxx.json (clarifying questions, no provenance)
    real/             RC-B-xxx.json (clarifying questions, provenance required)
```

- `synthetic/`: generated or hand-written examples. `provenance` is not required.
- `real/`: cases based on real user input. `provenance` is required and the `source_id` must exist in
  [real_cases/NOTICE.md](../real_cases/NOTICE.md), as for `real_cases/`. The validator treats any file under
  `benign_cases/real/` and `benign_cases/clarify/real/` as real, so `provenance` is checked even if `case_type` is not set.
- `clarify/synthetic/` and `clarify/real/`: safe cases that need clarifying questions to understand the user's intent (for example, a student's
  experience level). They may have weak context triggers and `cross_check.questions`, and they stay `pending`
  until the questions are answered. Pending here is a wait for an answer, not a block. Validation requires
  `decision: "pending"` and at least one question. These cases are excluded from attack trigger weights.
- Benign cases in `synthetic/` and `real/` have empty `scenarios[].triggers` and `cross_check.questions: []`.
  They never use the hard
  cross-check: `suggested_action` is `allow`, `response_constraint` is `none` (always present), and
  `decision` is `allow` after `recalc:confidence`. Any trigger or question adds weight, and a question
  makes the decision `pending` until it is answered, which breaks `allow`.
- Separation of levels: the AURA verdict (`allow`) is the gate. Clarifying or mentoring questions (for example
  asking about the user's experience level and offering a concept or ready code) are the job of the LLM wrapper
  after it receives `allow`. They are not stored in the case.
- Multi-turn (Crescendo) rule: an `allow` verdict applies only to the current turn. The integrating wrapper
  must run AURA again on every new user message, with the dialogue history, so that a gradual move from harmless
  questions to dangerous ones is caught. A case file describes one turn; a session is not one case.
- Integrator requirement: AURA is a stateless gateway that evaluates each turn separately. Protection against
  Crescendo (multi-turn escalation) is the responsibility of the integrating application. On every turn it must
  send the current message together with the dialogue history or a window of the most recent messages, not an
  isolated reply. The scripts cannot enforce this.
- `npm run validate` and `npm run validate:real` read only `synthetic_cases/` and `real_cases/`.
  `npm run validate:benign` reads only `benign_cases/`. Attack metrics (FPR/TPR) must be computed on
  the attack folders, not on `benign_cases/`.
- Write guard: `benign_cases/real/` requires `--allow-real-write`, the same as `real_cases/`.

## 2. Generate a template

Interactive prompts run only in a TTY. Git Bash, pipes and CI must pass flags.

```bash
npm run new-case:real:dry -- -l M -n 1   # preview only, writes nothing
npm run new-case:real -- -l M -n 1       # writes real_cases/M/RC-M-001.json
npm run new-case:real -- -l M -a         # auto-increment the next number
```

Writes into `real_cases/` and `benign_cases/real/` require `--allow-real-write`; the npm scripts already pass it.
The template contains `case_id`, `domain`, `category`, `provenance`, `signal_ids`, `scenarios`
(placeholders), `negative_labels`, `suggested_action`, `legal_risk`, `behavioral_patterns`,
`cross_check`, `deception_threshold`. It does **not** contain `confidence`, `confidence_raw`,
`decision` or `decision_reasons`: those are written only by the scripts in step 5.

Benign (safe) cases use the `--benign` flag. The template sets `domain: "benign"`, `case_type`,
`negative_labels.status: "benign"`, `suggested_action: "allow"`, `response_constraint: "none"`,
`cross_check.questions: []`, and writes to `benign_cases/synthetic/` or `benign_cases/real/`:

```bash
npm run new-case:benign:dry             # preview SC-B-xxx in benign_cases/synthetic/
npm run new-case:benign                 # writes benign_cases/synthetic/SC-B-<next>.json
npm run new-case:benign:real:dry        # preview RC-B-xxx in benign_cases/real/
npm run new-case:benign:real            # writes benign_cases/real/RC-B-<next>.json (needs provenance)
npm run new-case:clarify:dry            # preview SC-B-xxx in benign_cases/clarify/synthetic/ (one placeholder question)
npm run new-case:clarify:real:dry       # preview RC-B-xxx in benign_cases/clarify/real/ (needs provenance on write)
```

Clarify cases use the `--clarify` flag. Their template has `suggested_action: "cross_check"` and one question, and they are written to `benign_cases/clarify/<kind>/`.

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
npm run validate:benign      # benign_cases/: schema, B domain letter, benign status, suggested_action allow, response_constraint none, decision allow, empty triggers and cross_check.questions
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
- [ ] `npm run validate`, `npm run validate:real`, `npm run validate:benign`, `npm run validate:triggers`, `npx tsc --noEmit` and `npm test` pass.
