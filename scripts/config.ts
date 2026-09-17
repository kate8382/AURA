import fs from 'fs';
import path from 'path';

export interface TriggerConfig {
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
  maxBoost: 0.10
};

export function loadTriggerConfig(): TriggerConfig {
  const cfg: TriggerConfig = { ...FALLBACK_CONFIG };
  try {
    const cfgPath = path.resolve(__dirname, '..', 'config', 'trigger-weights.json');
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.triggerWeights && typeof parsed.triggerWeights === 'object') cfg.triggerWeights = parsed.triggerWeights;
        if (typeof parsed.defaultTriggerWeight === 'number') cfg.defaultTriggerWeight = parsed.defaultTriggerWeight;
        if (typeof parsed.crossCheckWeight === 'number') cfg.crossCheckWeight = parsed.crossCheckWeight;
        if (typeof parsed.signalIdWeight === 'number') cfg.signalIdWeight = parsed.signalIdWeight;
        if (typeof parsed.maxBoost === 'number') cfg.maxBoost = parsed.maxBoost;
      }
    }
  } catch (err) {
    // ignore read/parse errors and fall back
  }

  // ENV overrides (explicit)
  if (process.env.MAX_BOOST) {
    const v = Number(process.env.MAX_BOOST);
    if (!Number.isNaN(v)) cfg.maxBoost = v;
  }
  if (process.env.TRIGGER_WEIGHTS) {
    try {
      const tw = JSON.parse(process.env.TRIGGER_WEIGHTS);
      if (tw && typeof tw === 'object') cfg.triggerWeights = tw;
    } catch (err) {
      // ignore malformed env
    }
  }
  return cfg;
}

export default loadTriggerConfig;

export function loadPolicyConfig() {
  try {
    const p = path.resolve(__dirname, '..', 'config', 'policy.json');
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    // ignore
  }
  return null;
}
