import fs from 'fs';
import path from 'path';

import { loadTriggerConfig } from '../config';

describe('loadTriggerConfig', () => {
  const cfgPath = path.resolve(__dirname, '..', '..', 'config', 'trigger-weights.json');
  it('loads values from config file', () => {
    const cfg = loadTriggerConfig();
    expect(cfg).toBeDefined();
    // file contains actionable payload with 0.05 in repo
    expect(typeof cfg.triggerWeights['actionable payload']).toBe('number');
    expect(cfg.defaultTriggerWeight).toBeGreaterThanOrEqual(0);
    expect(typeof cfg.maxBoost).toBe('number');
  });

  it('applies ENV overrides for MAX_BOOST and TRIGGER_WEIGHTS', () => {
    const oldMax = process.env.MAX_BOOST;
    const oldTW = process.env.TRIGGER_WEIGHTS;
    try {
      process.env.MAX_BOOST = '0.42';
      process.env.TRIGGER_WEIGHTS = JSON.stringify({ 'foo': 0.123 });
      const cfg = loadTriggerConfig();
      expect(cfg.maxBoost).toBeCloseTo(0.42);
      expect(cfg.triggerWeights.foo).toBeCloseTo(0.123);
    } finally {
      if (oldMax === undefined) delete process.env.MAX_BOOST; else process.env.MAX_BOOST = oldMax;
      if (oldTW === undefined) delete process.env.TRIGGER_WEIGHTS; else process.env.TRIGGER_WEIGHTS = oldTW;
    }
  });
});
