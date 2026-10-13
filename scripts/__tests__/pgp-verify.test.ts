import CrossCheckAdapter from '../policy/crossCheckAdapter';

// Real signed fixtures — detached + cleartext signatures from the test key in
// config/trusted-keys/test-signer.asc, plus an untrusted-signer sig and a
// corrupted sig. The private key is NOT in the repo — the fixtures are baked.
const MSG = 'This is a signed case-claim for AURA.';
const DETACHED = `-----BEGIN PGP SIGNATURE-----

wsC5BAEBCgBtBYJqzpnNCRDq9g/Nudk7DkUUAAAAAAAcACBzYWx0QG5vdGF0
aW9ucy5vcGVucGdwanMub3JnCrzJcbKAU6bPsYVmnPqG4B7gHR156rExCSeM
8Vk4Ld8WIQSBd0clgVwnzTJG8Vjq9g/Nudk7DgAAFAIIAIDHWt7yJw8tbRiy
SDoqZ8l3M3e00ch2xXF6zDBXkMZRqXTr8QoHXfNi/Xm3mLHVwnWwPEqRF3aR
k/+I+M7xSQEMZXNoTxqIyawBcQH0uQuiq0wp2m63src9TurPPyfOGZDcGeiS
kdI2YtEsKbCcm2KNyNvSoI/stwLvOEEE3JCsrG4JFTvUvuY6FjEQFyweeCaJ
OnOJpSWQSobrg9KlAaAFAx9qOOCozLEL+A1exNlwUE/89/lL8IRftOejNVgk
rCcwj7zIyVZsZfdfWhHBCtM2kHVpQPi87+Fcgy/z1ro+BY6yS0vsQLYtpIXt
TFS3F5uUpLIU/wQ/QT3Uo4bDl6w=
=09Lf
-----END PGP SIGNATURE-----
`;
const CLEARTEXT = `-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

This is a signed case-claim for AURA.
-----BEGIN PGP SIGNATURE-----

wsC5BAEBCgBtBYJqzpnOCRDq9g/Nudk7DkUUAAAAAAAcACBzYWx0QG5vdGF0
aW9ucy5vcGVucGdwanMub3JnLuVmRS7hLDp9XuehBK8zYATHEqTklPZQhWn4
1vCHjUMWIQSBd0clgVwnzTJG8Vjq9g/Nudk7DgAAxZoH/3FxC40YFMrUJ0o6
KMHpsxKfIzP0dC49IsjvEmo8ciH3Pza/s7lvBcWrWuQoP/nlG/BLwZptBVm5
okByAtlC1U744If/8A3eY7Tub5nlKbUIOZtNVyiiuH90apQbvO71Z1J/tP0L
pGpErHSFGX2Hdh+/OQp4QWxnSXzK0g6BDAz6ZnCvKQLo7fm2+waS4NaJDsr+
Cx7ccdF7r5akLZuEXjM4TbNT4pcdEKQXRmriXmvvEGmS/qLh7n94APFnOOkZ
hV3auAq23VE5nwa4fj2OIi7d6RNTmgHI1P4aE9uEo6LMOK8dEr8VGTjZGw87
Q+RZjfnMuvZB47HnrqcsWA5pOAQ=
=4Z7n
-----END PGP SIGNATURE-----
`;
const UNTRUSTED = `-----BEGIN PGP SIGNATURE-----

wsC5BAEBCgBtBYJqzpnWCRA3tGRMZZI/zkUUAAAAAAAcACBzYWx0QG5vdGF0
aW9ucy5vcGVucGdwanMub3JnXM3m0VmfaHWybzVZxBZAp+ALeOiAFn4v9R/C
O6UWer8WIQQskFmetcSdSdmuiSY3tGRMZZI/zgAAFEMIAIj3exsDCDsIvpN4
MLt1tl+knf1Q/aoX5cEEnPnRoOnnsTtL6uIDg62md9QbJHgDxHEQH6ZKaMae
1qrlD2IuuydQGiXe7oLmKkuFtUaXcrNJ8Ccupd7xJXG54jDDorwSayCmMlc2
z5TnFQwLOkZ3B2YZ7GBpnts4gT6KfmV4csWNkM/NCQWBfbqnJNWITyhmJLRj
Mudj4rQrAJfFYx/qKD7+bIKn4m5Qx+tMwULIXClepzADQYwjcep1JLkKNrOl
FDbkn7XHa7nZa8xGQUbcy5LEOIsn2e/Vvb1LSSBCaejduo1cb2zcmY3yPO9+
Sq5Sk+Teejjbe+jfFI/ebRsaUTw=
=PL4R
-----END PGP SIGNATURE-----
`;
const CORRUPT = `-----BEGIN PGP SIGNATURE-----

wsC5XXXXXXXXXXJqzpnNCRDq9g/Nudk7DkUUAAAAAAAcACBzYWx0QG5vdGF0
aW9ucy5vcGVucGdwanMub3JnCrzJcbKAU6bPsYVmnPqG4B7gHR156rExCSeM
8Vk4Ld8WIQSBd0clgVwnzTJG8Vjq9g/Nudk7DgAAFAIIAIDHWt7yJw8tbRiy
SDoqZ8l3M3e00ch2xXF6zDBXkMZRqXTr8QoHXfNi/Xm3mLHVwnWwPEqRF3aR
k/+I+M7xSQEMZXNoTxqIyawBcQH0uQuiq0wp2m63src9TurPPyfOGZDcGeiS
kdI2YtEsKbCcm2KNyNvSoI/stwLvOEEE3JCsrG4JFTvUvuY6FjEQFyweeCaJ
OnOJpSWQSobrg9KlAaAFAx9qOOCozLEL+A1exNlwUE/89/lL8IRftOejNVgk
rCcwj7zIyVZsZfdfWhHBCtM2kHVpQPi87+Fcgy/z1ro+BY6yS0vsQLYtpIXt
TFS3F5uUpLIU/wQ/QT3Uo4bDl6w=
=09Lf
-----END PGP SIGNATURE-----
`;

describe('CrossCheckAdapter pgp-verify', () => {
  const REQ = { id: 'cc-pgp', title: 'pgp verify', type: 'boolean', evidence_weight: 0.5 } as any;
  const CFG = { 'cc-pgp': 'pgp-verify' };

  test('valid detached signature from trusted key passes', async () => {
    const caseObj = { meta: { signed_message: MSG, signature: DETACHED } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    const e = res.auditEntries[0];
    expect(e.ok).toBe(true);
    expect(e.result && e.result.verification_status).toBe('verified');
  });

  test('cleartext-signed message from trusted key passes', async () => {
    const caseObj = { meta: { signed_message: MSG, signature: CLEARTEXT } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(true);
  });

  test('valid signature from UNTRUSTED key fails', async () => {
    const caseObj = { meta: { signed_message: MSG, signature: UNTRUSTED } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    const e = res.auditEntries[0];
    expect(e.ok).toBe(false);
    expect(e.notes).toContain('not in the trusted');
  });

  test('corrupted signature fails closed', async () => {
    const caseObj = { meta: { signed_message: MSG, signature: CORRUPT } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(false);
  });

  test('missing signature fails', async () => {
    const caseObj = { meta: { signed_message: MSG } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(false);
  });

  test('missing message fails', async () => {
    const caseObj = { meta: { signature: DETACHED } };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(false);
  });

  test('top-level fields also resolve', async () => {
    const caseObj = { signed_message: MSG, signature: DETACHED };
    const res = await CrossCheckAdapter.evaluateCrossChecks(caseObj, [REQ], CFG);
    expect(res.auditEntries[0].ok).toBe(true);
  });
});
