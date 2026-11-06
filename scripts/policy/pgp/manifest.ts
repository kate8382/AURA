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

/** Marker substituted for anything that looks like a filesystem path. */
export const REDACTED_PATH = '<path>';

/**
 * Characters that may never appear in an audit detail; anything else becomes
 * `?`. Quotes and backslashes are deliberately excluded, so a detail can never
 * carry a quoted or Windows-style path verbatim.
 */
const DISALLOWED_DETAIL_CHARS_RE = /[^A-Za-z0-9 ._:<>()\-,=/]/g;

/**
 * Characters that can start a path token inside a diagnostic string.
 * `\x60` is a backtick; written as an escape so the pattern stays readable.
 */
const PATH_DELIMITERS = String.raw`\s"'\x60(\[{=:,;<>?|`;
const PATH_TAIL = String.raw`[^\s"'\x60)\]}<>,;]*`;

/**
 * Path shapes are redacted *before* any character filtering, because filtering
 * transforms delimiters (quotes become `?`) and would otherwise destroy the
 * context the detectors rely on.
 *
 * `UNC_PATH_RE` is not needed: after backslashes are normalised to `/`, a
 * `//server/share` path is matched by `POSIX_ABSOLUTE_PATH_RE`.
 */
const WINDOWS_DRIVE_PATH_RE = new RegExp(
  String.raw`(^|[${PATH_DELIMITERS}])[A-Za-z]:(?:[\\/]${PATH_TAIL})?`,
  'g'
);
const POSIX_ABSOLUTE_PATH_RE = new RegExp(String.raw`(^|[${PATH_DELIMITERS}])\/+${PATH_TAIL}`, 'g');
const TRAVERSAL_PATH_RE = new RegExp(
  String.raw`(^|[${PATH_DELIMITERS}])(?:\.\.?[\\/])+(?:${PATH_TAIL})?`,
  'g'
);

/**
 * Matches `../` sequences that appear *in the middle* of a token
 * (e.g. `foo/../secret`, `config/../../etc/passwd`). `TRAVERSAL_PATH_RE` only
 * anchors at a token boundary, so this second pattern is required to honour
 * the documented guarantee that parent-directory traversal is always removed.
 */
const MID_STRING_TRAVERSAL_RE = /(?:\.\.[\\/])+[^\s]*/g;

/**
 * Catch-all for any path separator that still starts a token: a `/` is only
 * legitimate when it continues an alphanumeric token (e.g. the repo-relative
 * `config/trusted-keys`). This runs after the character filter as a second line
 * of defence and keeps the function idempotent.
 */
const RESIDUAL_ABSOLUTE_PATH_RE = /(^|[^A-Za-z0-9._-])\/+[^\s]*/g;

/**
 * Single-token identifiers that are safe to echo into an audit detail. At least
 * one alphanumeric character is required so that `.`, `..` and other pure
 * punctuation tokens are rejected.
 */
const SAFE_DETAIL_TOKEN_RE = /^(?=.*[A-Za-z0-9])[A-Za-z0-9._-]+$/;

/**
 * Whether a value is a single, harmless identifier (no separators, no spaces,
 * no path characters) and therefore safe to interpolate into a detail.
 */
export function isSafeDetailToken(value: unknown, maxLength = 128): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    SAFE_DETAIL_TOKEN_RE.test(value)
  );
}

/**
 * Applies every path-shape redaction to a string.
 *
 * Called twice in `sanitizeDetail`: once *before* the character filter (so the
 * original delimiters are still intact) and once *after* (so a `?` introduced
 * by the filter can act as a delimiter for a shape the first pass could not
 * see).
 */
function redactPaths(input: string): string {
  let text = input;
  text = text.replace(WINDOWS_DRIVE_PATH_RE, `$1${REDACTED_PATH}`);
  text = text.replace(POSIX_ABSOLUTE_PATH_RE, `$1${REDACTED_PATH}`);
  text = text.replace(TRAVERSAL_PATH_RE, `$1${REDACTED_PATH}`);
  text = text.replace(MID_STRING_TRAVERSAL_RE, REDACTED_PATH);
  return text;
}

/**
 * Turns a diagnostic string into something that is safe to expose in the
 * externally visible `cross_check_audit` record.
 *
 * Guarantees:
 *  - absolute paths (POSIX, Windows drive, UNC) and parent-directory traversal
 *    are replaced with `<path>`, wherever in the string they appear;
 *  - control characters, quotes, backslashes and other confusing characters
 *    are neutralised;
 *  - the result is bounded and single-line, and the transformation is
 *    idempotent for the inputs exercised by the test suite (sanitising twice
 *    yields the same string).
 *
 * Known limitation: a path containing spaces (e.g. `/home/john doe/x`) inside
 * free text cannot be fully delimited, because the boundary between the path
 * and the following prose is not observable. This is acceptable today because
 * raw exception text no longer reaches this function; callers that
 * deliberately pass free-form prose must not rely on this helper alone.
 *
 * This is defence in depth: callers must still never pass raw exception text.
 */
export function sanitizeDetail(value: unknown, maxLength = 160): string {
  let text: string;
  try {
    text = String(value);
  } catch {
    // A value whose `toString` throws (e.g. `Object.create(null)`) must not
    // escape the fail-closed path.
    text = 'unprintable value';
  }
  text = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  text = text.replace(/\\/g, '/'); // Windows / UNC separators -> POSIX form
  text = redactPaths(text);
  text = text.replace(DISALLOWED_DETAIL_CHARS_RE, '?');
  text = redactPaths(text); // `?` is a delimiter now: catch what the filter exposed
  text = text.replace(RESIDUAL_ABSOLUTE_PATH_RE, `$1${REDACTED_PATH}`);
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

/**
 * Renders an untrusted token (for example a JSON field name) for a diagnostic.
 *
 * Only single-token identifiers are echoed; anything else - a path, a quoted
 * string, an empty value - collapses to a fixed placeholder so that an
 * attacker-supplied field name can never smuggle content into the audit.
 */
function describeToken(value: unknown): string {
  return isSafeDetailToken(value, 40) ? String(value) : '<field>';
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
    if (!TOP_LEVEL_KEYS.has(key)) {
      return { ok: false, detail: `unknown top-level field: ${describeToken(key)}` };
    }
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
      if (!ENTRY_KEYS.has(key)) {
        return { ok: false, detail: `${label}: unknown field: ${describeToken(key)}` };
      }
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
