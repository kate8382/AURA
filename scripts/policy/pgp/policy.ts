/**
 * Application-level cryptographic policy for the `pgp-verify` adapter.
 *
 * OpenPGP.js is configured below with an explicit, fail-closed configuration,
 * but its defaults are NOT trusted on their own: every key packet and every
 * signature packet is re-checked here against positive allow-lists. This is a
 * deliberate defence-in-depth requirement, because the library's defaults are
 * permissive (default `minRSABits` is 2047 and SHA-1 is accepted).
 */
import * as openpgp from 'openpgp';

/** Maximum accepted size of a detached-mode `signed_message` payload. */
export const MAX_SIGNED_MESSAGE_BYTES = 256 * 1024;
/** Maximum accepted size of a `detached_signature` payload. */
export const MAX_DETACHED_SIGNATURE_BYTES = 64 * 1024;
/** Maximum accepted size of a `cleartext_message` payload. */
export const MAX_CLEARTEXT_MESSAGE_BYTES = 256 * 1024;
/** Maximum accepted length of `expected_signer`. */
export const MAX_EXPECTED_SIGNER_CHARS = 320;
/** Maximum accepted size of `config/trusted-keys/manifest.json`. */
export const MAX_MANIFEST_BYTES = 256 * 1024;
/** Maximum number of manifest entries in the trust store. */
export const MAX_MANIFEST_ENTRIES = 64;
/** Maximum accepted size of a single ASCII-armored public key file. */
export const MAX_KEY_FILE_BYTES = 64 * 1024;

/** Minimum accepted RSA modulus size (bits). */
export const MIN_RSA_BITS = 3072;

/**
 * Positive allow-list of asymmetric algorithms that may be used for signing.
 *
 * rsaEncryptSign (1), rsaSign (3), ecdsa (19), eddsaLegacy (22), ed25519 (27).
 * Everything else - DSA, ElGamal, ECDH, X25519/X448, Ed448, AES-based (v6)
 * algorithms - is rejected even if the library would accept it.
 */
export const ALLOWED_SIGNING_ALGORITHMS: ReadonlySet<openpgp.enums.publicKeyNames> = new Set<
  openpgp.enums.publicKeyNames
>(['rsaEncryptSign', 'rsaSign', 'ecdsa', 'eddsaLegacy', 'ed25519']);

/** Positive allow-list of elliptic curves: NIST P-256/P-384/P-521 and Ed25519. */
export const ALLOWED_CURVES: ReadonlySet<string> = new Set<string>([
  'nistP256',
  'nistP384',
  'nistP521',
  'ed25519Legacy',
]);

/**
 * Positive allow-list of hash algorithms: SHA-224/256/384/512 only.
 * SHA-1, MD5, RIPEMD and SHA-3 variants are rejected.
 */
export const ALLOWED_HASH_ALGORITHMS: ReadonlySet<number> = new Set<number>([
  openpgp.enums.hash.sha224,
  openpgp.enums.hash.sha256,
  openpgp.enums.hash.sha384,
  openpgp.enums.hash.sha512,
]);

/**
 * Signature packet types accepted in detached mode: binary (0x00) and
 * canonical text (0x01). Both are genuine document signatures.
 */
export const ALLOWED_DETACHED_SIGNATURE_TYPES: ReadonlySet<number> = new Set<number>([
  openpgp.enums.signature.binary,
  openpgp.enums.signature.text,
]);

/**
 * Signature packet types accepted in cleartext mode: canonical text (0x01)
 * only. A cleartext signed message is defined as a canonical-text signature.
 */
export const ALLOWED_CLEARTEXT_SIGNATURE_TYPES: ReadonlySet<number> = new Set<number>([
  openpgp.enums.signature.text,
]);

/**
 * Fail-closed OpenPGP.js configuration used for every key read and every
 * verification. `ignoreUnsupportedPackets` is enabled by the library by
 * default, which silently drops packets we must inspect ourselves - so it is
 * disabled here explicitly.
 */
export const PGP_STRICT_CONFIG: openpgp.Config = {
  ...openpgp.config,
  minRSABits: MIN_RSA_BITS,
  ignoreMalformedPackets: false,
  ignoreUnsupportedPackets: false,
  allowMissingKeyFlags: false,
  allowInsecureVerificationWithReformattedKeys: false,
  v6Keys: false,
  rejectHashAlgorithms: new Set<openpgp.enums.hash>([
    openpgp.enums.hash.md5,
    openpgp.enums.hash.sha1,
    openpgp.enums.hash.ripemd,
  ]),
  rejectMessageHashAlgorithms: new Set<openpgp.enums.hash>([
    openpgp.enums.hash.md5,
    openpgp.enums.hash.sha1,
    openpgp.enums.hash.ripemd,
  ]),
  rejectPublicKeyAlgorithms: new Set<openpgp.enums.publicKey>([
    openpgp.enums.publicKey.elgamal,
    openpgp.enums.publicKey.dsa,
    openpgp.enums.publicKey.aedh,
    openpgp.enums.publicKey.aedsa,
    openpgp.enums.publicKey.x25519,
    openpgp.enums.publicKey.x448,
    openpgp.enums.publicKey.ed448,
  ]),
  rejectCurves: new Set<openpgp.enums.curve>([
    openpgp.enums.curve.secp256k1,
    openpgp.enums.curve.brainpoolP256r1,
    openpgp.enums.curve.brainpoolP384r1,
    openpgp.enums.curve.brainpoolP512r1,
  ]),
};

/** Minimal structural view of a key-bearing object (Key or Subkey). */
export interface KeyLike {
  getAlgorithmInfo(): openpgp.AlgorithmInfo;
  getCreationTime(): Date;
  getFingerprint(): string;
  getKeyID(): openpgp.KeyID;
}

/**
 * Checks an asymmetric key against the application-level allow-lists.
 *
 * @returns `null` when the key is acceptable, otherwise a stable reason code.
 */
export function checkKeyAlgorithmPolicy(
  key: KeyLike
): 'disallowed_public_key_algorithm' | 'disallowed_curve' | 'rsa_key_too_small' | null {
  const info = key.getAlgorithmInfo();
  if (!ALLOWED_SIGNING_ALGORITHMS.has(info.algorithm)) return 'disallowed_public_key_algorithm';

  if (info.algorithm === 'rsaEncryptSign' || info.algorithm === 'rsaSign') {
    if (typeof info.bits !== 'number' || info.bits < MIN_RSA_BITS) return 'rsa_key_too_small';
  }

  if (typeof info.curve === 'string' && info.curve.length > 0 && !ALLOWED_CURVES.has(info.curve)) {
    return 'disallowed_curve';
  }

  return null;
}

/** Minimal structural view of a signature packet used by the policy check. */
export interface SignaturePacketLike {
  signatureType: number | null;
  hashAlgorithm: number | null;
  publicKeyAlgorithm: number | null;
}

/**
 * Checks one signature packet against the application-level allow-lists.
 *
 * @param packet parsed signature packet (or an equivalent descriptor)
 * @param allowedTypes accepted signature packet types for the current mode
 * @returns `null` when the packet is acceptable, otherwise a stable reason code.
 */
export function checkSignaturePacketPolicy(
  packet: SignaturePacketLike,
  allowedTypes: ReadonlySet<number>
): 'unsupported_signature_type' | 'disallowed_hash_algorithm' | 'disallowed_public_key_algorithm' | null {
  if (typeof packet.signatureType !== 'number' || !allowedTypes.has(packet.signatureType)) {
    return 'unsupported_signature_type';
  }
  if (typeof packet.hashAlgorithm !== 'number' || !ALLOWED_HASH_ALGORITHMS.has(packet.hashAlgorithm)) {
    return 'disallowed_hash_algorithm';
  }
  if (packet.publicKeyAlgorithm === null || packet.publicKeyAlgorithm === undefined) {
    return 'disallowed_public_key_algorithm';
  }
  let algorithmName: openpgp.enums.publicKeyNames;
  try {
    algorithmName = openpgp.enums.read(openpgp.enums.publicKey, packet.publicKeyAlgorithm);
  } catch {
    // Unknown numeric algorithm id: the enum reader rejects it and so do we.
    return 'disallowed_public_key_algorithm';
  }
  if (typeof algorithmName !== 'string' || !ALLOWED_SIGNING_ALGORITHMS.has(algorithmName)) {
    return 'disallowed_public_key_algorithm';
  }
  return null;
}
