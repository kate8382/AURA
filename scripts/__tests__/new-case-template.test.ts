import { NewCaseTemplate } from '../new-case-template';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

test('createTemplate returns required keys and types', () => {
  const tpl = new NewCaseTemplate().createTemplate('TEST-1');
  expect(tpl).toHaveProperty('case_id', 'TEST-1');
  expect(typeof tpl.category).toBe('string');
  expect(Array.isArray(tpl.scenarios)).toBe(true);
  expect(typeof tpl.confidence).toBe('number');
  expect(tpl.legal_risk).toBeDefined();
  expect(tpl.behavioral_patterns).toBeDefined();
  expect(tpl.cross_check).toBeDefined();
  expect(tpl.deception_threshold).toBeDefined();
});

test('writeTemplate writes into matching subfolder by initial letter', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
  const outDir = path.join(tmp, 'synthetic_cases');
  await fs.mkdir(path.join(outDir, 'MANIPULATION'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'ACCESS'), { recursive: true });

  const T = new NewCaseTemplate();
  const caseId = 'TEST-2';
  await T.writeTemplate(outDir, caseId, false, 'M');

  const expected = path.join(outDir, 'MANIPULATION', `${caseId}.json`);
  const stat = await fs.stat(expected);
  expect(stat.isFile()).toBe(true);

  // cleanup
  await fs.rm(tmp, { recursive: true, force: true });
});

test('writeTemplate dry-run does not create file', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
  const outDir = path.join(tmp, 'synthetic_cases');
  await fs.mkdir(path.join(outDir, 'FRAUD'), { recursive: true });

  const T = new NewCaseTemplate();
  const caseId = 'TEST-3';
  await T.writeTemplate(outDir, caseId, true, 'F');

  const expected = path.join(outDir, 'FRAUD', `${caseId}.json`);
  await expect(fs.stat(expected)).rejects.toThrow();

  await fs.rm(tmp, { recursive: true, force: true });
});

test('writeTemplate injects letter into case_id when id not provided', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
  const outDir = path.join(tmp, 'synthetic_cases');
  await fs.mkdir(path.join(outDir, 'ACCESS'), { recursive: true });

  const T = new NewCaseTemplate();
  await T.writeTemplate(outDir, undefined, false, 'A', 0);

  const expected = path.join(outDir, 'ACCESS', `SC-A-000.json`);
  const stat = await fs.stat(expected);
  expect(stat.isFile()).toBe(true);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('createTemplate defaults to SC- prefix and real kind uses RC-', () => {
  const T = new NewCaseTemplate();
  expect(T.createTemplate().case_id).toBe('SC-X-000');
  expect(T.createTemplate(undefined, 'real').case_id).toBe('RC-X-000');
});

test('writeTemplate with real kind writes RC- ids and auto-numbers by that prefix', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
  const outDir = path.join(tmp, 'real_cases');
  const mdir = path.join(outDir, 'M');
  await fs.mkdir(mdir, { recursive: true });
  await fs.writeFile(path.join(mdir, 'RC-M-001.json'), '{}');
  await fs.writeFile(path.join(mdir, 'SC-M-009.json'), '{}');

  const T = new NewCaseTemplate();
  await T.writeTemplate(outDir, undefined, false, 'M', undefined, true, 'real');

  const stat = await fs.stat(path.join(mdir, 'RC-M-002.json'));
  expect(stat.isFile()).toBe(true);
  const written = JSON.parse(await fs.readFile(path.join(mdir, 'RC-M-002.json'), 'utf8'));
  expect(written.case_id).toBe('RC-M-002');

  await fs.rm(tmp, { recursive: true, force: true });
});

test('auto numbering picks next sequence and creates folder if missing', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
  const outDir = path.join(tmp, 'synthetic_cases');
  // create a folder with existing sequences for M
  const mdir = path.join(outDir, 'M');
  await fs.mkdir(mdir, { recursive: true });
  await fs.writeFile(path.join(mdir, 'SC-M-001.json'), '{}');
  await fs.writeFile(path.join(mdir, 'SC-M-002.json'), '{}');

  const T = new NewCaseTemplate();
  await T.writeTemplate(outDir, undefined, false, 'M', undefined, true);

  const expected = path.join(mdir, `SC-M-003.json`);
  const stat = await fs.stat(expected);
  expect(stat.isFile()).toBe(true);

  await fs.rm(tmp, { recursive: true, force: true });
});

test('manual numbering uses provided number and creates letter folder', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aura-test-'));
  const outDir = path.join(tmp, 'synthetic_cases');

  const T = new NewCaseTemplate();
  await T.writeTemplate(outDir, undefined, false, 'Z', 42, false);

  const expectedDir = path.join(outDir, 'Z');
  const expected = path.join(expectedDir, `SC-Z-042.json`);
  const stat = await fs.stat(expected);
  expect(stat.isFile()).toBe(true);

  await fs.rm(tmp, { recursive: true, force: true });
});
