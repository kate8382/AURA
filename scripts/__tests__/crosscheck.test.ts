import CrossCheckAdapter from '../policy/crossCheckAdapter';

describe('CrossCheckAdapter basic', () => {
  test('noop adapter returns not-ok and zero weight', async () => {
    const adapter = CrossCheckAdapter;
    const req = { id: 'cc-1', title: 't', type: 'boolean' } as any;
    const res = await adapter.evaluateCrossChecks({}, [req]);
    expect(res.total_weight).toBe(0);
    expect(res.auditEntries.length).toBe(1);
    expect(res.auditEntries[0].ok).toBe(false);
  });

  test('register adapter and apply weight', async () => {
    const adapter = CrossCheckAdapter;
    // use built-in email-verified mock adapter via adaptersConfig map
    const req = { id: 'cc-email-verified', title: 'Email', type: 'boolean', evidence_weight: 0.2 } as any;
    const caseObj = { meta: { email_verified: true } };
    const res = await adapter.evaluateCrossChecks(caseObj, [req], { 'cc-email-verified': 'email-verified' });
    expect(res.auditEntries.length).toBe(1);
    expect(res.total_weight).toBeCloseTo(0.2);
    expect(res.auditEntries[0].ok).toBe(true);
  });
});
