/**
 * Shared types for the `pgp-verify` cross-check adapter.
 *
 * The strings in `PgpStatus` are part of the persisted `cross_check_audit`
 * contract: they must stay stable so downstream tooling can rely on them.
 */

/** Verification mode derived from the canonical input fields. */
export type PgpMode = 'detached' | 'cleartext';

/**
 * Stable, documented verification statuses.
 *
 * `verified` is the ONLY status that may ever produce `ok: true`; every other
 * value is a fail-closed outcome.
 */
export type PgpStatus =
  | 'verified'
  | 'invalid_input'
  | 'input_too_large'
  | 'malformed_signature'
  | 'unsupported_signature_type'
  | 'disallowed_algorithm'
  | 'invalid_signature'
  | 'untrusted_signer'
  | 'no_active_trusted_key'
  | 'expected_signer_mismatch'
  | 'trust_store_error'
  | 'internal_error';

/** Machine-readable reason codes used for diagnostics (never user input). */
export type PgpReason =
  | 'ok'
  | 'missing_canonical_fields'
  | 'mixed_input_modes'
  | 'unexpected_field_type'
  | 'empty_field'
  | 'field_too_large'
  | 'expected_signer_too_long'
  | 'signature_not_armored'
  | 'signature_unparseable'
  | 'cleartext_unparseable'
  | 'no_signature_packets'
  | 'signature_count_mismatch'
  | 'unsupported_signature_type'
  | 'disallowed_hash_algorithm'
  | 'disallowed_public_key_algorithm'
  | 'disallowed_curve'
  | 'rsa_key_too_small'
  | 'signature_digest_mismatch'
  | 'issuer_not_in_store'
  | 'signer_disabled'
  | 'signer_outside_manifest_window'
  | 'signer_key_not_yet_valid'
  | 'signer_key_revoked'
  | 'signer_key_expired'
  | 'signer_key_invalid'
  | 'signer_subkey_revoked'
  | 'signer_subkey_expired'
  | 'signer_subkey_binding_invalid'
  | 'signer_algorithm_not_allowed'
  | 'ambiguous_signer'
  | 'expected_signer_mismatch'
  | 'no_usable_trusted_key'
  | 'trust_store_unavailable'
  | 'trust_store_invalid'
  | 'library_error'
  | 'unexpected_error';

/**
 * Internal reasons a key from the trust store cannot anchor trust right now.
 * These are mapped onto the stable `PgpReason` codes before they are audited.
 */
export type KeyExclusionReason =
  | 'entry_disabled'
  | 'manifest_not_yet_valid'
  | 'manifest_expired'
  | 'key_created_in_future'
  | 'key_revoked'
  | 'key_expired'
  | 'primary_key_invalid'
  | 'subkey_revoked'
  | 'subkey_expired'
  | 'subkey_binding_invalid'
  | 'algorithm_not_allowed'
  | 'no_signing_key'
  | 'entry_unusable';

/** Trust-store failure codes surfaced in the audit as a stable string. */
export type TrustStoreErrorCode =
  | 'store_dir_not_found'
  | 'store_dir_symlink'
  | 'store_dir_unreadable'
  | 'manifest_missing'
  | 'manifest_too_large'
  | 'manifest_unreadable'
  | 'manifest_invalid_json'
  | 'manifest_invalid'
  | 'key_file_missing'
  | 'key_file_not_regular'
  | 'key_file_symlink'
  | 'key_file_escapes_store'
  | 'key_file_too_large'
  | 'key_file_unreadable'
  | 'key_not_public'
  | 'key_unparseable'
  | 'fingerprint_mismatch'
  | 'key_algorithm_disallowed'
  | 'duplicate_fingerprint'
  | 'duplicate_key_id'
  | 'duplicate_key_file'
  | 'unreferenced_key_file'
  | 'unexpected_error';

/** One signature packet that was accepted, and the trust anchor behind it. */
export interface PgpSignerRecord {
  /** Position of the signature packet in the verified packet list. */
  signature_index: number;
  /** Primary-key fingerprint of the trusted manifest entry (trust anchor). */
  fingerprint: string;
  /** Key ID of the key that actually produced this signature. */
  key_id: string;
  /** Signing-subkey fingerprint, when the signature was made by a subkey. */
  signing_key_fingerprint: string | null;
  /** Manifest display string of the trusted entry. */
  signer_identity: string;
}

/**
 * Structured audit payload stored in `cross_check_audit[].result`.
 *
 * Invariant: this object never contains message text, signature text, private
 * key material, or any string copied from the untrusted input.
 */
export interface PgpAuditResult {
  mode: PgpMode | null;
  verification_status: PgpStatus;
  key_id: string | null;
  fingerprint: string | null;
  signing_key_fingerprint: string | null;
  signer_identity: string | null;
  expected_signer_matched: boolean | null;
  signature_count: number;
  trusted_signers: PgpSignerRecord[];
  trust_store_entries: number;
  trust_store_reason: TrustStoreErrorCode | null;
  trust_store_detail: string | null;
  reason: PgpReason;
  checked_at: string;
}
