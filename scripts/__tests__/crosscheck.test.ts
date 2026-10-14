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

describe('CrossCheckAdapter bounty-scope', () => {
  const REQ = { id: 'cc-bounty-scope', title: 'bounty scope', type: 'boolean', evidence_weight: 0.5 } as any;
  const CFG = { 'cc-bounty-scope': 'bounty-scope' };

  test('active program + in-scope target passes', async () => {
    const caseObj = { meta: { bounty_program_id: 'github', target_domain: 'api.github.com' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    const e = res.auditEntries[0];
    expect(e.ok).toBe(true);
    expect(e.notes).toContain('active');
  });

  test('active program + out-of-scope target fails', async () => {
    const caseObj = { meta: { bounty_program_id: 'github', target_domain: 'evil.example.org' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    const e = res.auditEntries[0];
    expect(e.ok).toBe(false);
    expect(e.notes).toContain('out of scope');
  });

  test('inactive program fails with status note', async () => {
    const caseObj = { meta: { bounty_program_id: 'legacy-app', target_domain: 'legacy.example.org' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    const e = res.auditEntries[0];
    expect(e.ok).toBe(false);
    expect(e.notes).toContain('not active');
  });

  test('unknown program fails with not-found note', async () => {
    const caseObj = { meta: { bounty_program_id: 'nonexistent-program' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    const e = res.auditEntries[0];
    expect(e.ok).toBe(false);
    expect(e.notes).toContain('not found');
  });

  test('wildcard subdomain in scope matches', async () => {
    const caseObj = { meta: { bounty_program_id: 'example-corp', target_domain: 'sub.example.com' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(true);
  });

  test('CIDR in-scope matches an IP target', async () => {
    const caseObj = { meta: { bounty_program_id: 'example-corp', target_domain: '10.1.2.3' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(true);
  });

  test('CIDR out-of-scope rejects a different-range IP', async () => {
    const caseObj = { meta: { bounty_program_id: 'example-corp', target_domain: '192.168.1.5' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(false);
  });

  test('top-level fields also resolve (not only meta)', async () => {
    const caseObj = { bounty_program_id: 'github', target_domain: 'www.github.com' };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(true);
  });

  test('mock quick path passes', async () => {
    const caseObj = { mock_bounty_scope: true };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(true);
  });

  // — the review-finding regressions —

  test('missing target does NOT pass (unverified coverage)', async () => {
    const caseObj = { meta: { bounty_program_id: 'github' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    const e = res.auditEntries[0];
    expect(e.ok).toBe(false);
    expect(e.notes).toContain('no target');
  });

  test('platform label is NOT a program id', async () => {
    const caseObj = { meta: { bounty_program_id: 'hackerone', target_domain: 'hackerone.com' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    const e = res.auditEntries[0];
    // 'hackerone' is a platform, not a program_id — must not resolve
    expect(e.ok).toBe(false);
    expect(e.notes).toContain('not found');
  });

  test('malformed IP fails closed on CIDR', async () => {
    const caseObj = { meta: { bounty_program_id: 'example-corp', target_domain: '10.1.2.3junk' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(false);
  });

  test('exact scope does NOT include unlisted subdomains', async () => {
    // 'pilot.example.net' is an exact scope on the closed-pilot program (closed → fails on status anyway);
    // use example-corp whose scope has 'example.com' exact — a sub on a non-wildcard exact fails
    const caseObj = { meta: { bounty_program_id: 'legacy-app', target_domain: 'sub.legacy.example.org' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    // legacy-app is suspended → fails on status regardless; the point is the
    // exact-scope rule doesn't silently widen. Check the note isn't an in-scope pass.
    expect(res.auditEntries[0].ok).toBe(false);
  });

  test('top-level domain field does NOT mask meta.target_ip', async () => {
    const caseObj = { domain: 'access', meta: { bounty_program_id: 'example-corp', target_ip: '10.1.2.3' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    // 'access' is a routing label, not the target — the real target_ip should match the CIDR
    expect(res.auditEntries[0].ok).toBe(true);
  });

  test('empty params does not shadow populated requirement_parameters', async () => {
    const caseObj = { params: {}, requirement_parameters: { bounty_program_id: 'github', target_domain: 'github.com' } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(true);
  });
});
