/**
 * adapter:pgp-verify — cryptographic PGP signature verification against a
 * static local allow-list (issue #88).
 *
 * Zero-Trust contract: NEVER Trust-On-First-Use and NEVER fetch keys from a
 * keyserver. A signature is trusted only when the signing key's fingerprint
 * appears in `config/trusted-keys/manifest.json`. Anything else —
 * unknown signer, expired key, corrupted/forged signature — fails closed
 * (ok:false) with an explanatory note rather than throwing.
 */
import fs from 'fs';
import path from 'path';
import * as openpgp from 'openpgp';

const KEYS_DIR = path.join(process.cwd(), 'config', 'trusted-keys');
const MANIFEST = path.join(KEYS_DIR, 'manifest.json');

export type PgpVerifyResult = {
  ok: boolean;
  key_id?: string;
  fingerprint?: string;
  signer_identity?: string;
  role?: string;
  verification_status: 'verified' | 'untrusted_key' | 'expired' | 'bad_signature' | 'error';
  notes?: string;
};

type ManifestEntry = {
  key_file: string;
  fingerprint: string;
  signer_identity: string;
  uid?: string;
  role?: string;
};

function loadManifest(): ManifestEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    return Array.isArray(raw.keys) ? raw.keys : [];
  } catch {
    return [];
  }
}

/** Load a trusted public key by its manifest entry's .asc file. */
async function loadTrustedKey(entry: ManifestEntry): Promise<openpgp.Key | null> {
  try {
    const armored = fs.readFileSync(path.join(KEYS_DIR, entry.key_file), 'utf8');
    return await openpgp.readKey({ armoredKey: armored });
  } catch {
    return null;
  }
}

/** Extract the signing key's fingerprint from a signature packet. */
function sigFingerprint(sigPacket: any): string {
  // openpgp exposes issuerFingerprint (Uint8Array) and issuerKeyID (bytes).
  const fp = sigPacket?.issuerFingerprint;
  if (fp) {
    const bytes = fp.bytes ?? fp; // Uint8Array or wrapper
    return Buffer.from(bytes).toString('hex').toLowerCase();
  }
  const kid = sigPacket?.issuerKeyID;
  if (kid) {
    const bytes = kid.bytes ?? kid;
    return Buffer.from(bytes).toString('hex').toLowerCase();
  }
  return '';
}

/**
 * Verify a signed payload against the static allow-list.
 * `signedText` is the message; `signature` is a detached armored signature or
 * a cleartext signed message. Fails closed on any mismatch.
 */
export async function verifySignature(
  signedText: string,
  signature: string,
): Promise<PgpVerifyResult> {
  if (!signedText || !signature) {
    return { ok: false, verification_status: 'error', notes: 'missing signed text or signature' };
  }

  const manifest = loadManifest();
  if (!manifest.length) {
    return { ok: false, verification_status: 'error', notes: 'trusted-keys manifest missing or empty' };
  }

  try {
    // Detached signature: build the message from the signed text, the sig from
    // the armored block. (Cleartext-signed input can be normalized upstream.)
    const message = await openpgp.createMessage({ text: signedText });
    const sig = await openpgp.readSignature({ armoredSignature: signature });
    const sigPackets = (sig as any).packets ?? [];
    const fp = sigFingerprint(sigPackets[0]);

    // Closed world: the signing key must be in the allow-list.
    const entry = manifest.find(
      (e) => e.fingerprint.toLowerCase() === fp ||
             e.fingerprint.toLowerCase().endsWith(fp) ||
             fp.endsWith(e.fingerprint.toLowerCase()),
    );
    if (!entry) {
      return {
        ok: false,
        verification_status: 'untrusted_key',
        key_id: fp.slice(-16) || undefined,
        notes: `signing key ${fp} is not in the trusted allow-list`,
      };
    }

    const pubKey = await loadTrustedKey(entry);
    if (!pubKey) {
      return { ok: false, verification_status: 'error', key_id: fp.slice(-16), notes: 'trusted key file unreadable' };
    }
    // Expired key fails closed too.
    const expiry = await pubKey.getExpirationTime().catch(() => null);
    if (expiry instanceof Date && expiry.getTime() < Date.now()) {
      return { ok: false, verification_status: 'expired', key_id: fp.slice(-16), fingerprint: entry.fingerprint, signer_identity: entry.signer_identity, notes: 'key expired' };
    }

    const verification = await openpgp.verify({
      message,
      signature: sig,
      verificationKeys: pubKey,
    });
    // openpgp v5: signatures[].verified is itself a Promise<boolean>.
    const verified = await (verification.signatures?.[0]?.verified ?? Promise.resolve(false));
    if (!verified) {
      return {
        ok: false,
        verification_status: 'bad_signature',
        key_id: fp.slice(-16),
        fingerprint: entry.fingerprint,
        signer_identity: entry.signer_identity,
        notes: 'signature does not verify against the trusted key',
      };
    }
    return {
      ok: true,
      verification_status: 'verified',
      key_id: fp.slice(-16),
      fingerprint: entry.fingerprint,
      signer_identity: entry.signer_identity,
      role: entry.role,
      notes: `verified by ${entry.signer_identity}`,
    };
  } catch (err: any) {
    return { ok: false, verification_status: 'error', notes: `verification error: ${err?.message ?? err}` };
  }
}
