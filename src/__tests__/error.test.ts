import { CnbsErrorHandler, CnbsErrorType, CnbsServiceError } from '../services/error.js';

describe('CnbsErrorHandler.analyze', () => {
  it('enriches upstream 5xx with endpoint, hints and a compact body snippet', () => {
    const axiosError = {
      isAxiosError: true,
      message: 'Request failed with status code 500',
      code: 'ERR_BAD_RESPONSE',
      config: { url: 'https://data.stats.gov.cn/dg/website/stream/esData', method: 'post' },
      response: {
        status: 500,
        statusText: 'Internal Server Error',
        data: '  {"error":"internal"}\n\n ',
        headers: {},
      },
    };

    const details = CnbsErrorHandler.analyze(axiosError);

    expect(details.type).toBe(CnbsErrorType.API_FAILURE);
    expect(details.canRetry).toBe(true);
    expect(details.status).toBe(500);
    expect(details.endpoint).toContain('stream/esData');
    expect(details.rawSnippet).toBe('{"error":"internal"}');
    expect(details.hints && details.hints.length).toBeGreaterThan(0);
    expect((details.hints || []).join(' ')).toContain('periods');
  });
});

describe('CnbsErrorHandler.retryWithBackoff', () => {
  let setTimeoutSpy: jest.SpyInstance;
  const delays: number[] = [];

  beforeEach(() => {
    delays.length = 0;
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('retries ACCESS_BLOCKED with a backoff floor of at least 3s', async () => {
    let calls = 0;
    const op = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new CnbsServiceError({
          type: CnbsErrorType.ACCESS_BLOCKED,
          message: 'blocked by WAF',
          canRetry: true,
        });
      }
      return 'ok';
    });

    const result = await CnbsErrorHandler.retryWithBackoff(op);

    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
    expect(delays[0]).toBeGreaterThanOrEqual(3000);
  });

  it('does not retry non-WAF HTML (API_FAILURE with canRetry:false)', async () => {
    const op = jest.fn(async () => {
      throw new CnbsServiceError({
        type: CnbsErrorType.API_FAILURE,
        message: 'unexpected HTML payload',
        canRetry: false,
      });
    });

    await expect(CnbsErrorHandler.retryWithBackoff(op)).rejects.toThrow('unexpected HTML payload');
    expect(op).toHaveBeenCalledTimes(1);
    expect(delays.length).toBe(0);
  });
});
