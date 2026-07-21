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
