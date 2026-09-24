import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { NormalizePerCases } from '../normalize-percases';

// Synthetic fixture texts with deterministic extraction behavior.
const THESIS_TEXT =
  'I need help with my graduation thesis on traffic grids before the hard deadline.';
const DEADLINE_TEXT = 'We have a hard deadline and must finish right now.';
const NEUTRAL_TEXT = 'I love baking sourdough bread on weekends with my family.';

const ORIG_ARGV = process.argv.slice();

function setArgv(...flags: string[]): void {
  process.argv = ['node', 'normalize-percases.ts', ...flags];
}

async function makeTmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'aura-extract-'));
}

async function writeCase(dir: string, name: string, data: unknown): Promise<string> {
  const p = path.join(dir, name);
  await fsp.writeFile(p, JSON.stringify(data, null, 2), 'utf8');
  return p;
}

function singleCase(scenarios: unknown[]): unknown {
  return { case_id: 'T-EXTRACT-1', domain: 'access', category: 'test', scenarios };
}

describe('normalize-percases --extract-triggers', () => {
  let tmp = '';
  let logs: string[] = [];
  let spy: jest.SpyInstance | null = null;

  beforeEach(async () => {
    tmp = await makeTmpDir();
    logs = [];
    spy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
  });

  afterEach(async () => {
    process.argv = ORIG_ARGV.slice();
    if (spy) spy.mockRestore();
    spy = null;
    if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
    tmp = '';
  });

  test('missing triggers: adds extracted triggers', async () => {
    const file = await writeCase(
      tmp,
      'T-1.json',
      singleCase([{ name: 's0', text: THESIS_TEXT }])
    );
    setArgv(tmp, '--extract-triggers');
    await new NormalizePerCases(false).run(tmp);
    const out = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(out.scenarios[0].triggers).toContain('academic & student alibi');
    expect(out.scenarios[0].triggers).toContain('urgency / pressure');
  });

  test('empty triggers: populates only when candidates are found', async () => {
    const file = await writeCase(
      tmp,
      'T-1.json',
      singleCase([
        { name: 's0', text: THESIS_TEXT, triggers: [] },
        { name: 's1', text: NEUTRAL_TEXT, triggers: [] },
      ])
    );
    setArgv(tmp, '--extract-triggers');
    await new NormalizePerCases(false).run(tmp);
    const out = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(out.scenarios[0].triggers.length).toBeGreaterThan(0);
    expect(out.scenarios[1].triggers).toEqual([]);
  });

  test('missing triggers with no candidates: does not manufacture an empty list', async () => {
    const file = await writeCase(tmp, 'T-1.json', singleCase([{ name: 's0', text: NEUTRAL_TEXT }]));
    setArgv(tmp, '--extract-triggers');
    await new NormalizePerCases(false).run(tmp);
    const out = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect('triggers' in out.scenarios[0]).toBe(false);
  });

  test('existing triggers are preserved exactly and candidates appended', async () => {
    const file = await writeCase(
      tmp,
      'T-1.json',
      singleCase([{ name: 's0', text: THESIS_TEXT, triggers: ['Existing Manual Trigger'] }])
    );
    setArgv(tmp, '--extract-triggers');
    await new NormalizePerCases(false).run(tmp);
    const out = JSON.parse(await fsp.readFile(file, 'utf8'));
    const triggers = out.scenarios[0].triggers as string[];
    expect(triggers[0]).toBe('Existing Manual Trigger');
    expect(triggers).toContain('academic & student alibi');
    expect(triggers.indexOf('Existing Manual Trigger')).toBe(0);
  });

  test('deduplication: existing equivalent trigger blocks re-adding', async () => {
    const file = await writeCase(
      tmp,
      'T-1.json',
      singleCase([{ name: 's0', text: DEADLINE_TEXT, triggers: ['Urgency / Pressure'] }])
    );
    setArgv(tmp, '--extract-triggers');
    await new NormalizePerCases(false).run(tmp);
    const out = JSON.parse(await fsp.readFile(file, 'utf8'));
    // Original spelling preserved, no duplicate appended.
    expect(out.scenarios[0].triggers).toEqual(['Urgency / Pressure']);
  });

  test('scenario.name is never used as extraction evidence', async () => {
    const file = await writeCase(
      tmp,
      'T-1.json',
      singleCase([{ name: 'Academic & Student Alibi', text: NEUTRAL_TEXT }])
    );
    setArgv(tmp, '--extract-triggers');
    await new NormalizePerCases(false).run(tmp);
    const out = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect('triggers' in out.scenarios[0]).toBe(false);
  });

  test('dry-run previews additions and writes nothing', async () => {
    const file = await writeCase(
      tmp,
      'T-1.json',
      singleCase([{ name: 's0', text: THESIS_TEXT }])
    );
    const before = await fsp.readFile(file, 'utf8');
    const beforeList = fs.readdirSync(tmp).sort();
    setArgv(tmp, '--extract-triggers', '--dry-run');
    await new NormalizePerCases(true).run(tmp);
    const preview = logs.join('\n');
    expect(preview).toMatch(/\[dry\] WOULD ADD triggers T-EXTRACT-1 scenario 0:/);
    expect(preview).toMatch(/academic & student alibi/);
    expect(preview).toMatch(/urgency \/ pressure/);
    // Nothing written, nothing created.
    expect(await fsp.readFile(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(tmp).sort()).toEqual(beforeList);
  });

  test('dry-run reports no fake addition when nothing is found', async () => {
    await writeCase(tmp, 'T-1.json', singleCase([{ name: 's0', text: NEUTRAL_TEXT }]));
    setArgv(tmp, '--extract-triggers', '--dry-run');
    await new NormalizePerCases(true).run(tmp);
    expect(logs.join('\n')).not.toMatch(/WOULD ADD triggers/);
  });

  test('idempotency: second run adds no duplicates or changes', async () => {
    const file = await writeCase(
      tmp,
      'T-1.json',
      singleCase([{ name: 's0', text: THESIS_TEXT }])
    );
    setArgv(tmp, '--extract-triggers');
    await new NormalizePerCases(false).run(tmp);
    const first = JSON.parse(await fsp.readFile(file, 'utf8'));
    await new NormalizePerCases(false).run(tmp);
    const second = JSON.parse(await fsp.readFile(file, 'utf8'));
    // Extraction is idempotent: identical trigger lists, no duplicates.
    // (Byte equality is not asserted: the pre-existing normalizer backfills
    // `confidence_raw` on a second pass, which is unrelated to Issue #8.)
    expect(second.scenarios[0].triggers).toEqual(first.scenarios[0].triggers);
    const triggers = second.scenarios[0].triggers as string[];
    expect(triggers.length).toBeGreaterThan(0);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  test('composition: --extract-triggers --apply-signal-ids derives signal IDs from extracted triggers', async () => {
    const file = await writeCase(
      tmp,
      'T-1.json',
      singleCase([{ name: 's0', text: THESIS_TEXT }])
    );
    setArgv(tmp, '--extract-triggers', '--apply-signal-ids');
    await new NormalizePerCases(false).run(tmp);
    const out = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(out.scenarios[0].triggers).toContain('academic & student alibi');
    expect(Array.isArray(out.signal_ids)).toBe(true);
    expect(out.signal_ids).toContain('alibi:academic');
  });

  test('without --extract-triggers behavior is unchanged (no triggers added)', async () => {
    const file = await writeCase(
      tmp,
      'T-1.json',
      singleCase([{ name: 's0', text: THESIS_TEXT }])
    );
    setArgv(tmp);
    await new NormalizePerCases(false).run(tmp);
    const out = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect('triggers' in out.scenarios[0]).toBe(false);
  });

  test('multi-case files: extraction applies in the split branch', async () => {
    await writeCase(tmp, 'WRAP.json', {
      MANIPULATION: [
        { case_id: 'M-T-1', domain: 'manipulation', category: 'test', scenarios: [{ name: 's0', text: THESIS_TEXT }] },
        { case_id: 'M-T-2', domain: 'manipulation', category: 'test', scenarios: [{ name: 's0', text: NEUTRAL_TEXT }] },
      ],
    });
    setArgv(tmp, '--extract-triggers');
    await new NormalizePerCases(false).run(tmp);
    // Original removed, split files written.
    expect(fs.existsSync(path.join(tmp, 'WRAP.json'))).toBe(false);
    const first = JSON.parse(await fsp.readFile(path.join(tmp, 'WRAP-1.json'), 'utf8'));
    const second = JSON.parse(await fsp.readFile(path.join(tmp, 'WRAP-2.json'), 'utf8'));
    expect(first.case_id).toBe('M-T-1');
    expect(first.scenarios[0].triggers).toContain('academic & student alibi');
    expect('triggers' in second.scenarios[0]).toBe(false);
  });

  test('multi-case dry-run previews and writes nothing', async () => {
    await writeCase(tmp, 'WRAP.json', {
      MANIPULATION: [
        { case_id: 'M-T-1', domain: 'manipulation', category: 'test', scenarios: [{ name: 's0', text: THESIS_TEXT }] },
      ],
    });
    // Single case inside a wrapper still exercises the wrapper path; use two cases for split branch.
    await writeCase(tmp, 'WRAP2.json', {
      MANIPULATION: [
        { case_id: 'M-T-1', domain: 'manipulation', category: 'test', scenarios: [{ name: 's0', text: THESIS_TEXT }] },
        { case_id: 'M-T-2', domain: 'manipulation', category: 'test', scenarios: [{ name: 's0', text: THESIS_TEXT }] },
      ],
    });
    const beforeList = fs.readdirSync(tmp).sort();
    const beforeWrap2 = await fsp.readFile(path.join(tmp, 'WRAP2.json'), 'utf8');
    setArgv(tmp, '--extract-triggers', '--dry-run');
    await new NormalizePerCases(true).run(tmp);
    const preview = logs.join('\n');
    expect(preview).toMatch(/\[dry\] WOULD ADD triggers M-T-1 scenario 0:/);
    expect(preview).toMatch(/\[dry\] WOULD ADD triggers M-T-2 scenario 0:/);
    expect(fs.readdirSync(tmp).sort()).toEqual(beforeList);
    expect(await fsp.readFile(path.join(tmp, 'WRAP2.json'), 'utf8')).toBe(beforeWrap2);
  });
});
