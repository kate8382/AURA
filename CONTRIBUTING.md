# Contributing to AURA

Thank you for your interest in **AURA**. To ensure consistent quality, intellectual property control, and a focused product roadmap, **AURA is currently developed and maintained solely by the original author Ecaterina Sevciuc (@kate8382)**.

At this time we do **not** accept external code contributions, Pull Requests (PRs), or direct database additions. The maintainer will review external feedback and decide whether to incorporate it.

---

## How you can help (without PRs)

Even though we do not accept direct code or data PRs, community feedback is valuable. Please use Issues for the following:

### 1) Bug reports & reproducible issues
- Open an Issue titled `bug: <short description>` with steps to reproduce, expected vs actual behaviour, and any relevant logs or minimal examples.

### 2) Feature or scenario suggestions
- Open an Issue titled `idea: <short title>` or use the `idea` label. Provide a concise scenario description, suggested triggers, and why it is important.
- If the suggestion is accepted, the maintainer may implement, validate, and commit the case; contributors who provided the idea will be credited in release notes on request.

### 3) Integration feedback & evaluation reports
- If you integrate `public_cases/` into pipelines, share aggregated evaluation metrics (false positives/negatives), environment details, and example inputs (anonymized). This helps improve heuristics.

---

## Private / Commercial Requests

- **Public dataset:** `public_cases/` is available under CC BY‑NC 4.0 for non‑commercial use. Do not expect direct support or PR merges for public cases.
- **Commercial licensing:** For commercial access to expanded datasets, private branches, or API access, contact: [e.sevciuc82@gmail.com](mailto:e.sevciuc82@gmail.com) or via LinkedIn: [Ecaterina Sevciuc](https://www.linkedin.com/in/ecaterina-sevciuc-497017364/). Commercial arrangements may include NDA, dataset export, or private repository access.
- **Non‑commercial private testing option:** If you are a non‑commercial developer or researcher and want private‑case testing, we offer a collaborative evaluation: you may provide a sandboxed agent endpoint or temporary access credentials; the maintainer will run private cases locally (no private data will be published) and return evaluation results or trained model artifacts as agreed. Contact via the email above to arrange terms.

## Security & data handling

- Do not submit real personal data or sensitive records in Issues or attachments. Public cases should never contain PII.
- Private datasets (`private_cases/`) are managed by the maintainer; if you supply any sample data for private testing it must be anonymized and provided under an agreed contract.

## Testing & expectations

- The repository includes validation tooling and tests. Before suggesting schema changes, run local checks: `npx tsc --noEmit`, `npm run validate` (or `npm run validate:percases`), and `npm test`.
- Tests are located in `scripts/__tests__/`.

## Licensing reminder

- **Software & tooling:** Apache License 2.0 — see [LICENSE](./LICENSE).
- **Public cases (`public_cases/`):** CC BY‑NC 4.0 — see [DATA_LICENSE](./DATA_LICENSE).

If a suggestion is implemented by the maintainer, contributed ideas will be credited in release notes upon request.

---

*If you have an idea that doesn't fit as a bug or PR, open an Issue and label it `idea` — the maintainer will review it.*