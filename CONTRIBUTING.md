# Contributing to AURA

Thank you for your interest in contributing to **AURA**! We welcome contributions from both **AI Safety Researchers** (designing new threat scenarios) and **Software Engineers** (improving our validators, calculators, and pipelines).

## How You Can Contribute

### 1. Adding or Improving Threat Cases (For Domain Experts)

You can contribute new grey-zone scenarios to our `public_cases` directory:

- Find the appropriate folder: `MANIPULATION`, `FRAUD`, or `ACCESS`.

- Create a new JSON file following the schema in `schemas/per-case-schema.json`.

- Ensure the prompt texts are **clean, natural human speech** (no in-line metadata or artificial tags).

- Map any psychological or tactical patterns to the canonical per-case schema fields: `case_id`, `category`, `scenarios`, `confidence`, `legal_risk`, `behavioral_patterns`, `cross_check`, `deception_threshold`.

### 2. Enhancing Code and Automation (For Engineers)

We want to keep our pipeline fast and reliable. You can help by:

- Improving the TypeScript case generator or validation scripts in `scripts/`.

- Adding new test cases in Jest to cover edge cases in schema validation.

- Helping build the **Programmatic Prompt Tokenization Engine** (see the Roadmap in [README](./README.md)).

---

## Contribution Workflow

1. **Fork** the repository and create your branch from `main` (e.g., `feature/add-manipulation-cases` or `fix/validator-bug`).

2. Run `npm install` to set up your local environment.

3. Make your changes.

4. **Test your changes:**

- Run typecheck: `npx tsc --noEmit`.
- Run validation: `npm run validate` (or `npm run validate:percases`).
- Run unit tests: `npm test`.

Your PR will not be merged if the schema validation, typecheck or unit tests fail.

## Tests & CI

- Location: `scripts/__tests__/` contains Jest unit tests for scripts and generators.
- Requirement: all tests and schema validations must pass in CI for PR merges (maintainers expect green checks on relevant pipelines).

5. Submit a **Pull Request** with a clear description of what you added/fixed and why it is important for AI safety.

## Licensing of Contributions

By contributing to **AURA**, you agree that:

- Any **code, scripts, or tooling** you submit will be licensed under the **[Apache License 2.0](./LICENSE)**.

- Any **threat cases, matrices, or data** you submit will be licensed under the **[Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](./DATA_LICENSE)**.

---
*If you have a complex idea or a feature request that doesn't fit into a pull request yet, please feel free to open an **Issue** first so we can discuss it!*