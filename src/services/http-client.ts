// src/services/http-client.ts
// Shared HTTP client configuration and utilities.
// Eliminates duplicate httpsAgent / axiosConfig definitions across modules.
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import https from 'https';
import { createLogger } from '../logger.js';
import {
  upstreamRequestsTotal,
  upstreamRequestDurationMs,
} from './metrics.js';
import { getCircuitBreaker } from './circuit-breaker.js';

const log = createLogger('http-client');

const httpsAgent = new https.Agent({
  rejectUnauthorized: process.env.CNBS_INSECURE_TLS !== 'true',
  keepAlive: true,
});

// Default to a modern Chrome UA so upstream WAF/anti-bot logic does not flag the
// default `axios/x.y.z` signature. Overridable via CNBS_USER_AGENT to mirror the
// existing CNBS_INSECURE_TLS style of environment-driven overrides.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export const sharedAxiosConfig: AxiosRequestConfig = {
  httpsAgent,
  timeout: 30000,
  maxRedirects: 5,
  proxy: false as const,
  headers: {
    'User-Agent': process.env.CNBS_USER_AGENT || DEFAULT_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: 'https://data.stats.gov.cn/',
  },
};

/**
 * Perform a GET request with structured logging, upstream metrics, and circuit breaker.
 */
export async function loggedGet<T = any>(
  source: string,
  url: string,
  config?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  const breaker = getCircuitBreaker(source);
  return breaker.execute(async () => {
    const startedAt = Date.now();
    log.debug({ source, url }, 'Upstream request');
    const end = upstreamRequestDurationMs.startTimer({ endpoint: source });
    try {
      const response = await axios.get<T>(url, config);
      upstreamRequestsTotal.inc({ endpoint: source });
      log.debug({ source, url, status: response.status, durationMs: Date.now() - startedAt }, 'Upstream response');
      return response;
    } finally {
      end();
    }
  });
}

/**
 * Perform a POST request with structured logging, upstream metrics, and circuit breaker.
 */
export async function loggedPost<T = any>(
  source: string,
  url: string,
  data?: unknown,
  config?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  const breaker = getCircuitBreaker(source);
  return breaker.execute(async () => {
    const startedAt = Date.now();
    log.debug({ source, url }, 'Upstream POST request');
    const end = upstreamRequestDurationMs.startTimer({ endpoint: source });
    try {
      const response = await axios.post<T>(url, data, config);
      upstreamRequestsTotal.inc({ endpoint: source });
      log.debug({ source, url, status: response.status, durationMs: Date.now() - startedAt }, 'Upstream POST response');
      return response;
    } finally {
      end();
    }
  });
}
