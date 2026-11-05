/**
 * Cryptographic verification core for the `pgp-verify` adapter.
 *
 * Design invariants (see the approved security requirements):
 *  1. Trust is anchored ONLY on the primary-key fingerprint of an active
 *     manifest entry. OpenPGP.js never reports a matched fingerprint, so
 *     verification is executed independently against every manifest entry and
 *     the anchor comes from our own trust store - never from the signature's
 *     issuer subpackets (which are attacker-assertable).
 *  2. Key validity is evaluated at the *current* verification time. The
 *     signature's self-asserted creation time is never used to prove that a
 *     revoked or expired key was usable.
 *  3. Every signature packet is inspected. Nothing is filtered silently.
 *  4. Multi-signature handling is deterministic: every packet must verify
 *     against a trusted entry, so packet order cannot change the outcome and
 *     there is no first-valid-signature-wins path.
 */
import * as openpgp from 'openpgp';

import {
  ALLOWED_CLEARTEXT_SIGNATURE_TYPES,
  ALLOWED_DETACHED_SIGNATURE_TYPES,
  PGP_STRICT_CONFIG,
  checkKeyAlgorithmPolicy,
  checkSignaturePacketPolicy,
} from './policy';
import type { TrustStore, TrustStoreEntry } from './trustStore';
import type { KeyExclusionReason, PgpMode, PgpReason, PgpSignerRecord, PgpStatus } from './types';

/** Canonical, already size-validated verification request. */
export interface PgpVerificationRequest {
  mode: PgpMode;
  signedMessage?: string;
  detachedSignature?: string;
  cleartextMessage?: string;
  expectedSigner?: string;
}

/** Outcome of the cryptographic core (adapter turns this into an audit record). */
export interface PgpVerificationOutcome {
  ok: boolean;
  status: PgpStatus;
  reason: PgpReason;
  /** `null` only when the request mode itself was invalid. */
  mode: PgpMode | null;
  signers: PgpSignerRecord[];
  signatureCount: number;
  trustStoreEntries: number;
}

interface SigningKeyRef {
  fingerprint: string;
  isSubkey: boolean;
}

interface UsableEntry {
  entry: TrustStoreEntry;
  signingKeys: Map<string, SigningKeyRef>;
  /** Subkeys of this entry that exist but may not anchor trust. */
  keyExclusions: Map<string, KeyExclusionReason>;
}

interface PreparedEntries {
  usable: UsableEntry[];
  /** Key ID -> why that key may not anchor trust at this moment. */
  exclusions: Map<string, KeyExclusionReason>;
}

/** Maps an internal exclusion reason onto the stable public reason codes. */
function exclusionToReason(exclusion: KeyExclusionReason): PgpReason {
  switch (exclusion) {
    case 'entry_disabled':
      return 'signer_disabled';
    case 'manifest_not_yet_valid':
    case 'manifest_expired':
      return 'signer_outside_manifest_window';
    case 'key_created_in_future':
      return 'signer_key_not_yet_valid';
    case 'key_revoked':
      return 'signer_key_revoked';
    case 'key_expired':
      return 'signer_key_expired';
    case 'primary_key_invalid':
      return 'signer_key_invalid';
    case 'subkey_revoked':
      return 'signer_subkey_revoked';
    case 'subkey_expired':
      return 'signer_subkey_expired';
    case 'subkey_binding_invalid':
      return 'signer_subkey_binding_invalid';
    case 'algorithm_not_allowed':
      return 'signer_algorithm_not_allowed';
    case 'no_signing_key':
    case 'entry_unusable':
    default:
      return 'no_usable_trusted_key';
  }
}

/** Reads a Date-or-Infinity expiration value into epoch milliseconds. */
function expirationMillis(value: Date | number | null): number {
  if (value === null) return Infinity;
  if (typeof value === 'number') return Infinity;
  return value.getTime();
}

/** Structural view of the library's verification result (not exported by OpenPGP.js). */
interface LibraryVerificationResult {
  keyID: { toHex(): string };
  verified: Promise<unknown>;
}

/**
 * Prepares a single manifest entry for verification at `now`.
 *
 * Performs independent application-level checks (status, manifest window, key
 * creation time, revocation, expiration, algorithm allow-lists, subkey binding
 * validity) in addition to the library's own checks that run during
 * verification with an explicit `date`.
 */
async function prepareEntry(
  entry: TrustStoreEntry,
  now: Date
): Promise<
  { ok: true; usable: UsableEntry } | { ok: false; reason: KeyExclusionReason; keyExclusions: Map<string, KeyExclusionReason> }
> {
  const nowMs = now.getTime();

  if (entry.status !== 'active') return { ok: false, reason: 'entry_disabled', keyExclusions: new Map<string, KeyExclusionReason>() };

  const windowStart = Date.parse(entry.validFrom);
  const windowEnd = entry.validTo === null ? Infinity : Date.parse(entry.validTo);
  if (!Number.isFinite(windowStart)) return { ok: false, reason: 'manifest_not_yet_valid', keyExclusions: new Map<string, KeyExclusionReason>() };
  if (nowMs < windowStart) return { ok: false, reason: 'manifest_not_yet_valid', keyExclusions: new Map<string, KeyExclusionReason>() };
  if (nowMs > windowEnd) return { ok: false, reason: 'manifest_expired', keyExclusions: new Map<string, KeyExclusionReason>() };

  const key = entry.publicKey;

  if (key.getCreationTime().getTime() > nowMs) return { ok: false, reason: 'key_created_in_future', keyExclusions: new Map<string, KeyExclusionReason>() };

  const primaryPolicy = checkKeyAlgorithmPolicy(key);
  if (primaryPolicy !== null) return { ok: false, reason: 'algorithm_not_allowed', keyExclusions: new Map<string, KeyExclusionReason>() };

  let revoked: boolean;
  try {
    revoked = await key.isRevoked();
  } catch {
    // An unknown revocation state can never be treated as "not revoked".
    return { ok: false, reason: 'primary_key_invalid', keyExclusions: new Map<string, KeyExclusionReason>() };
  }
  if (revoked) return { ok: false, reason: 'key_revoked', keyExclusions: new Map<string, KeyExclusionReason>() };

  let expiration: Date | number | null;
  try {
    expiration = await key.getExpirationTime(undefined, PGP_STRICT_CONFIG);
  } catch {
    // Unreadable expiration metadata fails closed.
    return { ok: false, reason: 'primary_key_invalid', keyExclusions: new Map<string, KeyExclusionReason>() };
  }
  if (expirationMillis(expiration) <= nowMs) return { ok: false, reason: 'key_expired', keyExclusions: new Map<string, KeyExclusionReason>() };

  try {
    // Library-side validation of the primary key and its primary user ID at `now`.
    await key.verifyPrimaryKey(now, undefined, PGP_STRICT_CONFIG);
  } catch {
    // Invalid self-signature, revoked user or comparable defect: fail closed.
    return { ok: false, reason: 'primary_key_invalid', keyExclusions: new Map<string, KeyExclusionReason>() };
  }

  const signingKeys = new Map<string, SigningKeyRef>();
  const keyExclusions = new Map<string, KeyExclusionReason>();
  signingKeys.set(entry.primaryKeyId, { fingerprint: entry.fingerprint, isSubkey: false });

  for (const subkey of key.getSubkeys()) {
    const subkeyId = subkey.getKeyID().toHex().toUpperCase();

    // Subkeys whose algorithm is outside the allow-list (for example ECDH
    // encryption subkeys) can never produce a signature that passes the
    // packet-level algorithm policy, so they are not signing candidates at all.
    if (checkKeyAlgorithmPolicy(subkey) !== null) continue;
    if (subkey.getCreationTime().getTime() > nowMs) {
      keyExclusions.set(subkeyId, 'key_created_in_future');
      continue;
    }
    if (subkey.revocationSignatures.length > 0) {
      keyExclusions.set(subkeyId, 'subkey_revoked');
      continue;
    }

    // Expiration is checked before the binding signature so that an expired
    // subkey is reported as expired rather than as an invalid binding.
    let subkeyExpiration: Date | number | null;
    try {
      subkeyExpiration = await subkey.getExpirationTime(now, PGP_STRICT_CONFIG);
    } catch {
      keyExclusions.set(subkeyId, 'subkey_binding_invalid');
      continue;
    }
    if (expirationMillis(subkeyExpiration) <= nowMs) {
      keyExclusions.set(subkeyId, 'subkey_expired');
      continue;
    }

    try {
      // Verifies the subkey binding signature at `now`; throws when the binding
      // is invalid or when the library considers the subkey unusable.
      await subkey.verify(now, PGP_STRICT_CONFIG);
    } catch {
      keyExclusions.set(subkeyId, 'subkey_binding_invalid');
      continue;
    }

    signingKeys.set(subkeyId, {
      fingerprint: String(subkey.getFingerprint()).toUpperCase(),
      isSubkey: true,
    });
  }

  if (signingKeys.size === 0) {
    return { ok: false, reason: 'no_signing_key', keyExclusions };
  }
  return { ok: true, usable: { entry, signingKeys, keyExclusions } };
}

/** Preflights every entry, recording why a key may not anchor trust. */
async function prepareEntries(store: TrustStore, now: Date): Promise<PreparedEntries> {
  const usable: UsableEntry[] = [];
  const exclusions = new Map<string, KeyExclusionReason>();

  for (const entry of store.entries) {
    const prepared = await prepareEntry(entry, now);
    if (prepared.ok) {
      usable.push(prepared.usable);
      for (const [keyId, reason] of prepared.usable.keyExclusions) exclusions.set(keyId, reason);
      continue;
    }
    for (const keyId of entry.keyIds) exclusions.set(keyId.toUpperCase(), prepared.reason);
  }

  // Keys that are permitted on one entry must not be reported as excluded.
  for (const candidate of usable) {
    for (const keyId of candidate.signingKeys.keys()) exclusions.delete(keyId);
  }

  return { usable, exclusions };
}

/** Extracts the issuer Key ID a signature packet claims, uppercase hex. */
function issuerKeyId(packet: openpgp.SignaturePacket): string | null {
  const issuer = packet.issuerKeyID;
  if (issuer === undefined || issuer === null || typeof issuer.toHex !== 'function') return null;
  const hex = issuer.toHex().toUpperCase();
  return hex.length > 0 ? hex : null;
}

/**
 * Verifies a canonical request against the trust store at `now`.
 *
 * Expected failures are returned as data (`ok: false` plus a stable status and
 * reason) - this function never throws for attacker-controlled input.
 */
export async function verifyPgpSignature(
  request: PgpVerificationRequest,
  store: TrustStore,
  now: Date
): Promise<PgpVerificationOutcome> {
  const mode = request.mode;
  if (mode !== 'detached' && mode !== 'cleartext') {
    return {
      ok: false,
      status: 'invalid_input',
      reason: 'missing_canonical_fields',
      mode: null,
      signers: [],
      signatureCount: 0,
      trustStoreEntries: store.entries.length,
    };
  }
  const allowedTypes = mode === 'cleartext' ? ALLOWED_CLEARTEXT_SIGNATURE_TYPES : ALLOWED_DETACHED_SIGNATURE_TYPES;

  const base = {
    mode,
    signers: [] as PgpSignerRecord[],
    signatureCount: 0,
    trustStoreEntries: store.entries.length,
  };

  let packets: openpgp.SignaturePacket[];
  let message: openpgp.Message<string> | openpgp.CleartextMessage;
  let signature: openpgp.Signature | undefined;

  if (mode === 'detached') {
    const armored = (request.detachedSignature || '').trim();
    if (!armored.startsWith('-----BEGIN PGP SIGNATURE-----')) {
      return { ...base, ok: false, status: 'malformed_signature', reason: 'signature_not_armored' };
    }
    let parsed: openpgp.Signature;
    try {
      parsed = await openpgp.readSignature({ armoredSignature: armored, config: PGP_STRICT_CONFIG });
    } catch {
      // Unparsable armor is a malformed signature, never a pass.
      return { ...base, ok: false, status: 'malformed_signature', reason: 'signature_unparseable' };
    }
    signature = parsed;
    packets = Array.from(parsed.packets);
    message = await openpgp.createMessage({ text: request.signedMessage || '' });
  } else {
    const armored = request.cleartextMessage || '';
    let parsed: openpgp.CleartextMessage;
    try {
      parsed = await openpgp.readCleartextMessage({ cleartextMessage: armored, config: PGP_STRICT_CONFIG });
    } catch {
      // Unparsable cleartext armor is rejected without echoing any of its text.
      return { ...base, ok: false, status: 'malformed_signature', reason: 'cleartext_unparseable' };
    }
    const attached = (parsed as unknown as { signature?: openpgp.Signature }).signature;
    if (attached === undefined) {
      return { ...base, ok: false, status: 'malformed_signature', reason: 'no_signature_packets' };
    }
    signature = attached;
    packets = Array.from(attached.packets);
    message = parsed;
  }

  if (packets.length === 0) {
    return { ...base, ok: false, status: 'malformed_signature', reason: 'no_signature_packets' };
  }
  base.signatureCount = packets.length;

  // Packet-level policy runs before any cryptography or key selection.
  for (const packet of packets) {
    const violation = checkSignaturePacketPolicy(packet, allowedTypes);
    if (violation === 'unsupported_signature_type') {
      return { ...base, ok: false, status: 'unsupported_signature_type', reason: 'unsupported_signature_type' };
    }
    if (violation === 'disallowed_hash_algorithm') {
      return { ...base, ok: false, status: 'disallowed_algorithm', reason: 'disallowed_hash_algorithm' };
    }
    if (violation !== null) {
      return { ...base, ok: false, status: 'disallowed_algorithm', reason: 'disallowed_public_key_algorithm' };
    }
  }

  const { usable, exclusions } = await prepareEntries(store, now);

  // A signature whose issuer is a key we already know may not anchor trust
  // (disabled entry, expired/revoked key or subkey, disallowed algorithm) is
  // rejected here, deterministically and before any library work.
  for (const packet of packets) {
    const issuer = issuerKeyId(packet);
    if (issuer === null) continue;
    const exclusion = exclusions.get(issuer);
    if (exclusion === undefined) continue;
    const reason = exclusionToReason(exclusion);
    const status: PgpStatus = reason === 'signer_algorithm_not_allowed' ? 'disallowed_algorithm' : 'untrusted_signer';
    return { ...base, ok: false, status, reason };
  }


  if (usable.length === 0) {
    return { ...base, ok: false, status: 'no_active_trusted_key', reason: 'no_usable_trusted_key' };
  }

  const verifiedBy: Array<{ entry: TrustStoreEntry; key: SigningKeyRef; keyId: string } | null> = new Array(
    packets.length
  ).fill(null);
  const storeKeyIds = new Set<string>();
  for (const entry of store.entries) for (const keyId of entry.keyIds) storeKeyIds.add(keyId.toUpperCase());

  for (const candidate of usable) {
    let results: LibraryVerificationResult[];
    try {
      // In cleartext mode the signature is attached to the message; passing a
      // detached signature object as well would be rejected by the library.
      const verification =
        mode === 'detached' && signature !== undefined
          ? await openpgp.verify({
              message: message as openpgp.Message<string>,
              signature,
              verificationKeys: [candidate.entry.publicKey],
              date: now,
              config: PGP_STRICT_CONFIG,
            })
          : await openpgp.verify({
              message: message as openpgp.CleartextMessage,
              verificationKeys: [candidate.entry.publicKey],
              date: now,
              config: PGP_STRICT_CONFIG,
            });
      results = verification.signatures as unknown as LibraryVerificationResult[];
    } catch {
      // The library could not process this message with a preflighted key.
      // That is abnormal, so the whole verification fails closed.
      return { ...base, ok: false, status: 'invalid_signature', reason: 'library_error' };
    }

    if (results.length !== packets.length) {
      return { ...base, ok: false, status: 'invalid_signature', reason: 'signature_count_mismatch' };
    }

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const keyId = result.keyID && typeof result.keyID.toHex === 'function' ? result.keyID.toHex().toUpperCase() : '';

      let verified = false;
      try {
        await result.verified;
        verified = true;
      } catch {
        // Rejected signature: recorded below as unverified, never as a pass.
        verified = false;
      }
      if (!verified) continue;

      // A verified signature is only acceptable when the key that produced it
      // is permitted by the preflight for this entry (algorithm, expiry,
      // revocation, binding).
      if (!candidate.signingKeys.has(keyId)) continue;

      if (verifiedBy[index] !== null) {
        // Two independent trust anchors produced the same signature: ambiguous.
        return { ...base, ok: false, status: 'invalid_signature', reason: 'ambiguous_signer' };
      }

      const key = candidate.signingKeys.get(keyId) as SigningKeyRef;
      verifiedBy[index] = { entry: candidate.entry, key, keyId };
    }
  }

  for (let index = 0; index < packets.length; index += 1) {
    const verified = verifiedBy[index];
    if (verified !== null) continue;

    const issuer = issuerKeyId(packets[index]);
    if (issuer !== null && exclusions.has(issuer)) {
      const reason = exclusionToReason(exclusions.get(issuer) as KeyExclusionReason);
      const status: PgpStatus = reason === 'signer_algorithm_not_allowed' ? 'disallowed_algorithm' : 'untrusted_signer';
      return { ...base, ok: false, status, reason };
    }
    if (issuer !== null && storeKeyIds.has(issuer)) {
      // A key from our store was tried and the signature did not hold.
      return { ...base, ok: false, status: 'invalid_signature', reason: 'signature_digest_mismatch' };
    }
    return { ...base, ok: false, status: 'untrusted_signer', reason: 'issuer_not_in_store' };
  }

  const signers: PgpSignerRecord[] = verifiedBy.map((verified, index) => {
    const record = verified as { entry: TrustStoreEntry; key: SigningKeyRef; keyId: string };
    return {
      signature_index: index,
      fingerprint: record.entry.fingerprint,
      key_id: record.keyId,
      signing_key_fingerprint: record.key.isSubkey ? record.key.fingerprint : null,
      signer_identity: record.entry.signerIdentity,
    };
  });

  if (request.expectedSigner !== undefined) {
    const expected = request.expectedSigner.trim();
    const matched = signers.some((signer) => signer.signer_identity.trim() === expected);
    if (!matched) {
      return { ...base, signers, ok: false, status: 'expected_signer_mismatch', reason: 'expected_signer_mismatch' };
    }
  }

  return { ...base, signers, ok: true, status: 'verified', reason: 'ok' };
}

/**
 * Picks the deterministic representative signer of a successful verification.
 *
 * The representative is the trusted entry with the lexicographically smallest
 * fingerprint, so the audit value never depends on signature packet order.
 */
export function representativeSigner(signers: PgpSignerRecord[]): PgpSignerRecord | null {
  if (signers.length === 0) return null;
  return signers.reduce((best, current) => (current.fingerprint < best.fingerprint ? current : best), signers[0]);
}
