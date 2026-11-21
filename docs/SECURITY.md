# Security

## Dependency Audit Status

Snapshot as of the audit date **2026-11-21**: 0 critical, 0 high (`npm audit`, issue #142).

| Severity | Count (2026-11-21) |
|----------|--------------------|
| Critical | 0 |
| High     | 0 |
| Moderate | 0 |
| Low      | 0 |

This file is updated whenever a new accepted risk is recorded or a new audit is run. It is not a live status.

Runtime dependencies: `openpgp@6.3.2` only (`npm ls --omit=dev`).

Remediation:
- Dev tooling upgraded: `jest` ^30.5.2, `@types/jest` ^30.0.0, `ts-jest` ^29.4.15.
- `package.json` `overrides` pin transitive `glob` ^14.0.6 and `minimatch` ^11.0.9, which fixed the remaining moderate advisories GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249 without downgrading jest.

## Accepted Risks

None. All known advisories are resolved as of the last audit.

Review date for this status: **2027-02-21** (re-run `npm audit` and update the table above earlier if dependencies change before then).

To re-check:

```bash
npm audit
```
