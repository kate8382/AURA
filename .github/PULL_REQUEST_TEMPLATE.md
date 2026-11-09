## Summary / Context

Closes #<!-- issue number -->
<!-- or: Fixes #<issue number> -->

<!-- Briefly describe what changed and why. -->

## Type of Change

- [ ] Bug fix
- [ ] New real case (`real_cases/`, `RC-` prefix)
- [ ] New synthetic case (`synthetic_cases/`, `SC-` prefix)
- [ ] Infrastructure / Feature
- [ ] Refactoring / Docs

## Checklist before requesting review

- [ ] `npm run validate` (synthetic cases pass schema & prefix checks)
- [ ] `npm run validate:real` (real cases pass provenance, `source_id` and pointer-only rules, if modified)
- [ ] `npm run validate:triggers` (signal mapping and triggers are valid)
- [ ] `npx tsc --noEmit` and `npm test` pass with zero errors
- [ ] No temporary `.bak` files committed
- [ ] Commit history is clean (squashed as needed)
