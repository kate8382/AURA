# Signal ID Mapping

This document explains how AURA maps human-friendly `triggers` (from `scenarios[].triggers`) to system signal identifiers used by the generator and the recalculation pipeline.

Key changes (2026-09-15)
- Signal IDs moved to a compact, namespaced key format such as `camouflage:naive` or `recon:targeted`.
- `config/signal-mapping.json` uses a mapping-driven object format where each key is the compact signal ID and the value is an object describing the signal (for example: `{ "id": "camouflage:naive", "description": "...", "triggers": ["..."] }`).
- One-off migration utilities were added under `scripts/tools/` to help update `public_cases/` and the mapping file. Use `npm run migrate:signals` in dry-run mode first to preview changes.

How the new mapping is used
- The canonical mapping lives in `config/signal-mapping.json`.
- At runtime `scripts/recalc_confidence.ts` and `scripts/generate-trigger-weights.ts` load this mapping and expand mapped signal keys into normalized triggers when computing weights and boosts. If a case contains explicit `signal_ids`, those are respected; unmapped triggers get a deterministic fallback ID.

Generating trigger lists and editing the mapping
1. Collect unique normalized triggers from `public_cases/` (writes into `tmp/`):

```bash
npm run collect:triggers
# output: tmp/collected-triggers.json
```

2. Edit config/signal-mapping.json. New entry format example:

```json
{
  "$schema": "[http://json-schema.org/draft-07/schema#](http://json-schema.org/draft-07/schema#)",
  "description": "AURA Signal Mapping",
  "signals": {
    "camouflage:naive": {
      "id": "camouflage:naive",
      "description": "Naive persona framing, including false innocence or hobbyist disguises",
      "triggers": ["naive tech hobbyist camouflage", "naive victim camouflage"]
    }
  }
}
```

Note: Each signal entry's `id` field strictly matches its JSON mapping key (e.g., `"id": "camouflage:naive"`).

3. Generate trigger weights and (optionally) apply `signal_ids` into case files:

```bash
npm run gen:triggers
npm run gen:triggers:apply
```

Migration helper
- Preview mapping migration and case updates:

```bash
npm run migrate:signals -- --dry-run
```

- Apply mapping migration (creates `.bak` files; verify before committing):

```bash
npm run migrate:signals
```

Notes
- Prefer runtime fallback to avoid noisy commits when mapping changes frequently.

- Use `npm run gen:triggers:apply` only when you need `signal_ids` persisted into case files for auditing or external integration.

- Prefer keeping `config/signal-mapping.json` authoritative and perform mapping changes via PRs. Use `migrate:signals` only for one-off bulk updates when necessary.

