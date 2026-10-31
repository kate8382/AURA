# Data-Handling Policy and Source Audit for `real_cases`

> **Status:** Active, for issue [#78](https://github.com/kate8382/AURA/issues/78).
> **Not legal advice.** This document is a practical policy for the AURA project. It explains how we check licenses and handle data. Before any commercial use or any public redistribution of a third-party dataset, a qualified lawyer should review the specific license terms.

This document answers three questions:

1. Which external datasets may we use to build `real_cases/`, and under what conditions?
2. How do we remove private information and dangerous content?
3. When do we store the full text of a prompt, and when do we store only a pointer to it?

## Key terms (plain language)

- **License**: the legal permission the author gives to use, copy, change, and share a dataset. Some licenses are permissive (MIT, Apache-2.0, BSD). Others add conditions or limit use.
- **Attribution**: the requirement to name the original author or project when we use or share their work.
- **Gated access**: the dataset is only available after you accept terms or fill in a form (for example, your name and email). Gated access does not change the license, but it adds conditions we must follow.
- **Full Text**: we store the complete prompt text in our repository.
- **Excerpt / Pointer Only**: we do not store the full text. We store a link to the source, a short description, and a cryptographic hash (a fingerprint) so anyone can check that they have the same item.
- **PII (personal data)**: any information that identifies a person, such as names with contact details, email addresses, phone numbers, account logins, or home addresses.
- **Secret**: any credential that grants access to a system, such as an API key, password, or access token.
- **CSAM**: child sexual abuse material. It is illegal everywhere and is never stored or described in this project.
- **CBRN**: chemical, biological, radiological, and nuclear weapons information.

## 1. Candidate Source Audit Table

Sources are ordered from most to least suitable. Approved sources with open licenses (MIT or Apache-2.0) that contain real prompts or gray-zone examples come first. Sources with unclear licenses, gated access, or extreme content come last.

Facts were checked against each project's license file or dataset metadata page on GitHub and Hugging Face at the time of writing. Re-check before each import, because licenses can change.

| Source | Declared License | Access Conditions | Primary Content Type | Allowed Storage Form | Attribution Requirement | Status | Priority for AURA |
|---|---|---|---|---|---|---|---|
| Lakera gandalf_ignore_instructions (`gandalf-rct`) | Apache-2.0 (project page) / MIT (Hugging Face metadata); to be confirmed | Open, no gate | Prompt Injection / Gray Zones | Full Text only after the license is confirmed | Mention Lakera | Conditional (license to confirm) | High |
| deepset/prompt-injections | Apache-2.0 | Open, no gate | Prompt Injection | Full Text | Mention deepset | Approved | High |
| JailbreakHub (`jailbreak_llms`, mirror `walledai/JailbreakHub`) | MIT | Open, no gate | Real-world Jailbreaks | Full Text | Credit the authors and the paper | Approved | High |
| JailbreakBench (`JailbreakBench/jailbreakbench`) | MIT | Open, no gate | Jailbreaks & Benign Boundary Controls | Full Text | Credit JailbreakBench | Approved | High |
| garak probes (`NVIDIA/garak`) | Apache-2.0 | Open, no gate | Vulnerability scanner probes / extraction attempts | Full Text | Credit garak / NVIDIA | Approved | Medium |
| LLMail-Inject (Microsoft challenge dataset) | MIT | Open, no gate | Indirect Prompt Injections (email / data) | Full Text | Credit the authors | Approved | Medium |
| HackAPrompt (`hackaprompt/hackaprompt-dataset`) | MIT | Gated: a form with contact details is required | Competition submissions (prompt injection) | Excerpt / Pointer Only | Credit HackAPrompt | Conditional | Low |
| HarmBench (`centerforaisafety/HarmBench`) | MIT for code; data under research terms (to be confirmed) | Open | Extreme adversarial / harmful requests | Excerpt / Pointer Only | Credit HarmBench | Conditional (harmful risk) | Low |
| WildJailbreak (`allenai/wildjailbreak`) | ODC-BY (Open Data Commons Attribution) | Gated: must accept AI2 Responsible Use Guidelines | Adversarial prompts & gray zones | Full Text only after confirming gated-access terms allow it; otherwise Excerpt / Pointer Only | Credit AllenAI and the attribution terms of ODC-BY | Conditional (gated) | Low |
| Anthropic hh-rlhf (red-team-attempts) | MIT | Open, no gate | Red-teaming conversations with offensive content | Excerpt / Pointer Only (offensive and harmful content, see section 2.2) | Credit Anthropic | Conditional: License and data status require a separate audit. Deferred to a later stage | Low |
| Lakera PINT | Not confirmed | Not confirmed | Prompt Injections | Pointer Only | Mention Lakera | Pending | Low |
| Tensor Trust (`HumanCompatibleAI/tensor-trust-data`) | None found: the public repository has no LICENSE file (GitHub reports no license) | Public repository, no gate | Game-based injections | Pointer Only | Clarify license first | Pending | Low |

**Notes on corrections and uncertainty:**

- **Lakera PINT:** no public license was found, so the status is Pending until a license is confirmed. Only a pointer is stored in the meantime.
- **Anthropic hh-rlhf:** the issue notes that the dataset contains offensive content. Under section 2.2 it is stored as Pointer Only, so it is not Full Text, even after PII filtering.
- **HarmBench:** the code is MIT. The data has its own research-use terms, so we use pointers only.
- **garak:** the project moved to the `NVIDIA/garak` repository.

## 2. Data-Handling Policy

### 2.1 Removing personal data and secrets (PII & Secrets Redaction)

Before any text is stored in `real_cases/`:

- Every API key, token, password, login, and access credential is replaced with `<REDACTED_SECRET>`.
- Every email address, phone number, name tied to a real person, home address, account name, or other personal data is replaced with `<REDACTED_PII>`.
- Redaction is applied to the full text, including quoted tool outputs and examples.
- If redaction cannot be done reliably, the item is stored as Pointer Only or is excluded.

### 2.2 Harmful and illegal content

- **CSAM:** never stored, quoted, or described. Any item that suggests it is removed and reported through the source's own channels. It is not kept in our repository.
- **CBRN:** instructions for chemical, biological, radiological, or nuclear weapons are not stored. These items are excluded.
- **Malware:** working malicious code, exploit steps, or instructions for building malware are not stored. Only a description of the attack pattern may be kept, with no executable detail.
- **Other dangerous instructions** (for example, making weapons or drugs): either excluded, or stored as Pointer Only with a hash.
- Items that are harmful but needed to test a defense are stored as Pointer Only, never as Full Text.

#### Synthetic Paraphrasing / Sanitized Rewriting

When an interesting attack mechanic or gray-zone case appears in a source with an unclear license, PII, or dangerous content (for example, HarmBench), contributors may:

1. Identify the abstract structure or pattern of the attack (for example, "role-play used to bypass a refusal").
2. Rewrite that pattern in their own words on a safe, unrelated topic.
3. Store the result as a synthetic case in `synthetic_cases/`, or as a `Sanitized/Paraphrased variant` linked to the original source.

The rewritten case must not copy wording, specific payloads, or harmful details from the source. It must be possible to understand the pattern without any dangerous instruction.

### 2.3 Retention and governance

- All approved data lives in `real_cases/`. It follows the same schema, validation, and review rules as the rest of the dataset.
- Each case records its source, license, and attribution in its metadata.
- A source can be removed at any time if its license changes, if the author asks, or if a problem is found.
- Each import is reviewed by a maintainer. The review checks the license, redaction, and storage form.
- Attribution and license information are kept with the dataset, so reuse by others stays lawful.

### 2.4 Linking each case to its source (provenance -> NOTICE)

- Every case in `real_cases/` must set `case_type: "real"` and a `provenance` object.
- Every such case must set `provenance.source_id` to the Source ID of its entry in [real_cases/NOTICE.md](../real_cases/NOTICE.md) (for example `deepset-prompt-injections`). The `source_url` should match the URL listed for that entry.
- A case may not reference a Source ID that is missing from NOTICE or listed under "Excluded sources".
- A case whose source is Conditional must use `redaction_status: "pointer_only"` until the license is confirmed.
- The NOTICE entry, not the case, carries the license text and required citation. Cases copy the `attribution` string when the source requires it.

## 3. Storage Selection Rules (Full Text vs Pointer)

| Storage form | When it is allowed |
|---|---|
| **Full Text** | The source license is MIT, Apache-2.0, or BSD. The source is open (no gate). The item has no personal data after redaction. The item is not extreme, offensive, or dangerous content (see section 2.2). Sources that contain offensive or harmful content, such as hh-rlhf, are Pointer Only even when their license is MIT. |
| **Excerpt / Pointer Only** | The source is gated. The license is unclear or restrictive (for example, ODC-BY with conditions or a research-only license). The item carries PII or harmful-content risk. While a license is still unconfirmed (status Pending), only a pointer is stored. |
| **Excluded** | The content is CSAM or CBRN instructions. Redaction cannot be done reliably. |

**Pointer Only format:** a source link, a short neutral description, the license name, and a SHA-256 hash of the original text. The hash lets anyone verify that they have the same item without us storing it.

**Synthetic Paraphrasing / Sanitized Rewriting:** for items that are Pointer Only, a contributor may store a rewritten, safe analogue as described in section 2.2. Such a case is stored in `synthetic_cases/` or marked `Sanitized/Paraphrased variant`, and it links to the pointer entry.

## 4. Next Steps & License Verification Checklist

Complete these items before importing any data from the source in question.

| # | Task | Source | Done |
|---|---|---|---|
| 1 | Confirm the license (MIT or Apache-2.0) from the dataset file | Lakera gandalf | [ ] |
| 2 | Confirm the data license terms for research use | HarmBench | [ ] |
| 3 | Confirm the license | Lakera PINT | [ ] |
| 4 | Confirm a license grant for the data (the repository has no LICENSE file); if none exists, keep the source excluded | Tensor Trust | [ ] |
| 5 | Confirm whether gated-access terms allow Full Text storage | WildJailbreak | [ ] |
| 6 | Have a qualified lawyer review this policy before any commercial use or public redistribution | All sources | [ ] |
