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

// ── bounty-scope helpers ──────────────────────────────────────────────────
// Cached offline snapshot — loaded once per process from the curated JSON.
let _bountySnapshotCache: any[] | null = null;
function loadBountySnapshot(): any[] {
  if (_bountySnapshotCache !== null) return _bountySnapshotCache as any[];
  try {
    const p = path.resolve(process.cwd(), 'config', 'snapshots', 'bounty-programs.json');
    const raw = fs.readFileSync(p, 'utf8');
    const d = JSON.parse(raw);
    _bountySnapshotCache = Array.isArray(d && d.programs) ? d.programs : (Array.isArray(d) ? d : []);
  } catch {
    _bountySnapshotCache = [];
  }
  return _bountySnapshotCache as any[];
}

// Pull a field out of a case across the likely shapes — top-level, meta, or
// nested requirement parameters — so the adapter is forgiving about where the
// program-id / target lands.
function extractField(caseObj: any, keys: string[]): string {
  if (!caseObj || typeof caseObj !== 'object') return '';
  for (const k of keys) {
    const v = (caseObj as any)[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  const meta = (caseObj as any).meta;
  if (meta && typeof meta === 'object') {
    for (const k of keys) {
      const v = meta[k];
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
  }
  const params = (caseObj as any).params || (caseObj as any).requirement_parameters;
  if (params && typeof params === 'object') {
    for (const k of keys) {
      const v = params[k];
      if (v !== undefined && v !== null && v !== '') return String(v);
    }
  }
  return '';
}

// Whether a target domain/IP falls inside a scope entry — exact, wildcard
// (*.example.com covers subdomains + the apex), or CIDR for IPs.
function domainInScope(target: string, scope: string): boolean {
  const t = String(target || '').trim().toLowerCase();
  const s = String(scope || '').trim().toLowerCase();
  if (!t || !s) return false;
  // CIDR
  if (s.includes('/')) {
    return cidrMatch(t, s);
  }
  // wildcard
  if (s.startsWith('*.')) {
    const apex = s.slice(2);
    return t === apex || t.endsWith('.' + apex);
  }
  // exact or suffix-anchored subdomain
  return t === s || t.endsWith('.' + s);
}

// Minimal IPv4 CIDR containment — '10.0.0.0/8' covers '10.1.2.3'.
function cidrMatch(ip: string, cidr: string): boolean {
  try {
    const [base, bitsStr] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    if (isNaN(bits) || bits < 0 || bits > 32) return false;
    const toInt = (a: string) => a.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
    const ipInt = toInt(ip);
    const baseInt = toInt(base);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (baseInt & mask);
  } catch {
    return false;
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

    // register the offline bounty-scope adapter — verifies a case-claimed bug
    // bounty program + target domain/IP against the curated offline snapshot in
    // config/snapshots/bounty-programs.json. Works 100% offline.
    this.registerAdapter('bounty-scope', async (_req: CrossCheckRequirement, caseObj: any) => {
      const quickOk = !!(caseObj && (caseObj as any).mock_bounty_scope === true);
      if (quickOk) return { result: true, ok: true, notes: 'bounty scope matched (mock quick)' };
      const programId = extractField(caseObj, ['bounty_program_id', 'program_id', 'bounty_program', 'program']);
      const target = extractField(caseObj, ['target_domain', 'target', 'domain', 'target_ip', 'host']);
      const snapshot = loadBountySnapshot();
      if (!snapshot.length) return { result: null, ok: false, notes: 'bounty snapshot unavailable or empty' };
      const program = snapshot.find((p: any) =>
        String(p.program_id || '').toLowerCase() === String(programId || '').toLowerCase() ||
        String(p.platform || '').toLowerCase() === String(programId || '').toLowerCase()
      );
      if (!program) return { result: { program_id: programId }, ok: false, notes: `program '${programId}' not found in offline bounty snapshot` };
      const status = String(program.status || '').toLowerCase();
      if (status !== 'active') return { result: { program_id: programId, status }, ok: false, notes: `program '${programId}' is not active (status: ${status})` };
      if (target) {
        const scopes = Array.isArray(program.in_scope_domains) ? program.in_scope_domains : [];
        const inScope = scopes.some((s: string) => domainInScope(target, String(s)));
        if (!inScope) return { result: { program_id: programId, target }, ok: false, notes: `target '${target}' out of scope for program '${programId}'` };
      }
      return { result: { program_id: program.program_id, platform: program.platform, target }, ok: true, notes: `program '${program.program_id}' active${target ? ' and target in scope' : ''}` };
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
