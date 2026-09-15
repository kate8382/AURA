import fs from 'fs';
import path from 'path';
import os from 'os';
import { MigrateCategories } from '../migrate-categories';

describe('MigrateCategories', () => {
  test('adds domain, strips domain prefix from category, removes duplicates, and reorders keys', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-mig-'));
    const casesDir = path.join(tmp, 'public_cases', 'ACCESS');
    fs.mkdirSync(casesDir, { recursive: true });
    const filePath = path.join(casesDir, 'A-TEST.json');

    const payload = {
      case_id: 'A-TEST',
      category: 'access/my_category',
      confidence_raw: 0.5,
      scenarios: [],
    } as any;

    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');

    const migrator = new MigrateCategories(tmp);
    const changed = migrator.migrate();
    expect(changed).toBeGreaterThan(0);

    const out = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // core expectations
    expect(out.case_id).toBe('A-TEST');
    expect(out.domain).toBe('access');
    expect(out.category).toBe('my_category');
    // duplicates removed
    expect(out.category_label).toBeUndefined();
    expect(out.category_slug).toBeUndefined();
    // ordering: first three keys must be case_id, domain, category
    const keys = Object.keys(out);
    expect(keys[0]).toBe('case_id');
    expect(keys[1]).toBe('domain');
    expect(keys[2]).toBe('category');

    // cleanup
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  });
});
