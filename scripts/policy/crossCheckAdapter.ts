/**
 * Cross‑Check Adapter System
 *
 * This module defines the `CrossCheckAdapter` interface and provides a
 * registry for all available adapters.  Each adapter implements a
 * `check` method that receives a `CrossCheckRequirement` and returns a
 * `CrossCheckResult`.  The registry is used by the policy engine to
 * dynamically dispatch to the correct adapter based on the `type`
 * field of the requirement.
 *
 * The adapters in this repository are intentionally lightweight and
 * avoid heavy external dependencies.  For more complex integrations
 * (e.g. HTTP calls to external APIs) the adapter can be extended
 * with optional dependencies.
 */

export interface CrossCheckRequirement {
  /** The type of check to perform (e.g. "hackerone", "pdf-signature") */
  type: string;
  /** The value to validate – usually a URL, ID, or file path */
  value: string;
  /** Optional metadata that may be needed by the adapter */
  metadata?: Record<string, unknown>;
}

export interface CrossCheckResult {
  /** Whether the check succeeded */
  ok: boolean;
  /** Human‑readable notes or error messages */
  notes?: string[];
  /** Optional audit information that can be stored in `cross_check_audit` */
  audit?: Record<string, unknown>;
}

export interface CrossCheckAdapter {
  /** Human readable name of the adapter */
  name: string;
  /** Perform the check and return a promise of the result */
  check(req: CrossCheckRequirement): Promise<CrossCheckResult>;
}

/**
 * Registry of adapters.  New adapters should be added to this map.
 */
const adapters: Record<string, CrossCheckAdapter> = {};

/**
 * Register a new adapter.
 */
export function registerAdapter(adapter: CrossCheckAdapter): void {
  adapters[adapter.name] = adapter;
}

/**
 * Retrieve an adapter by name.  Throws if the adapter is not found.
 */
export function getAdapter(name: string): CrossCheckAdapter {
  const adapter = adapters[name];
  if (!adapter) {
    throw new Error(`CrossCheckAdapter '${name}' not registered`);
  }
  return adapter;
}

/**
 * Run a cross‑check requirement using the appropriate adapter.
 */
export async function runCrossCheck(
  req: CrossCheckRequirement
): Promise<CrossCheckResult> {
  const adapter = getAdapter(req.type);
  return adapter.check(req);
}

/**
 * Default export for convenience.
 */
export default {
  registerAdapter,
  getAdapter,
  runCrossCheck,
  CrossCheckRequirement,
  CrossCheckResult,
  CrossCheckAdapter,
};
