# Security

## Dependency Audit Status

Last verified with `npm audit` on branch `chore/issue-142-npm-audit`:

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 0 |
| Moderate | 0 |
| Low      | 0 |

Runtime dependencies: `openpgp@6.3.2` only (`npm ls --omit=dev`).

Remediation:
- Dev tooling upgraded: `jest` ^30.5.2, `@types/jest` ^30.0.0, `ts-jest` ^29.4.15.
- `package.json` `overrides` pin transitive `glob` ^14.0.6 and `minimatch` ^11.0.9, which fixed the remaining moderate advisories GHSA-3g3m-2fjr-6pw4 and GHSA-g3hv-75wg-m249 without downgrading jest.

## Accepted Risks

None. All known advisories are resolved.

To re-check:

```bash
npm audit
```
