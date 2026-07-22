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
});
