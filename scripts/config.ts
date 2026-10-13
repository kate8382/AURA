import fs from 'fs';
import path from 'path';
import { logWarn } from './logger';

export interface TriggerConfig {
  // Whether to write cross-check audit entries back into case files on disk
  writeCrossCheckAudit?: boolean;
  // Optional adapter configuration for cross-check adapters
  crossCheckAdapters?: any;
  // Normalization alpha used by recalc (optional)
  normAlpha?: number | undefined;
  // Per-trigger weights
  triggerWeights: { [k: string]: number };
  defaultTriggerWeight: number;
  crossCheckWeight: number;
  signalIdWeight: number;
  maxBoost: number;
}
// Minimal fallback if config file is missing; prefer canonical JSON file in repo as single source-of-truth.
const FALLBACK_CONFIG: TriggerConfig = {
  triggerWeights: {},
  defaultTriggerWeight: 0.01,
  crossCheckWeight: 0.005,
  signalIdWeight: 0.01,
  maxBoost: 0.10,
  normAlpha: undefined,
  crossCheckAdapters: undefined,
  writeCrossCheckAudit: true
};

export function loadTriggerConfig(): TriggerConfig {
  const cfg: TriggerConfig = { ...FALLBACK_CONFIG };
  const cfgPath = path.resolve(__dirname, '..', 'config', 'trigger-weights.json');
  if (!fs.existsSync(cfgPath)) {
    logWarn('trigger weights config not found, using built-in defaults', { file: cfgPath });
  } else {
    let parsed: any;
    try {
      parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (err) {
      throw new Error(`cannot read trigger weights config ${cfgPath}: ${err instanceof Error ? err.message : err}`);
    }
    if (parsed && typeof parsed === 'object') {
      if (parsed.triggerWeights && typeof parsed.triggerWeights === 'object') cfg.triggerWeights = parsed.triggerWeights;
      if (typeof parsed.defaultTriggerWeight === 'number') cfg.defaultTriggerWeight = parsed.defaultTriggerWeight;
      if (typeof parsed.crossCheckWeight === 'number') cfg.crossCheckWeight = parsed.crossCheckWeight;
      if (typeof parsed.signalIdWeight === 'number') cfg.signalIdWeight = parsed.signalIdWeight;
      if (typeof parsed.maxBoost === 'number') cfg.maxBoost = parsed.maxBoost;
      if (typeof parsed.normAlpha === 'number') cfg.normAlpha = parsed.normAlpha;
      if (typeof parsed.crossCheckAdapters !== 'undefined') cfg.crossCheckAdapters = parsed.crossCheckAdapters;
      if (typeof parsed.writeCrossCheckAudit === 'boolean') cfg.writeCrossCheckAudit = parsed.writeCrossCheckAudit;
    }
  }

  // ENV overrides (explicit)
  if (process.env.MAX_BOOST) {
    const v = Number(process.env.MAX_BOOST);
    if (!Number.isNaN(v)) cfg.maxBoost = v;
  }
  if (process.env.TRIGGER_WEIGHTS) {
    let tw: any;
    try {
      tw = JSON.parse(process.env.TRIGGER_WEIGHTS);
    } catch (err) {
      throw new Error(`TRIGGER_WEIGHTS is not valid JSON: ${err instanceof Error ? err.message : err}`);
    }
    if (tw && typeof tw === 'object') cfg.triggerWeights = tw;
  }
  return cfg;
}

export default loadTriggerConfig;

export function loadPolicyConfig() {
  const p = path.resolve(__dirname, '..', 'config', 'policy.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read policy config ${p}: ${err instanceof Error ? err.message : err}`);
  }
}
