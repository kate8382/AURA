### Summary
- **Hardened trigger-extraction logic**: Windowed multi-token matching, merged duplicate `scoringCues` for the same trigger at load-time, and added warnings for cross-trigger overlaps.
- **Updated `config/trigger-extraction.json`**: Collapsed literal duplicate `scoringCues` blocks and tightened the `non-consensual pattern generation` regex so `generate <number>` requires deceptive/mass-generation context (e.g., "generate N phishing emails").
- **Improved `scripts/normalize-percases.ts`**: Unified `repoRoot` resolution (`defaultRepoRoot()`), added `--apply-signal-ids` behavior to recompute `signal_ids` from extracted triggers, explicit dry-run messages, and clearer error surfacing.
- **Added and strengthened tests**:
  - `scripts/__tests__/extract-triggers.test.ts` - negative and positive cases for `generate N` and other extraction rules.
  - `scripts/__tests__/normalize-percases.unit.test.ts` - runs extraction + `--apply-signal-ids`, verifies old SIDs are replaced and mapped/derived SIDs are present.
  - golden/regression tests added for extractor outputs.
- **Misc**: Refactors and small fixes to keep deterministic ordering and canonical mapping; CI/tests pass locally.

### Notable Commits
- `a71ec2d`: fix: harden trigger extraction and signal ID synchronization (#33)
- `5693106`: feat: add rule-based trigger extraction for scenarios (#30)
- `f1adb80`: CI: keep automatic triggers; disable image generation by default
- `1713e82`: feat(confidence): normalize confidence scoring and retune trigger weights (#18)

### Testing
- Full test suite passed locally: `npm test -- --runInBand`.

### Notes
- The extractor will log warnings for phrases/cues that appear in multiple triggers; these are cross-trigger overlaps that may need manual semantic resolution in future config edits.

### Architecture Pipeline
<img width="100%" height="100%" alt="aura-pipeline-v3" src="https://github.com/user-attachments/assets/3d816ee5-7ce2-473d-a6ab-235986cb1834" />