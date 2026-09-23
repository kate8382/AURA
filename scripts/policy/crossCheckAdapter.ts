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
    // register a mock IP geolocation adapter
    this.registerAdapter('ip-geolocate', async (req: CrossCheckRequirement, caseObj: any) => {
      // mock behavior: if caseObj has `meta` with `ip_country` that matches expected value in req.options[0], pass
      const ipCountry = caseObj && caseObj.meta && caseObj.meta.ip_country ? String(caseObj.meta.ip_country) : null;
      const expected = req && Array.isArray(req.options) && req.options.length ? String(req.options[0]) : null;
      if (expected && ipCountry && expected.toLowerCase() === ipCountry.toLowerCase()) return { result: ipCountry, ok: true, notes: 'ip matched' };
      return { result: ipCountry, ok: false, notes: 'ip mismatch or missing' };
    });

    // register a mock email-verified adapter
    this.registerAdapter('email-verified', async (_req: CrossCheckRequirement, caseObj: any) => {
      const verified = caseObj && caseObj.meta && !!caseObj.meta.email_verified;
      return { result: !!verified, ok: !!verified, notes: verified ? 'email verified' : 'email unverified' };
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
