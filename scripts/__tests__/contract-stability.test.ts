import fs from 'fs';
import path from 'path';
import Ajv from 'ajv';
import { generateSignalHash, canonicalize } from '../tools/generate-signal-hash';
import { getImpliedActions } from '../tools/signal-action-consumer';

describe('contract-stability', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');

  test('decision-vocabulary.json is valid', () => {
    const vocabPath = path.join(repoRoot, 'config', 'decision-vocabulary.json');
    const schemaPath = path.join(repoRoot, 'schemas', 'decision-vocabulary-schema.json');

    const vocab = JSON.parse(fs.readFileSync(vocabPath, 'utf8'));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    const ajv = new Ajv();
    const validate = ajv.compile(schema);
    const valid = validate(vocab);

    expect(valid).toBe(true);
    expect(vocab.version).toBe('1.0.0');
    expect(vocab.severities).toHaveLength(3);
    expect(vocab.severities[0].value).toBe('allow');
    expect(vocab.severities[1].value).toBe('review');
    expect(vocab.severities[2].value).toBe('block');
    expect(vocab.workflow_states).toHaveLength(1);
    expect(vocab.workflow_states[0].value).toBe('pending');
  });

  test('signal schema accepts implied_action arrays and keeps missing action optional', () => {
    const mappingPath = path.join(repoRoot, 'config', 'signal-mapping.json');
    const schemaPath = path.join(repoRoot, 'schemas', 'signal-mapping-schema.json');

    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    const ajv = new Ajv();
    const validate = ajv.compile(schema);

    const withAction = mapping.signals['recon:targeted'];
    const withoutAction = { id: 'sample:safe', description: 'signal without action metadata', triggers: ['safe phrase'] };

    expect(validate(mapping)).toBe(true);
    expect(Array.isArray(withAction.implied_action)).toBe(true);
    expect(withAction.implied_action).toEqual(['egress:outbound']);
    expect(validate({ signals: { 'sample:safe': withoutAction } })).toBe(true);
  });

  test('getImpliedActions reads and filters action classes', () => {
    const actions = getImpliedActions('exploit:actionable', ['execute:command', 'egress:outbound', 'access:privilege']);
    const filtered = getImpliedActions('exploit:actionable', ['access:privilege']);
    const missing = getImpliedActions('signal:missing', ['execute:command']);

    expect(actions).toEqual(['execute:command', 'egress:outbound']);
    expect(filtered).toEqual([]);
    expect(missing).toEqual([]);
  });

  test('signal-mapping.json SHA-256 hash is deterministic', () => {
    const mappingPath = path.join(repoRoot, 'config', 'signal-mapping.json');
    const res1 = generateSignalHash(mappingPath);
    const res2 = generateSignalHash(mappingPath);

    expect(res1.sha256).toBe(res2.sha256);
    expect(res1.signalCount).toBeGreaterThan(0);
    expect(res1.signalCount).toBe(Object.keys(JSON.parse(fs.readFileSync(mappingPath, 'utf8')).signals).length);
  });

  test('canonicalize produces sorted keys', () => {
    const obj1 = { b: 1, a: { d: 2, c: 3 } };
    const obj2 = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalize(obj1)).toBe(canonicalize(obj2));
    expect(canonicalize(obj1)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});
