/**
 * Regression test: regenerating trigger weights must never drop the
 * hand-maintained cross-check adapter routing (`crossCheckAdapters`) or the
 * `writeCrossCheckAudit` flag. Dropping them would silently route every
 * `pgp-verify` requirement back to the `noop` adapter.
 *
 * The generator is pointed at a temporary repository root, so the real
 * `config/trigger-weights.json` is never rewritten by this test.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import GenerateTriggerWeights from '../generate-trigger-weights';

describe('generate-trigger-weights preserves adapter routing', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-gen-preserve-'));
    fs.mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'synthetic_cases', 'ACCESS'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'synthetic_cases', 'ACCESS', 'case-1.json'),
      JSON.stringify(
        {
          case_id: 'ACCESS-1',
          scenarios: [{ name: 's', triggers: ['urgency / pressure'] }],
        },
        null,
        2
      )
    );
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  test('keeps crossCheckAdapters and writeCrossCheckAudit after a rewrite', () => {
    const configPath = path.join(repoRoot, 'config', 'trigger-weights.json');
    const routing = { 'cc-pgp-signature': 'pgp-verify', 'cc-ip': 'ip-geolocate' };
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          triggerWeights: { 'urgency / pressure': 0.02 },
          defaultTriggerWeight: 0.01,
          crossCheckWeight: 0.005,
          signalIdWeight: 0.01,
          maxBoost: 0.1,
          normAlpha: 0.3,
          crossCheckAdapters: routing,
          writeCrossCheckAudit: false,
        },
        null,
        2
      )
    );

    new GenerateTriggerWeights(repoRoot).run([]);

    const regenerated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(regenerated.crossCheckAdapters).toEqual(routing);
    expect(regenerated.writeCrossCheckAudit).toBe(false);
    expect(regenerated.triggerWeights).toBeDefined();
    expect(regenerated.weightMethod).toBe('tfidf-tiered');
  });

  test('does not invent routing keys when the existing config has none', () => {
    const configPath = path.join(repoRoot, 'config', 'trigger-weights.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ triggerWeights: { 'urgency / pressure': 0.02 }, crossCheckWeight: 0.005 }, null, 2)
    );

    new GenerateTriggerWeights(repoRoot).run([]);

    const regenerated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(regenerated.crossCheckAdapters).toBeUndefined();
    expect(regenerated.writeCrossCheckAudit).toBeUndefined();
  });

  test('the repository config routes cc-pgp-signature to the pgp-verify adapter', () => {
    const realConfig = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'config', 'trigger-weights.json'), 'utf8')
    );
    expect(realConfig.crossCheckAdapters).toEqual({ 'cc-pgp-signature': 'pgp-verify' });
  });
});
