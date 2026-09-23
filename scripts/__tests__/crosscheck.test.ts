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
    adapter.registerAdapter('yes', async (_r: any, _c: any) => ({ result: true, ok: true, notes: 'ok' }));
    const req = { id: 'cc-2', title: 't2', type: 'boolean', evidence_weight: 0.3 } as any;
    const res = await adapter.evaluateCrossChecks({}, [req], { 'cc-2': 'yes' });
    expect(res.auditEntries.length).toBe(1);
    expect(res.total_weight).toBeCloseTo(0.3, 2);
    expect(res.auditEntries[0].ok).toBe(true);
  });

  test('mock ip-geolocate and email-verify adapters', async () => {
    const adapter = CrossCheckAdapter;
    const reqs = [
      { id: 'cc-location-verified', title: 'loc', type: 'boolean', evidence_weight: 0.5 },
      { id: 'cc-email-verified', title: 'email', type: 'boolean', evidence_weight: 0.2 }
    ] as any;
    const caseObj = { mock_ip_geo: true, mock_email_verified: false };
    const res = await adapter.evaluateCrossChecks(caseObj, reqs, { 'cc-location-verified': 'ip-geolocate', 'cc-email-verified': 'email-verify' });
    expect(res.auditEntries.length).toBe(2);
    const total = res.auditEntries.reduce((s, a) => s + a.weight_applied, 0);
    expect(total).toBeCloseTo(0.5, 2);
    expect(res.failed_requirements).toContain('cc-email-verified');
  });
});
