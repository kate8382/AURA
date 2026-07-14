# GOVERNANCE

This document describes a lightweight governance model for AURA, aligned with the project's CONTRIBUTING and LICENSE documents. It defines roles, approval workflows, release policy, and security reporting.

## Roles and Responsibilities

- **Project Lead — Ecaterina Sevciuc (@kate8382)**: final decision authority for major changes, strategy, architecture, and licensing.
- **Maintainers**: trusted team members with write access who review, test, and merge PRs.
- **Contributors**: community members who open issues, propose cases, or submit PRs.

## Decision‑Making Process

We use a tiered approval model:

1. Small changes (typos, docs, minor schema tweaks): merge after 1 maintainer approval and passing CI (typecheck/validation/tests).
2. Medium changes (new validation scripts, non‑breaking refactors, adding public cases): require 2 maintainer approvals or clear consensus in Issues.
3. Large/controversial changes (schema changes, API/contract changes, licensing): discuss in a public Issue; maintainers seek consensus and the Project Lead has final say.

## Release Policy

- Follow Semantic Versioning (MAJOR.MINOR.PATCH).
- Tag releases in Git and publish release notes in `CHANGELOG.md`.

## Licensing & Dataset

- **Code & tooling:** Apache License 2.0 — see [LICENSE](./LICENSE).
- **Public cases (`public_cases/`):** Creative Commons Attribution‑NonCommercial 4.0 (CC BY‑NC 4.0) — see [DATA_LICENSE](./DATA_LICENSE).

All contributions must conform to the repository licensing. Contributors should not submit premium content to `main` — keep premium cases in a private branch or private repo.

## How to propose changes

1. Open an Issue describing the problem and proposed approach.
2. Create a branch named `feature/…` or `fix/…` from `main` and implement changes.
3. Run local checks: `npx tsc --noEmit`, `npm run validate` (or `npm run validate:percases`), and `npm test`.
4. Create a Pull Request referencing the Issue, include changelog entry and tests. PRs must pass CI and at least the required maintainer approvals per change size.

## Tests, CI & pre‑commit

- Tests live under `scripts/__tests__/` (Jest). Ensure tests cover changes to scripts and generators.
- Required pre‑merge checks: `npx tsc --noEmit`, `npm run validate` (or `npm run validate:percases`), `npm test`.
- Optionally set up pre‑commit hooks (Husky/Prettier/ESLint) to enforce formatting and prevent common mistakes.

## Code of Conduct

- Adopt a `CODE_OF_CONDUCT.md` for community behaviour; enforce respectful collaboration and a clear reporting path.

## Reporting security vulnerabilities

If you discover a security issue in validators, schemas, or tooling, do not open a public issue. Contact maintainers privately via the email listed in [README.md](./README.md).

## Notes

- Link to canonical per‑case schema: `schemas/per-case-schema.json` (use this to validate new cases).
- Maintain consistent terminology: `public_cases/` is the public dataset; premium datasets belong to private branches.
