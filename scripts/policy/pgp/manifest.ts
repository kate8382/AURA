/**
 * Strict, versioned schema validation for `config/trusted-keys/manifest.json`.
 *
 * This module is deliberately free of OpenPGP.js and of filesystem access: it
 * validates *shape* only, so it can be unit-tested in isolation. Filesystem
 * and certificate validation live in `trustStore.ts`.
 *
 * Policy:
 *  - unknown keys are rejected at both the document and the entry level;
 *  - a valid manifest may legitimately contain zero entries (see D-1);
 *  - fingerprints are normalised uppercase hex owned by the operator;
 *  - every rejected manifest fails the whole trust store closed (no entry is
 *    ever silently skipped).
 */
import { MAX_MANIFEST_ENTRIES } from './policy';

/** Status of a trust-store entry; only `active` entries may anchor trust. */
export type ManifestEntryStatus = 'active' | 'disabled';

/** A validated manifest entry (all values normalised, no filesystem access yet). */
export interface ManifestEntry {
  /** Primary-key fingerprint, uppercase hex. */
  fingerprint: string;
  /** Relative file name of the ASCII-armored public key inside the store directory. */
  keyFile: string;
  /** Human-readable identity of the signer. Informational only (D-2). */
  signerIdentity: string;
  /** Informational role labels. Never used for authorization (D-2). */
  roles: string[];
  /** Lifecycle status. */
  status: ManifestEntryStatus;
  /** Manifest validity window start, ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`). */
  validFrom: string;
  /** Manifest validity window end, ISO-8601 UTC, or `null` for "no end". */
  validTo: string | null;
}

/** Result of validating a manifest document. */
export type ManifestValidation =
  | { ok: true; entries: ManifestEntry[] }
  | { ok: false; detail: string };

const TOP_LEVEL_KEYS = new Set(['version', 'keys']);
const ENTRY_KEYS = new Set([
  'fingerprint',
  'key_file',
  'signer_identity',
  'roles',
  'status',
  'valid_from',
  'valid_to',
]);
const REQUIRED_ENTRY_KEYS = ['fingerprint', 'key_file', 'signer_identity', 'status', 'valid_from'];

const FINGERPRINT_RE = /^[0-9A-F]{40}$|^[0-9A-F]{64}$/;
/** File names are single path segments: no separators, no traversal, no hidden files. */
const KEY_FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}\.asc$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ROLE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * Truncates an operator-supplied diagnostic string and strips characters that
 * could confuse logs or audit records. Trust-store content is operator-owned,
 * but the audit surface stays deliberately narrow.
 */
export function sanitizeDetail(value: string, maxLength = 160): string {
  const printable = String(value).replace(/[^A-Za-z0-9._:/ \\-]/g, '?');
  return printable.length > maxLength ? `${printable.slice(0, maxLength)}...` : printable;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  // Round-trip check: rejects impossible calendar values (e.g. month 13) while
  // accepting the exact second-precision format the schema requires.
  return `${parsed.toISOString().slice(0, 19)}Z` === value;
}

/**
 * Validates the raw manifest document.
 *
 * @param raw parsed JSON value of `manifest.json`
 * @returns either the normalised entries or a single diagnostic string
 */
export function validateManifest(raw: unknown): ManifestValidation {
  if (!isPlainObject(raw)) return { ok: false, detail: 'manifest must be a JSON object' };

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) return { ok: false, detail: `unknown top-level field: ${sanitizeDetail(key, 40)}` };
  }
  if (raw.version !== 1) return { ok: false, detail: 'manifest version must be the number 1' };
  if (!Array.isArray(raw.keys)) return { ok: false, detail: 'manifest keys must be an array' };
  if (raw.keys.length > MAX_MANIFEST_ENTRIES) {
    return { ok: false, detail: `manifest has more than ${MAX_MANIFEST_ENTRIES} entries` };
  }

  const entries: ManifestEntry[] = [];
  const seenFingerprints = new Set<string>();
  const seenKeyFiles = new Set<string>();

  for (let index = 0; index < raw.keys.length; index += 1) {
    const candidate = raw.keys[index];
    const label = `entry ${index}`;
    if (!isPlainObject(candidate)) return { ok: false, detail: `${label}: must be a JSON object` };

    for (const key of Object.keys(candidate)) {
      if (!ENTRY_KEYS.has(key)) return { ok: false, detail: `${label}: unknown field: ${sanitizeDetail(key, 40)}` };
    }
    for (const key of REQUIRED_ENTRY_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(candidate, key)) {
        return { ok: false, detail: `${label}: missing required field: ${key}` };
      }
    }

    const fingerprint = candidate.fingerprint;
    if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint)) {
      return { ok: false, detail: `${label}: fingerprint must be uppercase hex (40 or 64 characters)` };
    }
    if (seenFingerprints.has(fingerprint)) {
      return { ok: false, detail: `${label}: duplicate fingerprint: ${fingerprint}` };
    }
    seenFingerprints.add(fingerprint);

    const keyFile = candidate.key_file;
    if (typeof keyFile !== 'string' || !KEY_FILE_RE.test(keyFile) || keyFile.includes('..')) {
      return { ok: false, detail: `${label}: key_file must be a plain relative "*.asc" file name` };
    }
    if (seenKeyFiles.has(keyFile)) {
      return { ok: false, detail: `${label}: duplicate key_file: ${keyFile}` };
    }
    seenKeyFiles.add(keyFile);

    const signerIdentity = candidate.signer_identity;
    if (
      typeof signerIdentity !== 'string' ||
      signerIdentity.trim().length === 0 ||
      signerIdentity.length > 320 ||
      CONTROL_CHARS_RE.test(signerIdentity)
    ) {
      return { ok: false, detail: `${label}: signer_identity must be a non-empty single-line string (<= 320 chars)` };
    }

    const status = candidate.status;
    if (status !== 'active' && status !== 'disabled') {
      return { ok: false, detail: `${label}: status must be "active" or "disabled"` };
    }

    const rawRoles = candidate.roles;
    const roles: string[] = [];
    if (rawRoles !== undefined) {
      if (!Array.isArray(rawRoles) || rawRoles.length > 8) {
        return { ok: false, detail: `${label}: roles must be an array of at most 8 labels` };
      }
      for (const role of rawRoles) {
        if (typeof role !== 'string' || !ROLE_RE.test(role)) {
          return { ok: false, detail: `${label}: role labels must match [a-z0-9-]` };
        }
        roles.push(role);
      }
    }

    const validFrom = candidate.valid_from;
    if (!isIsoUtc(validFrom)) {
      return { ok: false, detail: `${label}: valid_from must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SSZ)` };
    }

    const rawValidTo = Object.prototype.hasOwnProperty.call(candidate, 'valid_to') ? candidate.valid_to : null;
    if (rawValidTo !== null && !isIsoUtc(rawValidTo)) {
      return { ok: false, detail: `${label}: valid_to must be null or an ISO-8601 UTC timestamp` };
    }
    const validTo = rawValidTo === null ? null : rawValidTo;
    if (validTo !== null && Date.parse(validTo) <= Date.parse(validFrom)) {
      return { ok: false, detail: `${label}: valid_to must be later than valid_from` };
    }

    entries.push({
      fingerprint,
      keyFile,
      signerIdentity,
      roles,
      status,
      validFrom,
      validTo,
    });
  }

  return { ok: true, entries };
}

/**
 * Verifies that a single certificate exposes no duplicate Key ID.
 *
 * Key IDs are the only identifier OpenPGP.js reports for a verified signature,
 * so a certificate that maps two different keys to one Key ID would make key
 * resolution ambiguous. Such certificates are rejected outright.
 *
 * @returns `null` when unique, otherwise the duplicated Key ID
 */
export function findDuplicateKeyId(keyIds: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const keyId of keyIds) {
    const normalised = String(keyId).toUpperCase();
    if (seen.has(normalised)) return normalised;
    seen.add(normalised);
  }
  return null;
}
