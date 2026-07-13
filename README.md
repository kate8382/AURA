AURA: AI User Risk Assessment Framework
=====================================

AURA (AI User Risk Assessment) is an open-core library of structured behavioral matrices, heuristics, and validation tooling designed to detect manipulation, deception, and hidden threats in human–AI interactions ("grey zones"). AURA provides a lightweight, testable foundation suitable for research, integration into safety pipelines, and extension into commercial SaaS offerings.

<p align="center">
  <img src="assets/banner_1.png" alt="AURA Banner" width="100%"/>
</p>

## Key Features

- Heuristic Risk Calculation — dynamic `confidence` recalculation based on multiple signal sources and cross-checks.
- Structured Behavioral Matrices — curated categories, cross-check rules and deception thresholds for consistent case modeling.
- Automated Schema Validation & Test Suite — AJV-backed validators and Jest tests ensure reproducible case generation and safe consumption.
- Open‑Core Design — a small, useful public dataset and validation tools with optional enterprise matrices and API access for commercial users.

## Repository Structure (recommended)

- `core_matrices/` — curated open-core matrices (3–5 starter cases: behavioral patterns, cross-checks, deception thresholds, grey-zone labels).
- `premium_matrices/` — expanded enterprise matrices intended for private storage or a separate commercial repo (not committed to public repos).
- `scripts/` — developer tooling: `recalc_confidence.ts`, `validate-cases.ts`, and `__tests__/` for unit tests.
- `research/` — migration target for `kate-notes/` (ideas, actions, drafts, provenance artifacts).
- Root config files: `package.json`, `tsconfig.json`, `jest.config.cjs`, `case-generator-schema.json`, `case-generator.ts`.

## Commercial / Premium Roadmap

This repository represents the Open‑Core edition of AURA. The full enterprise dataset — 50+ specialised matrices, daily threat vector updates, and hosted APIs with managed access — will be delivered via a paid Cloud API using `AURA_API_KEY`.

### Early / Commercial Access

- For early access or commercial licensing inquiries, contact: `contact@aura-security.io` (placeholder).
- Recommended licensing model: Open‑core foundation with commercial licensing (dual‑licensing or subscription-based SaaS) for premium matrices and hosted access. See `LICENSE` for the open-core license used in this repo.

## Security & Privacy

- AURA contains behavioural heuristics and example cases for research and engineering use — it should not be used as sole evidence for high-stakes decisions. Combine AURA's signals with human review and enterprise controls.
- Do not include production or sensitive customer data in any case files; sanitize before contributing.

## Quick Start / Installation

Requirements: Node.js (>=16) and npm.

Install dependencies and run tests:

```bash
npm install
npm test
```

Developer helpers:

```bash
npm run recalc:confidence
```

## Contribution & Governance

We welcome contributions to the Open‑Core portion (`core_matrices`, validators, tooling). For governance and contribution rules, add `CONTRIBUTING.md` and `GOVERNANCE.md` (recommended). Suggested contribution workflow:

1. Clone the repo locally.
2. Create a topical branch (e.g., `feature/add-matrix`).
3. Add tests for any new matrix or validation behavior.
4. Open a pull request — include rationale and expected false-positive/false-negative tradeoffs.

### Suggested repo documents to add next

- `CONTRIBUTING.md` — contribution guidelines and testing expectations.
- `GOVERNANCE.md` — decision-making process and maintainership rules for `core_matrices`.
- `CODE_OF_CONDUCT.md` — community rules and reporting.
- `LICENSE` — repository license (AGPL-3.0 suggested; not yet added).

## Roadmap & Research notes

- Review `kate-notes/ideas/` and `kate-notes/actions/` to identify research items suitable for inclusion in `research/` or as roadmap bullets (scaling, API monetization, daily threat updates).
- Consider moving non-core drafts to `research/` to keep the public surface focused and auditable. Premium matrices should be stored separately (private repo or gated storage) for monetization.

## Contact

For commercial inquiries or licensing: contact@aura-security.io (placeholder).

## Acknowledgements

Inspired by best-practice security projects and guardrail frameworks such as OWASP and LangChain Guardrails.

---
© 2026 AURA contributors
