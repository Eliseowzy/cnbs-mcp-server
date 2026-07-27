jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  isAxiosError: jest.fn(() => false),
}));

import axios from 'axios';
import { sharedAxiosConfig, loggedGet, loggedPost } from '../services/http-client';

const mockGet = axios.get as jest.MockedFunction<typeof axios.get>;
const mockPost = axios.post as jest.MockedFunction<typeof axios.post>;

describe('http-client', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  describe('sharedAxiosConfig', () => {
    it('should have a 30s timeout', () => {
      expect(sharedAxiosConfig.timeout).toBe(30000);
    });

    it('should allow up to 5 redirects', () => {
      expect(sharedAxiosConfig.maxRedirects).toBe(5);
    });

    it('should disable proxy', () => {
      expect(sharedAxiosConfig.proxy).toBe(false);
    });

    it('should have an httpsAgent configured', () => {
      expect(sharedAxiosConfig.httpsAgent).toBeDefined();
    });

    it('sends browser-like headers instead of the axios UA', () => {
      const headers = sharedAxiosConfig.headers as Record<string, string>;
      expect(headers).toBeDefined();
      expect(String(headers['User-Agent'])).not.toContain('axios');
      expect(headers['Accept']).toContain('application/json');
      expect(headers['Accept-Language']).toContain('zh-CN');
      expect(headers['Referer']).toBe('https://data.stats.gov.cn/');
    });

    it('uses a default Chrome UA when CNBS_USER_AGENT is unset', async () => {
      const prev = process.env.CNBS_USER_AGENT;
      delete process.env.CNBS_USER_AGENT;
      jest.resetModules();
      const mod = await import('../services/http-client');
      expect(String((mod.sharedAxiosConfig.headers as Record<string, string>)['User-Agent'])).toMatch(/Mozilla\/5\.0/);
      if (prev !== undefined) process.env.CNBS_USER_AGENT = prev;
    });

    it('honors the CNBS_USER_AGENT override', async () => {
      const prev = process.env.CNBS_USER_AGENT;
      process.env.CNBS_USER_AGENT = 'custom-agent/1.0';
      jest.resetModules();
      const mod = await import('../services/http-client');
      expect((mod.sharedAxiosConfig.headers as Record<string, string>)['User-Agent']).toBe('custom-agent/1.0');
      if (prev === undefined) delete process.env.CNBS_USER_AGENT;
      else process.env.CNBS_USER_AGENT = prev;
    });
  });

  describe('loggedGet', () => {
    it('returns the axios response on success', async () => {
      mockGet.mockResolvedValue({ status: 200, data: { ok: true } });
      const res = await loggedGet('unit_get_ok', 'https://example.com/api');
      expect(res.data).toEqual({ ok: true });
      expect(mockGet).toHaveBeenCalledWith('https://example.com/api', undefined);
    });

    it('propagates errors from axios', async () => {
      mockGet.mockRejectedValue(new Error('network down'));
      await expect(loggedGet('unit_get_err', 'https://example.com/api')).rejects.toThrow('network down');
    });
  });

  describe('loggedPost', () => {
    it('returns the axios response on success', async () => {
      mockPost.mockResolvedValue({ status: 200, data: { created: 1 } });
      const res = await loggedPost('unit_post_ok', 'https://example.com/api', { a: 1 });
      expect(res.data).toEqual({ created: 1 });
      expect(mockPost).toHaveBeenCalledWith('https://example.com/api', { a: 1 }, undefined);
    });
  });

  describe('circuit breaker integration', () => {
    it('opens after repeated failures and fast-fails subsequent calls', async () => {
      mockGet.mockRejectedValue(new Error('upstream 500'));
      const source = 'unit_breaker';

      // failureThreshold defaults to 5 → 5 real failures trip the breaker.
      for (let i = 0; i < 5; i++) {
        await expect(loggedGet(source, 'https://example.com/x')).rejects.toThrow('upstream 500');
      }

      const callsBefore = mockGet.mock.calls.length;
      // Next call should be rejected by the breaker without hitting axios.
      await expect(loggedGet(source, 'https://example.com/x')).rejects.toThrow(/is OPEN/);
      expect(mockGet.mock.calls.length).toBe(callsBefore);
    });
  });

  describe('linked CNBS breaker tripping on WAF blocks', () => {
    // Each test runs in an isolated module registry so it starts from a
    // clean circuit breaker registry (the registry is module-level state).
    const CNBS_SOURCES = ['search', 'series', 'node', 'metric'];

    it('trips all four CNBS breakers on a redirect loop, leaving world_bank untouched', async () => {
      await jest.isolateModulesAsync(async () => {
        const ax = (await import('axios')) as unknown as { get: jest.Mock };
        const hc = await import('../services/http-client');
        const cb = await import('../services/circuit-breaker');

        cb.getCircuitBreaker('world_bank'); // pre-create to assert it stays CLOSED
        ax.get.mockRejectedValue(
          Object.assign(new Error('too many redirects'), { code: 'ERR_FR_TOO_MANY_REDIRECTS' }),
        );

        await expect(hc.loggedGet('search', 'https://example.com/x')).rejects.toThrow('too many redirects');

        const stats = cb.getAllCircuitStats();
        for (const name of CNBS_SOURCES) {
          expect(stats[name].state).toBe(cb.CircuitState.OPEN);
        }
        expect(stats['world_bank'].state).toBe(cb.CircuitState.CLOSED);
      });
    });

    it('trips all four CNBS breakers when the validate hook flags a WAF challenge page', async () => {
      await jest.isolateModulesAsync(async () => {
        const ax = (await import('axios')) as unknown as { post: jest.Mock };
        const hc = await import('../services/http-client');
        const cb = await import('../services/circuit-breaker');
        const err = await import('../services/error');

        ax.post.mockResolvedValue({
          status: 200,
          headers: { 'content-type': 'text/html' },
          data: '<html>Please enable JavaScript and refresh the page</html>',
        });

        await expect(hc.loggedPost('series', 'https://example.com/esData', {}, undefined, () => {
          throw new err.CnbsServiceError({
            type: err.CnbsErrorType.ACCESS_BLOCKED,
            message: 'CNBS upstream returned an anti-bot challenge page',
            canRetry: true,
          });
        })).rejects.toThrow('challenge page');

        const stats = cb.getAllCircuitStats();
        for (const name of CNBS_SOURCES) {
          expect(stats[name].state).toBe(cb.CircuitState.OPEN);
        }
      });
    });

    it('does not link-trip CNBS breakers for external sources', async () => {
      await jest.isolateModulesAsync(async () => {
        const ax = (await import('axios')) as unknown as { get: jest.Mock };
        const hc = await import('../services/http-client');
        const cb = await import('../services/circuit-breaker');

        ax.get.mockRejectedValue(
          Object.assign(new Error('too many redirects'), { code: 'ERR_FR_TOO_MANY_REDIRECTS' }),
        );

        await expect(hc.loggedGet('world_bank', 'https://example.com/wb')).rejects.toThrow('too many redirects');

        const stats = cb.getAllCircuitStats();
        // Single failure < threshold, and no CNBS breaker was created/tripped.
        expect(stats['world_bank'].state).toBe(cb.CircuitState.CLOSED);
        for (const name of CNBS_SOURCES) {
          expect(stats[name]).toBeUndefined();
        }
      });
    });
  });
});
