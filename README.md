# AURA: AI User Risk Assessment Framework

**AURA** (AI User Risk Assessment) is an open-source library of structured behavioral matrices, heuristics, and validation tooling designed to detect manipulation, deception, and grey-zone threats in human–AI interactions.

Unlike static safety guardrails, **AURA** focuses on the psychological and tactical vectors of social engineering, helping developers build resilient, context-aware AI agents.

<!-- AURA (AI User Risk Assessment) is an open-core library of structured behavioral matrices, heuristics, and validation tooling designed to detect manipulation, deception, and hidden threats in human–AI interactions ("grey zones"). AURA provides a lightweight, testable foundation suitable for research, integration into safety pipelines, and extension into commercial SaaS offerings. -->

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
├── public_cases/            # Curated open-source threat library
│   ├── ACCESS/              # Privilege escalation, unauthorized OSINT, and credential probing
│   ├── FRAUD/               # Financial bypass, compliance evasion, and social fraud
│   └── MANIPULATION/        # Social engineering, gaslighting, and psychological pressure
├── schemas/                 # JSON Schemas for validating cases
└── scripts/                 # Utility tooling (validation, confidence recalculators, tests)
```

## Quick Start & Testing

### Requirements

- Node.js (>= 18)

- npm or yarn

**1. Installation**

Clone the repository and install the developer dependencies:

```Bash

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
## Minimal example `public_cases` entry and schema

See the full schema at `schemas/per-case-schema.json` — example minimal valid case:

```json
{
  "case_id": "EX-CASE-001",
  "category": "manipulation/example",
  "scenarios": [{ "name": "Example", "text": "Please share the customer's password" }],
  "confidence": 0.5,
  "legal_risk": { "short_summary": "Potential privacy breach", "full_text": ["May disclose PII"] },
  "behavioral_patterns": { "short_summary": "Urgency", "full_text": ["Urgency / Pressure"] },
  "cross_check": { "short_summary": "Ask for provenance", "questions": [] },
  "deception_threshold": { "short_summary": "Low", "full_text": [] }
}
```

## Future Roadmap & Collaboration Ideas

We are actively looking for contributors, AI safety researchers, and developers to help scale **AURA**. Here is what we are building next:

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

If you are interested in researching these vectors or writing code for the generator, please open an Issue or jump into our existing Pull Requests!

## LicenseCode & Tooling:

**- code, scripts, or tooling** - **[Apache License 2.0](./LICENSE)**.

**- threat cases, matrices, or data** - **[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](./DATA_LICENSE)**.

## Contribution & Governance

For contribution guidelines and maintainership rules see [CONTRIBUTING.md](CONTRIBUTING.md) and [GOVERNANCE.md](GOVERNANCE.md).