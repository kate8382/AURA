import { runCrossCheck, CrossCheckRequirement } from '../policy/crossCheckAdapter';

describe('CrossCheckAdapter system', () => {
  test('hackerone adapter accepts numeric ID', async () => {
    const req: CrossCheckRequirement = {
      type: 'hackerone',
      value: '12345',
    };
    const res = await runCrossCheck(req);
    expect(res.ok).toBeTruthy();
  });

  test('pgp adapter fails when library missing', async () => {
    const req: CrossCheckRequirement = {
      type: 'pgp-verify',
      value: 'nonexistent.sig',
      metadata: { publicKeyPath: 'key.asc', originalFilePath: 'file.txt' },
    };
    const res = await runCrossCheck(req);
    expect(res.ok).toBeFalsy();
    expect(res.notes).toContain('openpgp library not available');
  });

  test('pdf-signature adapter fails on non‑PDF', async () => {
    const req: CrossCheckRequirement = {
      type: 'pdf-signature',
      value: 'README.md',
    };
    const res = await runCrossCheck(req);
    expect(res.ok).toBeFalsy();
    expect(res.notes).toContain('Error reading PDF file');
  });
});
