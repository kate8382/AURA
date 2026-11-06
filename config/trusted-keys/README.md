# PGP trust store (`config/trusted-keys/`)

This directory is the **static, local trust store** used by the `pgp-verify`
cross-check adapter (`scripts/policy/pgp/`). There is no Trust-On-First-Use, no
keyserver lookup and no network access: a signature is trusted only when it
verifies against a certificate that is listed here.

The trust store ships **empty on purpose** (Maintainer decision D-1):

```
config/trusted-keys/
├── README.md        # this file
└── manifest.json    # {"version": 1, "keys": []}
```

An empty store is valid and loads successfully. Every verification attempt then
fails closed with `verification_status: "no_active_trusted_key"`.

## Adding a trusted signer

1. Obtain the signer's **public** key as ASCII armor, for example:

   ```bash
   gpg --armor --export 0x<KEYID> > config/trusted-keys/<name>.asc
   ```

2. Read the primary-key fingerprint:

   ```bash
   gpg --with-colons --import-options show-only --import < config/trusted-keys/<name>.asc | awk -F: '/^fpr:/ {print $10; exit}'
   ```

3. Add an entry to `manifest.json`:

   ```json
   {
     "version": 1,
     "keys": [
       {
         "fingerprint": "0123456789ABCDEF0123456789ABCDEF01234567",
         "key_file": "example-signer.asc",
         "signer_identity": "Example Signer <signer@example.org>",
         "roles": ["security-reviewer"],
         "status": "active",
         "valid_from": "2026-01-01T00:00:00Z",
         "valid_to": "2027-01-01T00:00:00Z"
       }
     ]
   }
   ```

4. Run `npx jest scripts/__tests__/pgp-trust-store.test.ts` and, ideally,
   `npm test` before committing.

## Manifest schema (strict)

| Field | Required | Rules |
| --- | --- | --- |
| `version` | yes | must be the number `1` |
| `keys` | yes | array, at most **64** entries |
| `fingerprint` | yes | **uppercase** hex, 40 characters (v4 keys; 64 accepted by the schema), unique in the store |
| `key_file` | yes | single path segment ending in `.asc`, no directories, no `..`, no hidden files, unique in the store |
| `signer_identity` | yes | single line, non-empty, ≤ 320 characters — **informational only** (D-2) |
| `roles` | no | up to 8 labels matching `[a-z0-9-]` — **informational only** (D-2) |
| `status` | yes | `active` or `disabled`; only `active` entries can anchor trust |
| `valid_from` | yes | ISO-8601 UTC, second precision: `YYYY-MM-DDTHH:MM:SSZ` |
| `valid_to` | no | `null` (or omitted) for "no end", otherwise the same format and later than `valid_from` |

Unknown fields are rejected at both the document and the entry level. A single
invalid entry invalidates the **whole** store — no entry is ever skipped
silently.

## Filesystem rules

* `manifest.json` must be a regular file (not a symlink) of at most 256 KiB.
* Every `.asc` file in the directory **must** be referenced by the manifest;
  stray key files are rejected.
* Key files must be regular, non-symlink files (opened with `O_NOFOLLOW`),
  at most 64 KiB, resolving inside the store directory. Path traversal and
  absolute paths are rejected.
* Private key material (`PRIVATE KEY` / `SECRET KEY` armor) is rejected.
* Each certificate must parse, must be public, must match the manifest
  fingerprint exactly, and must not expose duplicate Key IDs.
* Key IDs must be unique across the **entire** store. Key ID is the only key
  identifier OpenPGP.js reports for a verified signature, so a collision would
  make signer resolution ambiguous.
* The store directory is resolved from the **module location**
  (`scripts/policy/pgp/`), never from `process.cwd()`, so trust decisions
  cannot be redirected by the caller's working directory.

## Verification policy

| Topic | Policy |
| --- | --- |
| Trust anchor | primary-key fingerprint of an **active** manifest entry only; the signing-subkey fingerprint is recorded separately and is never an anchor |
| Fingerprint source | read from our own parsed certificate — never from `verify()` results or issuer subpackets (both are attacker-influenced) |
| Verification strategy | every candidate entry is verified independently; there is no reliance on library key selection to decide trust |
| Time | primary keys, signing subkeys, and the manifest window are evaluated at the **current** verification time; the signature's self-asserted creation time is never used to justify an expired or revoked key |
| Revocation | revoked primary keys and revoked signing subkeys are rejected |
| Subkey bindings | binding validity is checked per subkey; unusable subkeys are excluded and reported |
| Signature types | detached: binary (0x00) and canonical text (0x01); cleartext: canonical text (0x01) only. Everything else is rejected |
| Hash algorithms | SHA-224/256/384/512 only — SHA-1, MD5, RIPEMD are rejected |
| Public-key algorithms | RSA (encrypt-sign / sign), ECDSA, EdDSA (legacy) and Ed25519 only |
| Curves | NIST P-256/P-384/P-521 and Ed25519 only |
| RSA size | at least 3072 bits |
| Multiple signatures | every signature packet must verify against a trusted entry; the result is order-independent and there is no first-valid-signature-wins path |
| `expected_signer` | must equal (after trimming) the `signer_identity` of a verifying entry |

OpenPGP.js is additionally configured fail-closed (`minRSABits: 3072`,
`ignoreUnsupportedPackets: false`, `ignoreMalformedPackets: false`,
`allowMissingKeyFlags: false`, `allowInsecureVerificationWithReformattedKeys:
false`, `v6Keys: false`, SHA-1/MD5/RIPEMD and weak algorithms rejected), but the
application-level allow-lists above are authoritative.

## Input contract

Only these requirement fields are read:

* detached mode: `signed_message` + `detached_signature`
* cleartext mode: `cleartext_message`
* optional: `expected_signer`

Limits: `signed_message` ≤ 256 KiB, `detached_signature` ≤ 64 KiB,
`cleartext_message` ≤ 256 KiB, `expected_signer` ≤ 320 characters.

## Audit record

`cross_check_audit[].result` contains:

```json
{
  "mode": "detached",
  "verification_status": "verified",
  "key_id": "78F2A3FB0E804830",
  "fingerprint": "16ABB52BA99F700D07ADEFF278F2A3FB0E804830",
  "signing_key_fingerprint": null,
  "signer_identity": "Example Signer <signer@example.org>",
  "expected_signer_matched": null,
  "signature_count": 1,
  "trusted_signers": [
    {
      "signature_index": 0,
      "fingerprint": "16ABB52B...",
      "key_id": "78F2A3FB0E804830",
      "signing_key_fingerprint": null,
      "signer_identity": "Example Signer <signer@example.org>"
    }
  ],
  "trust_store_entries": 1,
  "trust_store_reason": null,
  "trust_store_detail": null,
  "reason": "ok",
  "checked_at": "2026-11-04T12:00:00.000Z"
}
```

`notes` only ever contains a fixed string built from the status enum. Message
text, signature text, private key material, attacker-controlled strings and
parser exceptions are never recorded.

When several trusted signers verify a message, the top-level `key_id`,
`fingerprint`, `signing_key_fingerprint` and `signer_identity` refer to the
entry with the lexicographically smallest fingerprint, so the audit value does
not depend on signature packet order. Full detail stays in `trusted_signers`.

## Wiring

`CrossCheckAdapter` registers the adapter under the name `pgp-verify`, so audit
entries carry `verifier: "adapter:pgp-verify"`. Requirement IDs are routed via
`crossCheckAdapters` in `config/trigger-weights.json`:

```json
"crossCheckAdapters": {
  "cc-pgp-signature": "pgp-verify"
}
```

`scripts/generate-trigger-weights.ts` preserves that key (and
`writeCrossCheckAudit`) when it rewrites the weights file, and a regression test
covers it.

## Known limitations

* A **valid but untrusted co-signature** cannot be distinguished from an
  attacker-injected packet without the co-signer's public key, so the adapter
  rejects the whole verification. This is the fail-closed reading of the
  approved multi-signature policy.
* Duplicate Key IDs across two different certificates cannot be produced with
  a real keypair; the store-level rule is covered by a unit test of the
  duplicate detector.
* OpenPGP.js cannot generate SHA-1 or non-document signature packets, so those
  rejection paths are tested against real packets whose header fields are
  rewritten byte-wise.
* Library exception text is never surfaced; only stable status and reason codes
  are audited.
