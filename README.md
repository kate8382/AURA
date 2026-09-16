# AURA: AI User Risk Assessment Framework

**AURA** (AI User Risk Assessment) is an open-source library of structured behavioral matrices, heuristics, and validation tooling designed to detect manipulation, deception, and grey-zone threats in human–AI interactions.

Unlike static safety guardrails, **AURA** focuses on the psychological and tactical vectors of social engineering, helping developers build resilient, context-aware AI agents.

<p align="center">
  <img src="assets/banner_1.png" alt="AURA Banner" width="100%"/>
</p>

## Key Features

- **Granular Threat Categorization** — Structured cases divided into three core domains: `MANIPULATION`, `FRAUD`, or `ACCESS`.

- **Heuristic Risk Scoring** — Dynamic confidence recalculation based on behavioral triggers, alibis, and cross-checks.

- **Strict Schema Validation** — AJV-backed JSON schema and Jest tests to ensure every behavioral case is syntactically correct and ready for AI training or integration.

- **Developer-Friendly Architecture** — Every case is self-contained in a single JSON file, making it incredibly easy to parse, update, and integrate into CI/CD pipelines.

## Repository Structure

```AURA/
├── assets/                  # Graphics and assets
├── config/                  # Runtime mappings and generated configs (signal-mapping.json, trigger-weights.json)
├── docs/                    # Human-facing documentation (including SIGNAL_IDS.md)
├── public_cases/            # Curated open-source threat library
│   ├── ACCESS/              # Privilege escalation, unauthorized OSINT, and credential probing
│   ├── FRAUD/               # Financial bypass, compliance evasion, and social fraud
│   └── MANIPULATION/        # Social engineering, gaslighting, and psychological pressure
├── schemas/                 # JSON Schemas for validating cases
└── scripts/                 # Utility tooling (validation, confidence recalculators, tests)
    └── tools/               # Small helper scripts (collect-triggers, audit-categories)
```

## Quick Start & Testing

### Requirements

- Node.js (>= 18)

- npm or yarn

**1. Installation**

Clone the repository and install the developer dependencies:

```bash

npm install
```

**2. Validate Cases**

To run the automated validation suite against all JSON cases in the `public_cases/` directory:

```bash
npm run validate
# or
npm run validate:percases
```

To run normalization or generate a new case:

```bash
npm run normalize:percases
npm run new-case
# dry-run (does not write files):
npm run new-case:dry
```

To run the custom validator script manually against a specific folder:

```bash
# validate public_cases explicitly
node -r ts-node/register scripts/validate-percases.ts public_cases
```

## Scripts & Configuration

Short developer reference — full details in [docs/SCRIPTS.md](docs/SCRIPTS.md).

- `npm run gen:triggers` — generate `config/trigger-weights.json` from `public_cases/`.
- `npm run gen:triggers:apply` — generate and apply `signal_ids` into case files (creates `.bak`).
- `npm run recalc:confidence` — recompute `confidence` fields (see docs for dry-run flags and options).
- `npm run collect:triggers` — collect normalized triggers into `tmp/collected-triggers.json`.
- `npm run audit:categories` — run category-vs-directory audit into `tmp/audit-output.json`.

**Signal IDs and mappings**
- Reference: the signal ID mapping is documented in [docs/SIGNAL_IDS.md](docs/SIGNAL_IDS.md).
- The canonical mapping file is `config/signal-mapping.json` and the generator/recalculator consults it at runtime. See `docs/SIGNAL_IDS.md` for the recommended workflow: collecting triggers, editing `config/signal-mapping.json`, and regenerating weights.
 - Notes on recent changes: signal IDs were compacted to a namespaced key format (for example `camouflage:naive`, `recon:targeted`), where each mapping entry is keyed by the compact signal ID and includes an `id`, a human-readable `description`, and a `triggers` list. One-off migration scripts were added under `scripts/tools/` and exposed as `npm run migrate:categories` and `npm run migrate:signals` for convenience.

### How trigger weights are computed

- Triggers are counted per case (unique within a case). The most frequent trigger is mapped to `topWeight` (default 0.05) and other triggers get a linear weight scaled relative to that maximum, with a lower bound `defaultTriggerWeight` (0.01).
- Final `confidence` for a case is computed as: base (by category) + boost, where `boost = min(maxBoost, totalTriggerWeight + crossCheckWeight*questions + signalIdWeight*unmappedSignalCount)`.
- The generator preserves any existing trigger keys from the current `config/trigger-weights.json` to avoid accidentally dropping curated keys.

### Automation

Automating `npm run gen:triggers` is optional but recommended if `public_cases/` changes frequently. Typical options:

- GitHub Actions workflow (schedule or on push to `public_cases/`) to run the generator, commit the updated `config/trigger-weights.json`, and open a PR. This keeps changes reviewable and avoids surprise commits.
- CI job that runs `npm run gen:triggers` and `npm run recalc:confidence` in a branch for review.

## Minimal example `public_cases` entry and schema

See the full schema at `schemas/per-case-schema.json` — example minimal valid case (canonical ordering: `confidence_raw` before `scenarios`, `confidence` after `cross_check`):

```json
{
  "case_id": "EX-CASE-001",
  "category": "manipulation/example",
  "confidence_raw": 0.50,
  "signal_ids": [
    "camouflage:naive",
    "evasion:control"
  ],
  "scenarios": [{ "name": "Example", "text": "Please share the customer's password" }],
  "suggested_action": "cross_check",
  "legal_risk": { "short_summary": "Potential privacy breach", "full_text": ["May disclose PII"] },
  "behavioral_patterns": { "short_summary": "Urgency", "full_text": ["Urgency / Pressure"] },
  "cross_check": { "short_summary": "Ask for provenance", "questions": [] },
  "confidence": 0.95,
  "deception_threshold": { "short_summary": "Low", "full_text": [] }
}
```

## Future Roadmap & Collaboration Ideas

We are actively developing **AURA** as a focused, maintainer‑led project. Below are roadmap highlights and ways external teams can collaborate without direct code contributions.

**1. Programmatic Prompt Tokenization (Data Engineering)**

Manual case generation is hard to scale. We want to build a dynamic generator that compiles thousands of diverse test-cases from templates using structural tokenization:

**$$\text{Prompt} = \text{Persona} + \text{Target} + \text{Evasion Method} + \text{Alibi}$$**


**- The Goal:** Write a TypeScript engine that dynamically swaps components (e.g., swapping a "Naive Finder" alibi with an "Academic Researcher" alibi) to stress-test LLM guardrails at scale.

**2. Algorithmic Cross-Checking**

Automate the verification layer based on user claims. For example:

- If the user claims a professional auditor persona, the pipeline should dynamically flag the interaction as high-risk unless specific verification documents (NDAs, authorization letters) are programmatically mocked and requested.

**3. Multilingual Security Testing (Russian & Idiomatic Alignment)**

Traditional AI alignment often fails in non-English languages due to idiomatic nuances and translation bypasses.

- We plan to expand our threat matrices to support complex syntax variations (starting with Russian) to ensure that conceptual defensive guardrails map globally across different language families.

If you are interested in researching these vectors, please open an Issue to share your thoughts and collaborate!

## Publications & Coverage

- Dev.to — [AURA: AI User Risk Assessment — a behavioral threat‑intelligence framework for AI Safety](https://dev.to/kate8382/aura-ai-user-risk-assessment-a-behavioral-threat-intelligence-framework-for-ai-safety-4h9l)
- CoderLegion — [AURA: AI User Risk Assessment — a behavioral threat‑intelligence framework for AI Safety](https://coderlegion.com/22768/aura-ai-user-risk-assessment-a-behavioral-threat-intelligence-framework-for-ai-safety)
- LinkedIn — [Launch post](https://www.linkedin.com/feed/update/urn:li:activity:7483208618545274880/)

## Integration & Partnerships

If you are building an LLM, guardrail engine, or safety pipeline, you may use `public_cases/` under the CC BY‑NC 4.0 license for non‑commercial evaluation, benchmarking, and research.

Partnership & Access Options:

- **Public cases (self‑serve):** Download `public_cases/` and run validations locally with `npm run validate` and tests with `npm test`.
- **Non‑commercial private testing:** For researchers requiring private evaluation, we offer a sandboxed evaluation pipeline where private cases are run locally without publishing sensitive content.
- **Commercial licensing & enterprise access:** NDA, commercial licensing, dataset exports, and private API access options are available upon request.

For commercial licenses, private datasets, or collaborative research, reach out via:
- **Email:** [e.sevciuc82@gmail.com](mailto:e.sevciuc82@gmail.com)
- **LinkedIn:** [Ecaterina Sevciuc](https://www.linkedin.com/in/ecaterina-sevciuc-497017364/)

<!-- TRAFFIC_CHART_START -->

## Traffic history

- **Total views:** 166
- **Total unique views:** 20
- **Total clones:** 150
- **Total unique clones:** 62

![Traffic history](analytics/traffic-history.svg)

Download data: [CSV](analytics/traffic-history.csv)

<!-- TRAFFIC_CHART_END -->

## License & Tooling

- **Code & tooling:** Apache License 2.0 — see `LICENSE`.
- **Public dataset (`public_cases/`):** CC BY‑NC 4.0 — see `DATA_LICENSE`.

## Contribution & Governance

This repository is maintainer‑led. See [CONTRIBUTING.md](CONTRIBUTING.md) for the feedback/issue process and [GOVERNANCE.md](GOVERNANCE.md) for decision rules.