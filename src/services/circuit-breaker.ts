// src/services/circuit-breaker.ts
// Circuit breaker pattern implementation for upstream API protection.
import { createLogger } from '../logger.js';
import { CnbsServiceError, CnbsErrorType } from './error.js';

const log = createLogger('circuit-breaker');

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeout?: number;
  halfOpenMax?: number;
  /** Upper bound for the exponential cool-down, defaults to 5 minutes. */
  maxResetTimeout?: number;
}

interface CircuitStats {
  failures: number;
  successes: number;
  lastFailureTime: number;
  halfOpenAttempts: number;
  /** OPEN transitions since the last full recovery; drives cool-down backoff. */
  consecutiveTrips: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private stats: CircuitStats = {
    failures: 0,
    successes: 0,
    lastFailureTime: 0,
    halfOpenAttempts: 0,
    consecutiveTrips: 0,
  };

  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly halfOpenMax: number;
  private readonly maxResetTimeout: number;
  private readonly name: string;

  constructor(name: string, options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeout = options.resetTimeout ?? 30_000;
    this.halfOpenMax = options.halfOpenMax ?? 2;
    this.maxResetTimeout = options.maxResetTimeout ?? 5 * 60_000;
  }

  /**
   * Effective cool-down before OPEN → HALF_OPEN: base resetTimeout doubled per
   * consecutive trip and capped at maxResetTimeout, so a persistent upstream
   * block (e.g. a WAF storm) is probed ever less frequently instead of every
   * base interval.
   */
  private currentResetTimeout(): number {
    const exponent = Math.max(0, this.stats.consecutiveTrips - 1);
    return Math.min(this.resetTimeout * 2 ** exponent, this.maxResetTimeout);
  }

  getState(): CircuitState {
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN) {
      const elapsed = Date.now() - this.stats.lastFailureTime;
      if (elapsed >= this.currentResetTimeout()) {
        this.state = CircuitState.HALF_OPEN;
        this.stats.halfOpenAttempts = 0;
        log.info({ circuit: this.name }, 'Circuit transitioned to HALF_OPEN');
      }
    }
    return this.state;
  }

  canExecute(): boolean {
    const state = this.getState();
    if (state === CircuitState.CLOSED) return true;
    if (state === CircuitState.HALF_OPEN) {
      return this.stats.halfOpenAttempts < this.halfOpenMax;
    }
    return false; // OPEN
  }

  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.stats.successes++;
      if (this.stats.successes >= this.halfOpenMax) {
        this.reset();
        log.info({ circuit: this.name }, 'Circuit recovered, transitioned to CLOSED');
      }
    } else {
      // In CLOSED state, reset failure count on success
      this.stats.failures = 0;
    }
  }

  recordFailure(): void {
    this.stats.failures++;
    this.stats.lastFailureTime = Date.now();

    if (this.state === CircuitState.HALF_OPEN) {
      this.trip();
      log.warn({ circuit: this.name }, 'Circuit failed in HALF_OPEN, transitioned to OPEN');
    } else if (this.stats.failures >= this.failureThreshold) {
      this.trip();
      log.warn({ circuit: this.name, failures: this.stats.failures }, 'Circuit threshold exceeded, transitioned to OPEN');
    }
  }

  private trip(): void {
    this.state = CircuitState.OPEN;
    this.stats.consecutiveTrips++;
    this.stats.lastFailureTime = Date.now();
    this.stats.halfOpenAttempts = 0;
    this.stats.successes = 0;
  }

  /**
   * Trip triggered from outside the breaker (linked/site-wide block, e.g. a
   * WAF challenge detected on a sibling endpoint). Counts as one trip for the
   * cool-down backoff; when already OPEN it only refreshes the block timestamp
   * so the same detection is not double-counted.
   */
  forceTrip(): void {
    if (this.state === CircuitState.OPEN) {
      this.stats.lastFailureTime = Date.now();
      return;
    }
    log.warn({ circuit: this.name }, 'Circuit force-tripped to OPEN (linked block)');
    this.trip();
  }

  private reset(): void {
    this.state = CircuitState.CLOSED;
    this.stats = {
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      halfOpenAttempts: 0,
      consecutiveTrips: 0,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      // 结构化拒绝错误：携带 retryAfter 与专属 code，供重试循环识别并直接抛出，
      // 同时给 agent 可行动的提示（稍后重试 / 换数据源）。冷却时长随连续熔断
      // 次数指数递增，retryAfter 始终反映当前动态冷却值。
      const retryAfter = Math.max(0, this.currentResetTimeout() - (Date.now() - this.stats.lastFailureTime));
      throw new CnbsServiceError({
        type: CnbsErrorType.RATE_LIMIT,
        message: `Circuit breaker "${this.name}" is OPEN - request rejected`,
        canRetry: true,
        code: 'CIRCUIT_OPEN',
        retryAfter,
        hints: [
          `上游 ${this.name} 连续失败已触发熔断（连续第 ${this.stats.consecutiveTrips} 次），约 ${Math.ceil(retryAfter / 1000)} 秒后自动半开探测；冷却时长随连续熔断次数指数递增。`,
          '建议稍后重试，或改用其他数据源工具获取同类数据。',
        ],
      });
    }

    if (this.state === CircuitState.HALF_OPEN) {
      this.stats.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  getStats(): { state: CircuitState; failures: number; successes: number; consecutiveTrips: number } {
    return {
      state: this.getState(),
      failures: this.stats.failures,
      successes: this.stats.successes,
      consecutiveTrips: this.stats.consecutiveTrips,
    };
  }
}

// ─── Circuit Breaker Registry ──────────────────────────────────────────────

const breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(name: string, options?: CircuitBreakerOptions): CircuitBreaker {
  if (!breakers.has(name)) {
    breakers.set(name, new CircuitBreaker(name, options));
  }
  return breakers.get(name)!;
}

export function getAllCircuitStats(): Record<string, { state: CircuitState; failures: number; successes: number; consecutiveTrips: number }> {
  const stats: Record<string, { state: CircuitState; failures: number; successes: number; consecutiveTrips: number }> = {};
  for (const [name, breaker] of breakers) {
    stats[name] = breaker.getStats();
  }
  return stats;
}

/**
 * Trip the named breakers directly (creating them on demand), used for linked
 * tripping when one endpoint detects a site-wide block that necessarily
 * affects its siblings behind the same WAF.
 */
export function tripBreakers(names: string[]): void {
  for (const name of names) {
    getCircuitBreaker(name).forceTrip();
  }
}
