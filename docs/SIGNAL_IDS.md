# Signal ID Mapping

This document explains how AURA maps human-friendly `triggers` (from `scenarios[].triggers`) to system
`signal_ids` (used for confidence boosts and external integrations).

- The canonical mapping lives in `config/signal-mapping.json`.
- At runtime `scripts/recalc_confidence.ts` expands mapped `signal_ids` into normalized triggers for weight
  calculation. If a case includes `signal_ids` explicitly, those are respected; otherwise the tooling will
  derive a deterministic fallback ID from normalized trigger text.

How IDs are generated for unmapped triggers
- When a trigger is unmapped, the tooling derives IDs deterministically from the normalized trigger text,
  for example `"actionable payload"` → `SIG-TRIG-ACTIONABLE-PAYLOAD`. This keeps IDs readable and stable
  across runs.

Regenerating or updating the mapping
1. Collect all unique triggers from `public_cases/` (writes into `tmp/`):

```bash
npm run collect:triggers
# output: tmp/collected-triggers.json
```

2. Edit `config/signal-mapping.json` to add or refine mappings. The file maps a `signal_id` to an array of
   normalized trigger strings, for example:

```json
{
  "SIG-ALIBI-GENERAL": ["ethical justification / alibi", "altruistic alibi"]
}
```

3. Generate trigger weights (reads `config/signal-mapping.json`) and optionally apply `signal_ids` into
   case files (creates `.bak`):

```bash
npm run gen:triggers
npm run gen:triggers:apply
```

Notes
- Prefer runtime fallback to avoid noisy commits when mapping changes frequently.
- Use `npm run gen:triggers:apply` only when you need `signal_ids` persisted into case files for auditing or
  external integration.
