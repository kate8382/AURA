# Contributing to AURA

Thank you for your interest in **AURA**. This guide explains how to propose work, claim tasks, and open pull requests.

---

## 1. Claiming issues

Before you start work or write code, comment on the relevant Issue (for example, "I'd like to work on this"). A maintainer will assign the Issue to you. This prevents duplicated work and conflicting PRs.

## 2. Workflow

- Each task is done in a **separate branch** created from an up-to-date `main`.
- Before opening a PR, run locally:
  - `npm run validate`
  - `npm run validate:real` (if you changed `real_cases/`)
  - `npx tsc --noEmit`
  - `npm test`
- Use the PR template ([PULL_REQUEST_TEMPLATE.md](./.github/PULL_REQUEST_TEMPLATE.md)). Link the Issue with `Closes #<number>` or `Fixes #<number>`.
- **All PRs require at least 1 maintainer approval before merge.**

## 3. Creating Issues

Use the templates in [.github/ISSUE_TEMPLATE/](./.github/ISSUE_TEMPLATE/) and prefix titles as follows:

- `bug:` for bugs, using [bug_report.md](./.github/ISSUE_TEMPLATE/bug_report.md)
- `idea:` for new cases, tools, or ideas, using [feature_request.md](./.github/ISSUE_TEMPLATE/feature_request.md)
- `chore:` or `enhancement:` for architectural improvements
- `security:` for vulnerabilities. **Do not open a public Issue.** See [security.md](./.github/ISSUE_TEMPLATE/security.md)

## 4. Case contributions

- Synthetic cases live in `synthetic_cases/` with the `SC-` prefix.
- Real cases live in `real_cases/` with the `RC-` prefix. Each needs complete `provenance` (source, license, redaction status). Create them with `npm run new-case:real`.
- Do not include real personal data or PII in Issues, PRs, or case files.

## 5. Security

Do not report vulnerabilities in public Issues. Follow [security.md](./.github/ISSUE_TEMPLATE/security.md).

## 6. Licensing

- **Code & tooling:** Business Source License 1.1 (BSL 1.1). See [LICENSE](./LICENSE). Commercial production use requires a separate commercial license.
- **Public cases (`synthetic_cases/`):** CC BY-NC 4.0. See [DATA_LICENSE](./DATA_LICENSE).
- By contributing, you agree that your contributions are released under these licenses.

## 7. Commercial and private requests

For commercial licensing, expanded datasets, or private repository access, contact [e.sevciuc82@gmail.com](mailto:e.sevciuc82@gmail.com) or [Ecaterina Sevciuc on LinkedIn](https://www.linkedin.com/in/ecaterina-sevciuc-497017364/).

---

*Questions? Open an Issue with the `idea:` prefix.*
