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

export const sharedAxiosConfig: AxiosRequestConfig = {
  httpsAgent,
  timeout: 30000,
  maxRedirects: 5,
  proxy: false as const,
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
