import axios from 'axios';
import { createLogger } from '../logger.js';
import { upstreamErrorsTotal, upstreamRetriesTotal } from './metrics.js';

const log = createLogger('error');

/** Normalize/stringify a value for logging or hints, collapsing whitespace and truncating. */
function truncateForLog(value: unknown, maxLength = 300): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

/**
 * Reduce a (possibly axios) error to a compact log-friendly object so we never
 * serialize the full axios error (config/request/socket) into the logs.
 */
function compactAxiosError(error: unknown): Record<string, unknown> | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  return {
    method: error.config?.method,
    url: error.config?.url,
    status: error.response?.status,
    code: error.code,
    body: truncateForLog(error.response?.data),
  };
}

// Re-export from split modules for backward compatibility during migration
export { CnbsRequestThrottler, cnbsRequestThrottler } from './throttler.js';
export { safePropertyAccess, validateParams } from './boundary.js';

// 错误类型枚举
export enum CnbsErrorType {
  NETWORK_ISSUE = 'NETWORK_ISSUE',
  API_FAILURE = 'API_FAILURE',
  TIMEOUT_ISSUE = 'TIMEOUT_ISSUE',
  RATE_LIMIT = 'RATE_LIMIT',
  DATA_ISSUE = 'DATA_ISSUE',
  ACCESS_BLOCKED = 'ACCESS_BLOCKED',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  CACHE_ERROR = 'CACHE_ERROR',
  THROTTLE_ERROR = 'THROTTLE_ERROR',
  UNKNOWN = 'UNKNOWN',
}

// 错误详细信息接口
export interface CnbsErrorDetails {
  type: CnbsErrorType;
  message: string;
  source?: unknown;
  canRetry: boolean;
  code?: string;
  endpoint?: string;
  status?: number;
  contentType?: string;
  tool?: string;
  attempt?: number;
  maxAttempts?: number;
  retryAfter?: number;
  hints?: string[];
  rawSnippet?: string;
}

export class CnbsServiceError extends Error {
  details: CnbsErrorDetails;

  constructor(details: CnbsErrorDetails) {
    super(details.message);
    this.name = 'CnbsServiceError';
    this.details = details;
  }
}

// 错误监控接口
export interface ErrorMonitor {
  trackError(error: CnbsErrorDetails): void;
  getErrorStats(): Record<string, number>;
  resetStats(): void;
}

// 错误监控实现
class DefaultErrorMonitor implements ErrorMonitor {
  private errorStats: Record<string, number> = {};

  trackError(error: CnbsErrorDetails): void {
    const errorType = error.type;
    this.errorStats[errorType] = (this.errorStats[errorType] || 0) + 1;
    upstreamErrorsTotal.inc({ type: errorType });
    
    // 记录详细错误信息（axios error 压缩为紧凑对象，避免日志噪音）
    log.error({ err: compactAxiosError(error.source) ?? error.source ?? error, type: errorType }, error.message);
  }

  getErrorStats(): Record<string, number> {
    return { ...this.errorStats };
  }

  resetStats(): void {
    this.errorStats = {};
  }
}

// 全局错误监控实例
export const errorMonitor = new DefaultErrorMonitor();

// 错误处理类
export class CnbsErrorHandler {
  // 分析错误
  static analyze(error: unknown): CnbsErrorDetails {
    if (!error) {
      const details: CnbsErrorDetails = {
        type: CnbsErrorType.UNKNOWN,
        message: 'Unknown error occurred',
        canRetry: false,
      };
      errorMonitor.trackError(details);
      return details;
    }

    if (error instanceof CnbsServiceError) {
      errorMonitor.trackError(error.details);
      return error.details;
    }

    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        const details: CnbsErrorDetails = {
          type: CnbsErrorType.TIMEOUT_ISSUE,
          message: 'Request timed out',
          source: error,
          canRetry: true,
          code: error.code,
        };
        errorMonitor.trackError(details);
        return details;
      }

      if (error.code === 'ERR_FR_TOO_MANY_REDIRECTS') {
        const details: CnbsErrorDetails = {
          type: CnbsErrorType.ACCESS_BLOCKED,
          message: 'Remote CNBS service entered a redirect loop, likely due to anti-bot or access control.',
          source: error,
          canRetry: true,
          code: error.code,
          hints: [
            'The upstream site may be serving a WAF or anti-bot challenge instead of JSON data.',
            'Verify whether this network path requires a browser session, proxy, or additional cookies.'
          ],
        };
        errorMonitor.trackError(details);
        return details;
      }

      if (error.response) {
        const status = error.response.status;
        if (status === 429) {
          // 提取重试时间
          const retryAfter = error.response.headers['retry-after'];
          const details: CnbsErrorDetails = {
            type: CnbsErrorType.RATE_LIMIT,
            message: 'Rate limit exceeded',
            source: error,
            canRetry: true,
            code: error.code,
            status,
            retryAfter: retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined,
          };
          errorMonitor.trackError(details);
          return details;
        }
        if (status >= 500) {
          const details: CnbsErrorDetails = {
            type: CnbsErrorType.API_FAILURE,
            message: `API error: ${status} ${error.response.statusText}`,
            source: error,
            canRetry: true,
            code: error.code,
            status,
            endpoint: error.config?.url,
            rawSnippet: truncateForLog(error.response.data),
            hints: [
              '检查 periods 粒度是否与该数据集 dt 类型（年/季/月）匹配。',
              '上游对无效的指标+时段组合可能返回 500，请核对 metricIds 与 setId 是否对应。',
            ],
          };
          errorMonitor.trackError(details);
          return details;
        }
        if (status >= 400) {
          const details: CnbsErrorDetails = {
            type: CnbsErrorType.API_FAILURE,
            message: `API error: ${status} ${error.response.statusText}`,
            source: error,
            canRetry: false,
            code: error.code,
            status,
          };
          errorMonitor.trackError(details);
          return details;
        }
      }

      if (error.request) {
        const details: CnbsErrorDetails = {
          type: CnbsErrorType.NETWORK_ISSUE,
          message: 'Network error: No response received',
          source: error,
          canRetry: true,
          code: error.code,
        };
        errorMonitor.trackError(details);
        return details;
      }

      const details: CnbsErrorDetails = {
        type: CnbsErrorType.UNKNOWN,
        message: error.message || 'Unknown error',
        source: error,
        canRetry: false,
        code: error.code,
      };
      errorMonitor.trackError(details);
      return details;
    }

    if (error instanceof Error) {
      // 处理验证错误
      if (error.name === 'ValidationError' || error.message.includes('validation')) {
        const details: CnbsErrorDetails = {
          type: CnbsErrorType.VALIDATION_ERROR,
          message: error.message,
          source: error,
          canRetry: false,
        };
        errorMonitor.trackError(details);
        return details;
      }

      // 处理缓存错误
      if (error.message.includes('cache')) {
        const details: CnbsErrorDetails = {
          type: CnbsErrorType.CACHE_ERROR,
          message: error.message,
          source: error,
          canRetry: true,
        };
        errorMonitor.trackError(details);
        return details;
      }

      const details: CnbsErrorDetails = {
        type: CnbsErrorType.UNKNOWN,
        message: error.message,
        source: error,
        canRetry: false,
      };
      errorMonitor.trackError(details);
      return details;
    }

    const details: CnbsErrorDetails = {
      type: CnbsErrorType.UNKNOWN,
      message: String(error),
      source: error,
      canRetry: false,
    };
    errorMonitor.trackError(details);
    return details;
  }

  // 带退避的重试
  static async retryWithBackoff<T>(
    operation: () => Promise<T>,
    settings?: {
      maxAttempts?: number;
      baseDelay?: number;
      maxDelay?: number;
      backoffFactor?: number;
      retryableErrorTypes?: CnbsErrorType[];
    }
  ): Promise<T> {
    const maxAttempts = settings?.maxAttempts || 3;
    const baseDelay = settings?.baseDelay || 1000;
    const maxDelay = settings?.maxDelay || 10000;
    const backoffFactor = settings?.backoffFactor || 2;
    const retryableErrorTypes = settings?.retryableErrorTypes || [
      CnbsErrorType.NETWORK_ISSUE,
      CnbsErrorType.TIMEOUT_ISSUE,
      CnbsErrorType.RATE_LIMIT,
      CnbsErrorType.API_FAILURE,
      CnbsErrorType.CACHE_ERROR,
      CnbsErrorType.ACCESS_BLOCKED,
    ];

    // WAF challenges self-heal only after a pause; retrying too quickly just
    // re-triggers the block, so ACCESS_BLOCKED gets a higher backoff floor.
    const ACCESS_BLOCKED_MIN_DELAY = 3000;

    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const errorDetails = this.analyze(error);
        lastError = error;

        log.warn({ attempt: attempt + 1, maxAttempts, err: compactAxiosError(error) ?? error }, 'Request attempt failed');
        upstreamRetriesTotal.inc({ endpoint: 'unknown' });

        // 检查是否可以重试
        const canRetry = errorDetails.canRetry && retryableErrorTypes.includes(errorDetails.type);
        if (!canRetry || attempt >= maxAttempts - 1) {
          throw error;
        }

        // 计算延迟时间
        let delay = errorDetails.retryAfter || Math.min(
          baseDelay * Math.pow(backoffFactor, attempt),
          maxDelay
        );

        // WAF blocks need a longer cool-down before the challenge lifts.
        if (errorDetails.type === CnbsErrorType.ACCESS_BLOCKED) {
          delay = Math.max(delay, ACCESS_BLOCKED_MIN_DELAY);
        }

        // 添加随机抖动，避免重试风暴
        delay = delay * (0.8 + Math.random() * 0.4);

        // Keep the ACCESS_BLOCKED floor intact even after downward jitter.
        if (errorDetails.type === CnbsErrorType.ACCESS_BLOCKED) {
          delay = Math.max(delay, ACCESS_BLOCKED_MIN_DELAY);
        }

        log.debug({ delayMs: Math.round(delay) }, 'Retrying request');
        await this.wait(Math.round(delay));
      }
    }

    throw lastError;
  }

  // 等待指定时间
  private static wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 安全执行操作，捕获并处理错误
  static async safeExecute<T>(
    operation: () => Promise<T>,
    fallback?: T
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      const errorDetails = this.analyze(error);
      log.warn({ err: error }, `Safe execute failed: ${errorDetails.message}`);
      return fallback;
    }
  }

  static createServiceError(details: CnbsErrorDetails): CnbsServiceError {
    return new CnbsServiceError(details);
  }

  static toToolErrorData(error: unknown, tool?: string): { message: string; details: CnbsErrorDetails } {
    const details = this.analyze(error);
    const mergedDetails = tool ? { ...details, tool } : details;
    return {
      message: mergedDetails.message,
      details: mergedDetails,
    };
  }
}
