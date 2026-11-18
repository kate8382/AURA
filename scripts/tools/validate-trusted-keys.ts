/**
 * Policy-as-code validation for the trusted PGP keys in `config/trusted-keys/`.
 *
 * Structure is delegated to the `pgp-verify` trust-store loader, which already
 * enforces: manifest schema, ASCII-armored public key parsing, fingerprint
 * equality with the manifest, manifest <-> directory synchronisation and the
 * RSA >= 3072 minimum. This module adds the policy checks the loader defers
 * (D-3): key expiry, the maximum validity window, the approved curve list and
 * the hash algorithms of certificate signatures.
 */
import * as openpgp from 'openpgp';

import { checkKeyAlgorithmPolicy, checkSignaturePacketPolicy } from '../policy/pgp/policy';
import { loadTrustStore } from '../policy/pgp/trustStore';
import type { TrustStoreErrorCode } from '../policy/pgp/types';

/** Maximum validity window, measured from the key's creation time. */
export const MAX_KEY_VALIDITY_YEARS = 2;

/** Signature types used by certificates: user-ID certifications, subkey and primary-key binding, direct key. */
const CERTIFICATE_SIGNATURE_TYPES: ReadonlySet<number> = new Set<number>([0x10, 0x11, 0x12, 0x13, 0x18, 0x19, 0x1f]);

export type KeyPolicyCode =
  | 'expiration_unknown'
  | 'no_expiration'
  | 'expired'
  | 'validity_window_exceeded'
  | 'rsa_key_too_small'
  | 'curve_not_approved'
  | 'disallowed_public_key_algorithm'
  | 'disallowed_curve'
  | 'disallowed_hash_algorithm'
  | 'unsupported_signature_type';

export interface KeyPolicyViolation {
  code: KeyPolicyCode;
  /** Which key inside the certificate the violation refers to. */
  subject: string;
  detail: string;
}

export interface TrustedKeysViolation {
  /** Manifest key file, or `store` for store-level (loader) failures. */
  file: string;
  subject: string;
  code: KeyPolicyCode | TrustStoreErrorCode;
  detail: string;
}

export interface TrustedKeysValidationResult {
  ok: boolean;
  entriesChecked: number;
  violations: TrustedKeysViolation[];
}

/**
 * Approved algorithms: RSA >= 3072 bits, ECDSA on NIST P-256/P-384, and Ed25519.
 *
 * @returns `null` when approved, otherwise the violation code
 */
function checkApprovedAlgorithm(key: openpgp.Key | openpgp.Subkey): KeyPolicyCode | null {
  const { algorithm, curve } = key.getAlgorithmInfo();
  // Encryption subkeys of Ed25519 / P-256 / P-384 certificates use ECDH on the matching curve.
  if (algorithm === 'ecdh') {
    return curve === 'curve25519Legacy' || curve === 'nistP256' || curve === 'nistP384' || curve === 'nistP521'
      ? null
      : 'curve_not_approved';
  }

  const baseViolation = checkKeyAlgorithmPolicy(key);
  if (baseViolation !== null) return baseViolation;

  if (algorithm === 'rsaEncryptSign' || algorithm === 'rsaSign') return null;
  if (algorithm === 'ecdsa' && (curve === 'nistP256' || curve === 'nistP384' || curve === 'nistP521')) return null;
  if (algorithm === 'ed25519' || (algorithm === 'eddsaLegacy' && curve === 'ed25519Legacy')) return null;
  return 'curve_not_approved';
}

/** Returns the latest expiry that still satisfies the maximum validity window. */
function latestAllowedExpiry(created: Date): Date {
  const limit = new Date(created.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + MAX_KEY_VALIDITY_YEARS);
  return limit;
}

async function checkValidity(
  key: openpgp.Key | openpgp.Subkey,
  subject: string,
  now: Date
): Promise<KeyPolicyViolation[]> {
  const expires = await key.getExpirationTime();
  if (expires === null) {
    return [{ code: 'expiration_unknown', subject, detail: 'expiration time cannot be determined' }];
  }
  if (!(expires instanceof Date)) {
    return [{ code: 'no_expiration', subject, detail: 'key has no expiration; a validity window is required' }];
  }
  if (expires.getTime() <= now.getTime()) {
    return [{ code: 'expired', subject, detail: `key expired at ${expires.toISOString()}` }];
  }
  if (expires.getTime() > latestAllowedExpiry(key.getCreationTime()).getTime()) {
    return [
      {
        code: 'validity_window_exceeded',
        subject,
        detail: `key validity exceeds ${MAX_KEY_VALIDITY_YEARS} years from creation`,
      },
    ];
  }
  return [];
}

function checkCertificateSignatures(key: openpgp.Key): KeyPolicyViolation[] {
  const violations: KeyPolicyViolation[] = [];
  const signatures: Array<{ subject: string; packet: openpgp.SignaturePacket }> = [];
  for (const user of key.users) {
    for (const packet of user.selfCertifications) signatures.push({ subject: 'primary key', packet });
  }
  for (const subkey of key.subkeys) {
    const subject = `subkey ${subkey.getKeyID().toHex().toUpperCase()}`;
    for (const packet of subkey.bindingSignatures) signatures.push({ subject, packet });
  }

  for (const { subject, packet } of signatures) {
    const code = checkSignaturePacketPolicy(packet, CERTIFICATE_SIGNATURE_TYPES);
    if (code !== null) violations.push({ code, subject, detail: 'certificate signature uses a disallowed parameter' });
  }
  return violations;
}

/**
 * Checks one parsed certificate (primary key and every subkey) against the
 * project policy. Every violation is collected rather than stopping at the first.
 *
 * @param now evaluation time used for the expiry checks
 */
export async function checkCertificatePolicy(key: openpgp.Key, now: Date = new Date()): Promise<KeyPolicyViolation[]> {
  const violations: KeyPolicyViolation[] = [];

  const primaryAlgorithm = checkApprovedAlgorithm(key);
  if (primaryAlgorithm !== null) {
    violations.push({ code: primaryAlgorithm, subject: 'primary key', detail: 'algorithm or curve is not approved' });
  }
  violations.push(...(await checkValidity(key, 'primary key', now)));

  for (const subkey of key.getSubkeys()) {
    const subject = `subkey ${subkey.getKeyID().toHex().toUpperCase()}`;
    const algorithm = checkApprovedAlgorithm(subkey);
    if (algorithm !== null) {
      violations.push({ code: algorithm, subject, detail: 'algorithm or curve is not approved' });
    }
    violations.push(...(await checkValidity(subkey, subject, now)));
  }

  violations.push(...checkCertificateSignatures(key));
  return violations;
}

/**
 * Validates the whole trust store: structure via the loader, then policy for
 * every referenced certificate.
 *
 * @param options.dir explicit store directory (defaults to `config/trusted-keys/`)
 * @param options.now evaluation time (defaults to the current time)
 */
export async function validateTrustedKeys(
  options: { dir?: string; now?: Date } = {}
): Promise<TrustedKeysValidationResult> {
  const loaded = await loadTrustStore({ dir: options.dir });
  if (!loaded.ok) {
    return {
      ok: false,
      entriesChecked: 0,
      violations: [{ file: 'store', subject: 'store', code: loaded.code, detail: loaded.detail }],
    };
  }

  const now = options.now ?? new Date();
  const violations: TrustedKeysViolation[] = [];
  for (const entry of loaded.store.entries) {
    for (const violation of await checkCertificatePolicy(entry.publicKey, now)) {
      violations.push({ ...violation, file: entry.keyFile });
    }
  }

  return { ok: violations.length === 0, entriesChecked: loaded.store.entries.length, violations };
}

async function main(): Promise<void> {
  const result = await validateTrustedKeys();
  if (!result.ok) {
    for (const violation of result.violations) {
      console.error(`[ERROR] ${violation.file} (${violation.subject}): ${violation.code} - ${violation.detail}`);
    }
    console.error(`[ERROR] trusted-key validation failed violations=${result.violations.length}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[INFO] trusted-key validation passed entries=${result.entriesChecked}`);
}

if (require.main === module) {
  main().catch(() => {
    console.error('[ERROR] unexpected error during trusted-key validation');
    process.exitCode = 1;
  });
}
