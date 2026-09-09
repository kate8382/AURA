import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

describe('generate-trigger-weights script', () => {
  test('generates config from sample public_cases', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-gen-'));
    const casesDir = path.join(tmp, 'public_cases');
    await fs.mkdir(path.join(casesDir, 'ACCESS'), { recursive: true });
    await fs.mkdir(path.join(casesDir, 'FRAUD'), { recursive: true });

    // create sample cases
    const a = {
      case_id: 'A-1',
      scenarios: [ { name: 's', triggers: ['Urgency / pressure', 'Targeted mass scraping'] } ],
      signal_ids: ['sig-1']
    };
    const b = {
      case_id: 'F-1',
      scenarios: [ { name: 's', triggers: ['targeted mass scraping'] } ],
      signal_ids: []
    };
    await fs.writeFile(path.join(casesDir, 'ACCESS', 'A-1.json'), JSON.stringify(a, null, 2));
    await fs.writeFile(path.join(casesDir, 'FRAUD', 'F-1.json'), JSON.stringify(b, null, 2));

    // run the TS script using ts-node/register, with CASES_DIR pointing to tmp cases
    execSync('node -r ts-node/register scripts/generate-trigger-weights.ts', { env: { ...process.env, CASES_DIR: casesDir } });

    const cfgPath = path.resolve('config', 'trigger-weights.json');
    const raw = await fs.readFile(cfgPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('triggerWeights');
    const tw = parsed.triggerWeights;
    // normalized keys should exist
    expect(tw).toHaveProperty('urgency / pressure');
    expect(tw).toHaveProperty('targeted mass scraping');
    // target mass scraping appears in two cases -> should have >= weight of urgency
    expect(tw['targeted mass scraping']).toBeGreaterThanOrEqual(tw['urgency / pressure']);

    // cleanup: restore original config if backup exists
    const bak = cfgPath + '.bak';
    if (await fs.stat(bak).catch(() => null)) {
      await fs.rename(bak, cfgPath);
    }
    // remove tmp
    await fs.rm(tmp, { recursive: true, force: true });
  });
});
