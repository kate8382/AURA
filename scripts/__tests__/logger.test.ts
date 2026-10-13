import { getErrorCount, logError, logInfo, logWarn, resetErrorCount, runCli } from '../logger';

describe('logger', () => {
  const env = { ...process.env };
  let errSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    resetErrorCount();
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...env };
    process.exitCode = undefined;
  });

  test('formats errors as key=value pairs and counts them', () => {
    logError('cannot parse case', { file: 'a/b.json', error: new Error('bad json') });
    expect(errSpy).toHaveBeenCalledWith('[ERROR] cannot parse case file=a/b.json error="bad json"');
    expect(getErrorCount()).toBe(1);
  });

  test('emits JSON when AURA_LOG_FORMAT=json', () => {
    process.env.AURA_LOG_FORMAT = 'json';
    logError('cannot parse case', { file: 'a.json', case_id: 'X-1', error: 'boom' });
    expect(JSON.parse(errSpy.mock.calls[0][0])).toEqual({ level: 'error', message: 'cannot parse case', file: 'a.json', case_id: 'X-1', error: 'boom' });
  });

  test('AURA_LOG_LEVEL hides lower levels but errors are still counted', () => {
    process.env.AURA_LOG_LEVEL = 'silent';
    logInfo('info');
    logWarn('warn');
    logError('error');
    expect(logSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    expect(getErrorCount()).toBe(1);
  });

  test('runCli sets exit code 1 on thrown errors and on logged errors', async () => {
    await runCli(() => { throw new Error('boom'); });
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    resetErrorCount();
    await runCli(() => { logError('data problem', { file: 'x.json' }); });
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    resetErrorCount();
    await runCli(() => undefined);
    expect(process.exitCode).toBe(0);
  });

  test('runCli keeps an explicit non-zero exit code', async () => {
    await runCli(() => 2);
    expect(process.exitCode).toBe(2);
  });
});
