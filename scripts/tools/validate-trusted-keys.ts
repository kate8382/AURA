/**
 * CI validation for the PGP trusted-key allow-list (issue #89).
 *
 * Because adapter:pgp-verify (#88) is closed-world against config/trusted-keys/,
 * any PR touching that directory must be vetted: a malformed, expired, or
 * cryptographically weak key (RSA-1024, SHA-1, DSA) would compromise the whole
 * cross-check gate. This script fails CI (exit 1) on any violation.
 *
 * Checks per key-file, and manifest↔file synchronization.
 */
import fs from 'fs';
import path from 'path';
import * as openpgp from 'openpgp';

const KEYS_DIR = process.env.AURA_TRUSTED_KEYS_DIR
  ? path.resolve(process.env.AURA_TRUSTED_KEYS_DIR)
  : path.join(process.cwd(), 'config', 'trusted-keys');
const MANIFEST = path.join(KEYS_DIR, 'manifest.json');

// Minimum acceptable algorithm strength — reject legacy/weak primitives.
const WEAK_ALGORITHMS = new Set(['rsa1024', 'dsa', 'elgamal', 'sha1']);
const MIN_RSA_BITS = 2048;

const errors: string[] = [];
const notes: string[] = [];

function fail(msg: string) { errors.push(msg); }
function note(msg: string) { notes.push(msg); }

async function validateKeyFile(file: string, declaredFingerprint?: string) {
  const fp = path.join(KEYS_DIR, file);
  if (!fs.existsSync(fp)) { fail(`manifest references ${file} but the file is missing`); return; }
  const armored = fs.readFileSync(fp, 'utf8');
  // Format: must be a real ASCII-armored public-key block.
  if (!armored.includes('BEGIN PGP PUBLIC KEY BLOCK')) {
    fail(`${file}: not a valid ASCII-armored PGP public key block`); return;
  }
  let key;
  try {
    key = await openpgp.readKey({ armoredKey: armored });
  } catch (e: any) {
    fail(`${file}: unparseable key — ${e?.message ?? e}`); return;
  }
  // Fingerprint must match the manifest's declared value.
  const actual = key.getFingerprint().toLowerCase();
  if (declaredFingerprint && actual !== declaredFingerprint.toLowerCase()) {
    fail(`${file}: fingerprint ${actual} does not match manifest ${declaredFingerprint}`);
  }
  // Expiration: must not be expired (or set to expire imminently — < 30d).
  const expiry = await key.getExpirationTime().catch(() => null);
  if (expiry instanceof Date) {
    const daysLeft = (expiry.getTime() - Date.now()) / 86400000;
    if (daysLeft < 0) fail(`${file}: key expired ${expiry.toISOString().slice(0, 10)}`);
    else if (daysLeft < 30) note(`${file}: key expires in ${Math.round(daysLeft)} days — rotate soon`);
  }
  // Algorithm strength.
  const algo = key.getAlgorithmInfo();
  const name = String(algo?.algorithm ?? '').toLowerCase();
  const bits = (algo as any)?.bits ?? 0;
  if (WEAK_ALGORITHMS.has(name) || name.includes('rsa') && bits < MIN_RSA_BITS) {
    fail(`${file}: weak algorithm ${name}${bits ? ` ${bits}bit` : ''} — below policy (min RSA-${MIN_RSA_BITS}, no ${[...WEAK_ALGORITHMS].join('/')})`);
  }
  note(`${file}: ${name}${bits ? ` ${bits}bit` : ''} fingerprint ${actual.slice(-16)} OK`);
}

async function main() {
  if (!fs.existsSync(MANIFEST)) { fail('manifest.json missing'); report(); return; }
  let manifest: { keys?: any[] } = {};
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); }
  catch (e: any) { fail(`manifest.json unparseable — ${e?.message ?? e}`); report(); return; }

  const declared = new Map<string, string>();
  for (const k of manifest.keys ?? []) {
    if (!k.key_file || !k.fingerprint) { fail(`manifest entry missing key_file/fingerprint: ${JSON.stringify(k)}`); continue; }
    declared.set(k.key_file, k.fingerprint);
  }
  // Every manifest entry's file must exist + validate.
  for (const [file, fp] of declared) await validateKeyFile(file, fp);
  // Every .asc on disk must be declared (no orphan keys slipping in).
  const onDisk = fs.readdirSync(KEYS_DIR).filter((f) => f.endsWith('.asc'));
  for (const f of onDisk) {
    if (!declared.has(f)) fail(`${f}: present on disk but NOT declared in manifest.json — add it or remove it`);
  }
  report();
}

function report() {
  for (const n of notes) console.log(`  ok ${n}`);
  if (errors.length) {
    console.error(`\ntrusted-keys validation FAILED (${errors.length}):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log(`trusted-keys validation passed (${notes.length} key(s) checked)`);
}

main().catch((e) => { console.error('validator crashed:', e); process.exit(1); });
