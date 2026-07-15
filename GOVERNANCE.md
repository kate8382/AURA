# GOVERNANCE

This repository is maintainer‑led and follows a lightweight governance model designed to keep decision making fast and predictable while preserving IP control.

Roles
- **Project Lead:** Ecaterina Sevciuc (@kate8382) — final decision authority on strategic, licensing and major design decisions.
- **Maintainers:** trusted team members (if any) with merge/review rights.
- **Contributors:** external parties may open Issues; direct PRs are not accepted at this time (see [CONTRIBUTING.md](./CONTRIBUTING.md)).

## Decision process
- Small changes (docs, minor fixes): merge at maintainer discretion after verification and passing checks.
- Medium changes (tooling updates, new public cases): require maintainer review and validation; consensus recommended.
- Large/controversial changes (schema, licensing, API): discuss in a public Issue; Project Lead has final say.

## Release policy
- Follow Semantic Versioning (MAJOR.MINOR.PATCH).
- Tag releases and publish notes in `CHANGELOG.md`.

## How to propose changes
1. Open an Issue describing the problem and proposed approach.
2. Include minimal repro steps, example inputs (anonymized) and expected behaviour.
3. The maintainer will review and may implement changes centrally.

**Notes**
- This file reflects the current maintainer‑led policy. If governance changes in the future, this document will be updated.

## Tests, CI & pre‑commit

- Tests live under `scripts/__tests__/` (Jest). Ensure tests cover changes to scripts and generators.
- Required pre‑merge checks: `npx tsc --noEmit`, `npm run validate` (or `npm run validate:percases`), `npm test`.
- Optionally set up pre‑commit hooks (Husky/Prettier/ESLint) to enforce formatting and prevent common mistakes.

## Code of Conduct

- Adopt a `CODE_OF_CONDUCT.md` for community behaviour; enforce respectful collaboration and a clear reporting path.

## Reporting security vulnerabilities

If you discover a security issue in validators, schemas, or tooling, do not open a public issue. Contact the maintainer privately at [e.sevciuc82@gmail.com](mailto:e.sevciuc82@gmail.com) or via LinkedIn: [Ecaterina Sevciuc](https://www.linkedin.com/in/ecaterina-sevciuc-497017364/).

## Dependencies & legal
- Code: Apache-2.0 (see [LICENSE](./LICENSE)).
- Public dataset (`public_cases/`): CC BY‑NC 4.0 (see [DATA_LICENSE](./DATA_LICENSE)).
