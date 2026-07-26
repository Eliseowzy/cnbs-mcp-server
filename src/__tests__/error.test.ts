import { CnbsErrorHandler, CnbsErrorType, CnbsServiceError, errorMonitor } from '../services/error.js';
import { upstreamRetriesTotal } from '../services/metrics.js';

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

  it('tracks the same error object only once across repeated analyze calls', () => {
    errorMonitor.resetStats();
    const error = new CnbsServiceError({
      type: CnbsErrorType.NETWORK_ISSUE,
      message: 'network down',
      canRetry: true,
    });

    const first = CnbsErrorHandler.analyze(error);
    const second = CnbsErrorHandler.analyze(error);

    expect(second).toEqual(first);
    expect(errorMonitor.getErrorStats()[CnbsErrorType.NETWORK_ISSUE]).toBe(1);
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

  it('does not retry CIRCUIT_OPEN errors even though they are RATE_LIMIT/canRetry', async () => {
    const op = jest.fn(async () => {
      throw new CnbsServiceError({
        type: CnbsErrorType.RATE_LIMIT,
        message: 'Circuit breaker "series" is OPEN - request rejected',
        canRetry: true,
        code: 'CIRCUIT_OPEN',
        retryAfter: 5000,
      });
    });

    await expect(CnbsErrorHandler.retryWithBackoff(op)).rejects.toThrow('is OPEN');
    expect(op).toHaveBeenCalledTimes(1);
    expect(delays.length).toBe(0);
  });

  it('reports retry metrics with the real endpoint label when available', async () => {
    const incSpy = jest.spyOn(upstreamRetriesTotal, 'inc');
    const op = jest.fn(async () => {
      throw new CnbsServiceError({
        type: CnbsErrorType.API_FAILURE,
        message: 'API error: 500',
        canRetry: false,
        endpoint: 'https://data.stats.gov.cn/dg/website/stream/esData',
      });
    });

    await expect(CnbsErrorHandler.retryWithBackoff(op)).rejects.toThrow('API error: 500');
    expect(incSpy).toHaveBeenCalledWith({ endpoint: 'https://data.stats.gov.cn/dg/website/stream/esData' });
    incSpy.mockRestore();
  });
});
