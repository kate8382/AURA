import fs from 'fs';
import path from 'path';

export type CrossCheckRequirement = {
  id: string;
  title: string;
  description?: string;
  type: 'boolean' | 'enum' | 'number' | 'string' | 'datetime';
  required?: boolean;
  severity?: 'hard' | 'soft' | 'info';
  options?: string[];
  threshold?: { operator: string; value: number };
  evidence_weight?: number;
  enforcement?: { actionOnFail?: 'veto' | 'require_manual_review' | 'mark_pending' };
};

export type CrossCheckRunResult = {
  id: string;
  verifier: string;
  result: any;
  ok: boolean;
  weight_applied: number;
  ts: string;
  notes?: string;
};

export type EvaluationSummary = {
  auditEntries: CrossCheckRunResult[];
  total_weight: number;
  failed_requirements: string[];
  decisionHints: { veto: boolean; require_manual_review: boolean; pending: boolean };
};


// ── pgp-verify helpers ──────────────────────────────────────────────────
// Pull a field out of a case across the likely shapes — top-level, meta, or
// nested requirement parameters — so the adapter is forgiving about where the
// signed message / signature lands. An empty `params` must not shadow a
// populated `requirement_parameters`.
const ROUTING_ONLY_KEYS = new Set(['domain', 'category', 'type', 'id']);
function extractField(caseObj: any, keys: string[]): string {
  if (!caseObj || typeof caseObj !== 'object') return '';
  const wanted = keys.filter(k => !ROUTING_ONLY_KEYS.has(k));
  const sources = [
    caseObj,
    (caseObj as any).meta,
    (caseObj as any).params,
    (caseObj as any).requirement_parameters,
  ];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const k of wanted) {
      const v = (src as any)[k];
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
  }
  return '';
}

// Static trusted-key allow-list — loaded once per process from the reviewed
// config/trusted-keys/ dir + manifest.json. Zero-trust: keys are committed
// explicitly, never fetched. Resolved relative to this module (not cwd).
let _trustedKeysCache: any[] | null = null;
function loadTrustedKeys(): any[] {
  if (_trustedKeysCache !== null) return _trustedKeysCache as any[];
  const base = path.resolve(__dirname, '..', '..', 'config', 'trusted-keys');
  const out: any[] = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
    for (const k of (manifest.keys || [])) {
      try {
        const armored = fs.readFileSync(path.join(base, String(k.file || '')), 'utf8');
        out.push({ ...k, armored });
      } catch { /* skip unreadable key files */ }
    }
  } catch { /* manifest missing/malformed */ }
  if (out.length) _trustedKeysCache = out;
  return out;  // not permanently cached on failure — a later call retries
}

// openpgp is a peer dep — require lazily so the module loads even where it
// isn't installed.
let _openpgp: any = null;
function getOpenPGP(): any {
  if (_openpgp) return _openpgp;
  try { _openpgp = require('openpgp'); } catch { _openpgp = null; }
  return _openpgp;
}

function isCleartext(sig: string): boolean {
  return /BEGIN PGP SIGNED MESSAGE/.test(sig);
}

function fingerprintOf(hexKeyId: string): string {
  return String(hexKeyId || '').replace(/\s+/g, '').toUpperCase();
}

// Cryptographically verify a detached or cleartext PGP signature against the
// trusted allow-list. Fails closed on unknown keys, expired keys, and forged
// or corrupted signatures.
async function verifyPGP(message: string, signature: string, trusted: any[]): Promise<{ result: any; ok: boolean; notes: string }> {
  const op = getOpenPGP();
  if (!op) return { result: null, ok: false, notes: 'openpgp unavailable — cannot verify' };
  try {
    let sigObj: any, msgText = message;
    if (isCleartext(signature)) {
      sigObj = await op.readCleartextMessage({ cleartextMessage: signature });
      msgText = sigObj.getText();
    } else {
      sigObj = await op.readSignature({ armoredSignature: signature });
    }
    const pubkeys: any[] = [];
    for (const k of trusted) {
      try {
        const pk = await op.readKey({ armoredKey: k.armored });
        pubkeys.push({ pk, meta: k });
      } catch { /* skip unparseable keys */ }
    }
    if (!pubkeys.length) return { result: null, ok: false, notes: 'no usable trusted keys' };
    // Identify the signing key from the signature packets first, so an
    // untrusted signer is reported as untrusted — not conflated with forged.
    let signerKeyIds: string[] = [];
    try {
      const ids = (sigObj.getSigningKeyIDs && sigObj.getSigningKeyIDs()) || [];
      signerKeyIds = ids.map((id: any) => fingerprintOf(id.toHex ? id.toHex() : id));
    } catch { /* no signing-key-id readable */ }
    const signerEntry = pubkeys.find((p: any) => {
      const fp = fingerprintOf((p.pk.getFingerprint && p.pk.getFingerprint()) || p.meta.fingerprint || '');
      return signerKeyIds.some((id: string) => fp === id || fp.endsWith(id) || id.endsWith(fp));
    });
    if (signerKeyIds.length && !signerEntry) {
      return { result: { key_id: signerKeyIds[0] }, ok: false, notes: `signature key '${signerKeyIds[0]}' is not in the trusted allow-list` };
    }
    if (signerEntry) {
      try {
        const exp = await signerEntry.pk.getExpirationTime();
        if (exp && exp instanceof Date && exp.getTime() < Date.now()) {
          return { result: { key_id: signerKeyIds[0] || '', fingerprint: fingerprintOf(signerEntry.pk.getFingerprint()) }, ok: false, notes: `trusted signer key expired (${exp.toISOString().slice(0,10)})` };
        }
      } catch { /* no expiry info — treated as non-expiring */ }
    }
    const verifyArgs: any = {
      message: isCleartext(signature) ? sigObj : await op.createMessage({ text: msgText }),
      verificationKeys: pubkeys.map((p: any) => p.pk),
    };
    if (!isCleartext(signature)) verifyArgs.signature = sigObj;
    const verification = await op.verify(verifyArgs);
    const sigs = (verification && verification.signatures) ? verification.signatures : [];
    if (!sigs.length) return { result: null, ok: false, notes: 'no verifiable signatures on the message' };
    for (const s of sigs) {
      try {
        const valid = await s.verified;
        if (valid && signerEntry) {
          return {
            result: {
              key_id: signerKeyIds[0] || '',
              fingerprint: fingerprintOf(signerEntry.pk.getFingerprint()),
              signer_identity: signerEntry.meta.signer_identity || '',
              verification_status: 'verified',
            },
            ok: true,
            notes: `signature verified — trusted signer ${signerEntry.meta.signer_identity || signerKeyIds[0]}`,
          };
        }
        if (valid && !signerEntry) {
          return { result: null, ok: false, notes: 'signature verified cryptographically but the signing key is not in the trusted allow-list' };
        }
      } catch { /* this sub-sig failed to evaluate */ }
    }
    return { result: { key_id: signerKeyIds[0] || null }, ok: false, notes: 'signature failed cryptographic verification (forged or corrupted)' };
  } catch (err) {
    const msg = (err as any && (err as any).message) ? (err as any).message : String(err);
    return { result: null, ok: false, notes: `verification failed: ${msg}` };
  }
}

// Minimal class-based adapter manager. Adapters can be registered via
// `registerAdapter(name, fn)` where fn(req, caseObj) => Promise<{result, ok, notes}>.
/**
 * CrossCheckAdapter
 * Класс-менеджер адаптеров для выполнения машинно-читаемых cross-check требований.
 * Методы:
 * - registerAdapter(name, fn): регистрирует адаптер (fn возвращает Promise<{result, ok, notes}>)
 * - validateRequirementSchema(req): базовая валидация объекта требования
 * - runAdaptersForCase(caseObj, requirements, adaptersConfig): запускает адаптеры и возвращает массив аудита
 * - evaluateCrossChecks(caseObj, requirements, adaptersConfig): сводит результаты, считает `total_weight` и `decisionHints`
 *
 * По умолчанию регистрируется адаптер `noop`, чтобы поведение было обратносовместимым при отсутствии конфигурации.
 */
export class CrossCheckAdapter {
  private adapters: Map<string, Function> = new Map();

  constructor() {
    // register noop adapter by default
    this.registerAdapter('noop', async (_req: CrossCheckRequirement, _caseObj: any) => ({ result: null, ok: false, notes: 'noop' }));
    // register simple mock adapters useful for testing and initial integration
    this.registerAdapter('ip-geolocate', async (req: CrossCheckRequirement, caseObj: any) => {
      // Support both quick mocks (caseObj.mock_ip_geo) and structured meta.ip_country matching
      const quickOk = !!(caseObj && (caseObj as any).mock_ip_geo === true);
      if (quickOk) return { result: true, ok: true, notes: 'ip geolocation matched (mock quick)' };
      const ipCountry = caseObj && caseObj.meta && caseObj.meta.ip_country ? String(caseObj.meta.ip_country) : null;
      const expected = req && Array.isArray(req.options) && req.options.length ? String(req.options[0]) : null;
      if (expected && ipCountry && expected.toLowerCase() === ipCountry.toLowerCase()) return { result: ipCountry, ok: true, notes: 'ip matched (meta)' };
      return { result: ipCountry, ok: false, notes: 'ip mismatch or missing' };
    });

    // register an email verification adapter supporting quick mock and meta field
    this.registerAdapter('email-verify', async (_req: CrossCheckRequirement, caseObj: any) => {
      const quickOk = !!(caseObj && (caseObj as any).mock_email_verified === true);
      if (quickOk) return { result: true, ok: true, notes: 'email verified (mock quick)' };
      const verified = caseObj && caseObj.meta && !!caseObj.meta.email_verified;
      return { result: !!verified, ok: !!verified, notes: verified ? 'email verified (meta)' : 'email unverified' };
    });
    // register the PGP-verification adapter — cryptographically verifies a
    // detached or cleartext signature against the STATIC trusted-key allow-list
    // in config/trusted-keys/. Zero-trust: no TOFU, no keyserver fetches —
    // only reviewed, committed keys. Fails closed on unknown/forged/expired.
    this.registerAdapter('pgp-verify', async (_req: CrossCheckRequirement, caseObj: any) => {
      // 'signed_message' etc. are explicit — bare 'message' is excluded because
      // a case's top-level message field is the case description, not the
      // signed text.
      const message = extractField(caseObj, ['signed_message', 'signed_text', 'message_text', 'plaintext', 'signed_body']);
      const signature = extractField(caseObj, ['signature', 'detached_signature', 'pgp_signature', 'sig']);
      if (!message) return { result: null, ok: false, notes: 'no signed message supplied' };
      if (!signature) return { result: null, ok: false, notes: 'no signature supplied' };
      const trusted = loadTrustedKeys();
      if (!trusted.length) return { result: null, ok: false, notes: 'trusted-key allow-list unavailable or empty' };
      try {
        const res = await verifyPGP(message, signature, trusted);
        return res;
      } catch (err) {
        const msg = (err as any && (err as any).message) ? (err as any).message : String(err);
        return { result: null, ok: false, notes: `verification error: ${msg}` };
      }
    });
  }

  // Register a new adapter function by name. The function should accept a requirement and a case object, and return a Promise resolving to {result, ok, notes}.
  registerAdapter(name: string, fn: Function) {
    this.adapters.set(name, fn);
  }

  // Validate the schema of a cross-check requirement object. Throws an error if the requirement is invalid.
  validateRequirementSchema(req: any) {
    if (!req || typeof req !== 'object') throw new Error('requirement must be object');
    if (!req.id || !req.title || !req.type) throw new Error('requirement missing id/title/type');
  }

  // Run all registered adapters for a given case and set of requirements. Returns an array of audit results.
  async runAdaptersForCase(caseObj: any, requirements: CrossCheckRequirement[], adaptersConfig?: any): Promise<CrossCheckRunResult[]> {
    const out: CrossCheckRunResult[] = [];
    for (const r of requirements) {
      try {
        this.validateRequirementSchema(r);
      } catch (err) {
        const msg = (err as any && (err as any).message) ? (err as any).message : String(err);
        out.push({ id: r.id || '<no-id>', verifier: 'system', result: null, ok: false, weight_applied: 0, ts: new Date().toISOString(), notes: msg });
        continue;
      }
      // choose adapter by convention: adaptersConfig may map requirement id to adapter name
      const adapterName = adaptersConfig && adaptersConfig[r.id] ? String(adaptersConfig[r.id]) : 'noop';
      const adapterFn = this.adapters.get(adapterName) || this.adapters.get('noop');
      let res: any = { result: null, ok: false, notes: 'no adapter' };
      try {
        res = await (adapterFn as any)(r, caseObj);
      } catch (err) {
        const msg = (err as any && (err as any).message) ? (err as any).message : String(err);
        res = { result: null, ok: false, notes: msg };
      }
      const weight = (typeof r.evidence_weight === 'number' && res.ok) ? Number(r.evidence_weight) : 0;
      out.push({ id: r.id, verifier: `adapter:${adapterName}`, result: res.result, ok: !!res.ok, weight_applied: weight, ts: new Date().toISOString(), notes: res.notes });
    }
    return out;
  }

  // Evaluate the cross-checks for a given case. Returns a summary including total weight, failed requirements, and decision hints.
  async evaluateCrossChecks(caseObj: any, requirements: CrossCheckRequirement[], adaptersConfig?: any): Promise<EvaluationSummary> {
    const auditEntries = await this.runAdaptersForCase(caseObj, requirements || [], adaptersConfig);
    let total = 0;
    const failed: string[] = [];
    const hints = { veto: false, require_manual_review: false, pending: false };
    for (let i = 0; i < auditEntries.length; i++) {
      const a = auditEntries[i];
      total += (typeof a.weight_applied === 'number') ? a.weight_applied : 0;
      if (!a.ok) failed.push(a.id);
    }
    // derive hints from requirements enforcement if failures exist
    for (const r of requirements || []) {
      if (!r.enforcement) continue;
      if (!r.required && (!r.evidence_weight || r.evidence_weight === 0)) continue;
      const found = auditEntries.find(x => x.id === r.id);
      if (found && !found.ok) {
        const a = r.enforcement.actionOnFail;
        if (a === 'veto') hints.veto = true;
        if (a === 'require_manual_review') hints.require_manual_review = true;
        if (a === 'mark_pending') hints.pending = true;
      }
    }
    return { auditEntries, total_weight: Math.round(total * 100) / 100, failed_requirements: failed, decisionHints: hints };
  }
}

// Export default instance for quick use
const defaultAdapter = new CrossCheckAdapter();
export default defaultAdapter;
