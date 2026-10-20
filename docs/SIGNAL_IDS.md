# Signal ID Mapping

This document explains how AURA maps human-friendly `triggers` (from `scenarios[].triggers`) to system signal identifiers used by the generator and the recalculation pipeline.

### Key changes
- Signal IDs moved to a compact, namespaced key format such as `camouflage:naive` or `recon:targeted`.
- `config/signal-mapping.json` uses a mapping-driven object format where each key is the compact signal ID and the value is an object describing the signal (for example: `{ "id": "camouflage:naive", "description": "...", "implied_action": ["access:privilege"], "triggers": ["..."] }`).
- One-off migration utilities were added under `scripts/tools/` to help update `public_cases/` and the mapping file. Use `npm run migrate:signals` in dry-run mode first to preview changes.

### How the new mapping is used
- The canonical mapping lives in `config/signal-mapping.json`.
- At runtime `scripts/recalc_confidence.ts` and `scripts/generate-trigger-weights.ts` load this mapping and expand mapped signal keys into normalized triggers when computing weights and boosts. If a case contains explicit `signal_ids`, those are respected; unmapped triggers get a deterministic fallback ID.

**Note** about `confidence_raw` and `confidence`
- The recalculation pipeline now writes two separate fields for traceability:
  - `confidence_raw`: an auditable raw sum of evidence (the sum of trigger weights, cross-check contributions, and unmapped `signal_id` fallbacks). This value is intended for debugging and review and may exceed 1.0.
  - `confidence`: a normalized probability-like score in the [0..1] range derived from `confidence_raw` via a diminishing-returns formula (see `docs/SCRIPTS.md`).

When editing `config/signal-mapping.json` or performing bulk migrations, prefer the runtime expansion approach (letting the generator/recalculator apply mappings) rather than manually editing `confidence_raw` values in case files.

### Generating trigger lists and editing the mapping
1. Collect unique normalized triggers from `public_cases/` (writes into `tmp/`):

```bash
npm run collect:triggers
# output: tmp/collected-triggers.json
```

2. Edit config/signal-mapping.json. New entry format example:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "description": "AURA Signal Mapping",
  "signals": {
    "camouflage:naive": {
      "id": "camouflage:naive",
      "description": "Naive persona framing, including false innocence or hobbyist disguises",
      "implied_action": ["access:privilege"],
      "triggers": ["naive tech hobbyist camouflage", "naive victim camouflage"]
    }
  }
}
```
- Implied Actions for Downstream Egress Checks (`implied_action`):
Each signal entry may optionally include an `implied_action` field as a `string[]` mapping the psychological threat intent to one or more concrete system action classes (for example `egress:outbound`, `execute:command`, `disclosure:external`). This allows downstream action gates to correlate abstract risk signals with actual execution steps while preserving backward compatibility.

Consumer helper example:

```ts
import { getImpliedActions } from './scripts/tools/signal-action-consumer';

const actions = getImpliedActions('exploit:actionable', ['execute:command', 'egress:outbound']);
// => ['execute:command', 'egress:outbound']
```

**Note:** Each signal entry's `id` field strictly matches its JSON mapping key (e.g., `"id": "camouflage:naive"`).

3. Signal Catalog Versioning & Hashing for Downstream Consumers

To prevent silent drift when external gates or security proxies consume AURA signals, every change to `config/signal-mapping.json` must be accompanied by an updated catalog hash.

- Edit `config/signal-mapping.json` as needed.
- Regenerate the deterministic SHA-256 hash and metadata file:

   ```bash
   npm run gen:signal-hash
   ```
- This updates `config/signal-catalog-meta.json`, which tracks the catalog version, signal count, and SHA-256 checksum.

**Note:** Commit both files together (`signal-mapping.json` and `signal-catalog-meta.json`). CI will fail if the hash does not match the current mapping contents.

4. Generate trigger weights and (optionally) apply `signal_ids` into case files:

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

**Notes:**
- Prefer runtime fallback to avoid noisy commits when mapping changes frequently.

- Use `npm run gen:triggers:apply` only when you need `signal_ids` persisted into case files for auditing or external integration.

- Prefer keeping `config/signal-mapping.json` authoritative and perform mapping changes via PRs. Use `migrate:signals` only for one-off bulk updates when necessary.

