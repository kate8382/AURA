/**
 * `pgp-verify` cross-check adapter.
 *
 * Responsibilities:
 *  - enforce the canonical input contract (no aliases, no case-object scraping,
 *    explicit size limits, limits enforced before any expensive work);
 *  - load the static trust store fail-closed;
 *  - run the cryptographic core;
 *  - return a stable audit record that never contains signed message text,
 *    signature text, private key material or any attacker-controlled string.
 *
 * Expected failures are data (`ok: false`), not exceptions, so a forged or
 * untrusted signature can never propagate as a crash or as a pass.
 */
import {
  MAX_CLEARTEXT_MESSAGE_BYTES,
  MAX_DETACHED_SIGNATURE_BYTES,
  MAX_EXPECTED_SIGNER_CHARS,
  MAX_SIGNED_MESSAGE_BYTES,
} from './policy';
import { loadTrustStore, type TrustStoreLoadResult } from './trustStore';
import { representativeSigner, verifyPgpSignature, type PgpVerificationRequest } from './verify';
import type { PgpAuditResult, PgpReason, PgpStatus, TrustStoreErrorCode } from './types';

/** Canonical input fields. Nothing else is read from the requirement. */
export const CANONICAL_INPUT_FIELDS = [
  'signed_message',
  'detached_signature',
  'cleartext_message',
  'expected_signer',
] as const;

/** Dependency hooks (used by tests; production uses the repository defaults). */
export interface PgpAdapterDeps {
  /** Explicit trust-store directory; defaults to the module-relative repository store. */
  trustStoreDir?: string;
  /** Trust-store loader override. */
  trustStoreLoader?: (options: { dir?: string }) => Promise<TrustStoreLoadResult>;
  /** Clock override. */
  now?: () => Date;
}

/** Shape returned to `CrossCheckAdapter`. */
export interface PgpAdapterReturn {
  result: PgpAuditResult;
  ok: boolean;
  notes: string;
}

type RequirementInput = Record<string, unknown>;

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function emptyAudit(checkedAt: string): PgpAuditResult {
  return {
    mode: null,
    verification_status: 'internal_error',
    key_id: null,
    fingerprint: null,
    signing_key_fingerprint: null,
    signer_identity: null,
    expected_signer_matched: null,
    signature_count: 0,
    trusted_signers: [],
    trust_store_entries: 0,
    trust_store_reason: null,
    trust_store_detail: null,
    reason: 'unexpected_error',
    checked_at: checkedAt,
  };
}

function failure(
  audit: PgpAuditResult,
  checkedAt: string,
  status: PgpStatus,
  reason: PgpReason
): PgpAdapterReturn {
  return {
    result: { ...audit, checked_at: checkedAt, verification_status: status, reason },
    ok: false,
    notes: `pgp verification: ${status}`,
  };
}

function hasField(input: RequirementInput, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, field) && input[field] !== undefined;
}

/**
 * Validates the canonical fields of a requirement.
 *
 * @returns either the normalised request or a stable failure descriptor
 */
function readCanonicalInput(
  input: RequirementInput
):
  | { ok: true; request: PgpVerificationRequest; expectedSigner?: string }
  | { ok: false; status: PgpStatus; reason: PgpReason } {
  const present = CANONICAL_INPUT_FIELDS.filter((field) => hasField(input, field));

  for (const field of present) {
    if (typeof input[field] !== 'string') return { ok: false, status: 'invalid_input', reason: 'unexpected_field_type' };
  }

  const signedMessage = hasField(input, 'signed_message') ? (input.signed_message as string) : undefined;
  const detachedSignature = hasField(input, 'detached_signature')
    ? (input.detached_signature as string)
    : undefined;
  const cleartextMessage = hasField(input, 'cleartext_message') ? (input.cleartext_message as string) : undefined;
  const expectedSignerRaw = hasField(input, 'expected_signer') ? (input.expected_signer as string) : undefined;

  const hasCleartext = cleartextMessage !== undefined;
  const hasDetached = signedMessage !== undefined || detachedSignature !== undefined;

  if (hasCleartext && hasDetached) return { ok: false, status: 'invalid_input', reason: 'mixed_input_modes' };
  if (!hasCleartext && !(signedMessage !== undefined && detachedSignature !== undefined)) {
    // Aliases and partial field sets never fall back to a default mode.
    return { ok: false, status: 'invalid_input', reason: 'missing_canonical_fields' };
  }

  if (hasCleartext) {
    if (cleartextMessage.length === 0) return { ok: false, status: 'invalid_input', reason: 'empty_field' };
    if (Buffer.byteLength(cleartextMessage, 'utf8') > MAX_CLEARTEXT_MESSAGE_BYTES) {
      return { ok: false, status: 'input_too_large', reason: 'field_too_large' };
    }
  } else {
    if ((signedMessage as string).length === 0) return { ok: false, status: 'invalid_input', reason: 'empty_field' };
    if ((detachedSignature as string).trim().length === 0) {
      return { ok: false, status: 'invalid_input', reason: 'empty_field' };
    }
    if (Buffer.byteLength(signedMessage as string, 'utf8') > MAX_SIGNED_MESSAGE_BYTES) {
      return { ok: false, status: 'input_too_large', reason: 'field_too_large' };
    }
    if (Buffer.byteLength(detachedSignature as string, 'utf8') > MAX_DETACHED_SIGNATURE_BYTES) {
      return { ok: false, status: 'input_too_large', reason: 'field_too_large' };
    }
  }

  let expectedSigner: string | undefined;
  if (expectedSignerRaw !== undefined) {
    const trimmed = expectedSignerRaw.trim();
    if (trimmed.length === 0) return { ok: false, status: 'invalid_input', reason: 'empty_field' };
    if (CONTROL_CHARS_RE.test(trimmed)) {
      return { ok: false, status: 'invalid_input', reason: 'unexpected_field_type' };
    }
    if (trimmed.length > MAX_EXPECTED_SIGNER_CHARS) {
      return { ok: false, status: 'invalid_input', reason: 'expected_signer_too_long' };
    }
    expectedSigner = trimmed;
  }

  const request: PgpVerificationRequest = hasCleartext
    ? { mode: 'cleartext', cleartextMessage: cleartextMessage as string }
    : {
        mode: 'detached',
        signedMessage: signedMessage as string,
        detachedSignature: detachedSignature as string,
      };
  if (expectedSigner !== undefined) request.expectedSigner = expectedSigner;

  return { ok: true, request, expectedSigner };
}

/**
 * Creates an adapter function bound to the given dependencies.
 *
 * @param deps optional overrides for the trust store, loader and clock
 */
export function createPgpVerifyAdapter(deps: PgpAdapterDeps = {}) {
  const loader = deps.trustStoreLoader || ((options: { dir?: string }) => loadTrustStore(options));
  const clock = deps.now || (() => new Date());

  return async function pgpVerifyAdapter(requirement: unknown): Promise<PgpAdapterReturn> {
    const checkedAt = new Date().toISOString();
    const audit = emptyAudit(checkedAt);

    try {
      if (!requirement || typeof requirement !== 'object' || Array.isArray(requirement)) {
        return failure(audit, checkedAt, 'invalid_input', 'missing_canonical_fields');
      }

      const parsed = readCanonicalInput(requirement as RequirementInput);
      if (!parsed.ok) return failure(audit, checkedAt, parsed.status, parsed.reason);

      const request = parsed.request;
      const auditWithMode: PgpAuditResult = { ...audit, mode: request.mode };

      const loadOptions: { dir?: string } = {};
      if (deps.trustStoreDir !== undefined) loadOptions.dir = deps.trustStoreDir;

      let loaded: TrustStoreLoadResult;
      try {
        loaded = await loader(loadOptions);
      } catch {
        // A throwing loader is a trust failure; it must never become a pass.
        return failure(auditWithMode, checkedAt, 'trust_store_error', 'trust_store_unavailable');
      }

      if (!loaded.ok) {
        const trustFailure: PgpAuditResult = {
          ...auditWithMode,
          verification_status: 'trust_store_error',
          trust_store_reason: loaded.code as TrustStoreErrorCode,
          trust_store_detail: loaded.detail,
          reason: loaded.code === 'store_dir_not_found' ? 'trust_store_unavailable' : 'trust_store_invalid',
          checked_at: checkedAt,
        };
        return { result: trustFailure, ok: false, notes: `pgp verification: trust_store_error (${loaded.code})` };
      }

      const outcome = await verifyPgpSignature(request, loaded.store, clock());
      const representative = representativeSigner(outcome.signers);

      let expectedSignerMatched: boolean | null = null;
      if (parsed.expectedSigner !== undefined) {
        // `null` means "could not be decided" (for example the signature never
        // verified); `false` is reserved for an explicit identity mismatch.
        if (outcome.status === 'verified') expectedSignerMatched = true;
        else if (outcome.status === 'expected_signer_mismatch') expectedSignerMatched = false;
      }

      const result: PgpAuditResult = {
        mode: outcome.mode,
        verification_status: outcome.status,
        key_id: representative ? representative.key_id : null,
        fingerprint: representative ? representative.fingerprint : null,
        signing_key_fingerprint: representative ? representative.signing_key_fingerprint : null,
        signer_identity: representative ? representative.signer_identity : null,
        expected_signer_matched: expectedSignerMatched,
        signature_count: outcome.signatureCount,
        trusted_signers: outcome.signers,
        trust_store_entries: outcome.trustStoreEntries,
        trust_store_reason: null,
        trust_store_detail: null,
        reason: outcome.reason,
        checked_at: checkedAt,
      };

      return {
        result,
        ok: outcome.status === 'verified',
        notes: outcome.status === 'verified' ? 'pgp verification: verified' : `pgp verification: ${outcome.status}`,
      };
    } catch {
      // Last-resort guard: no unexpected exception may escape as a success.
      return failure({ ...audit, checked_at: checkedAt }, checkedAt, 'internal_error', 'unexpected_error');
    }
  };
}

/** Production adapter bound to the repository trust store and the system clock. */
export const pgpVerifyAdapter = createPgpVerifyAdapter();
