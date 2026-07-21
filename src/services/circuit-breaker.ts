// src/services/circuit-breaker.ts
// Circuit breaker pattern implementation for upstream API protection.
import { createLogger } from '../logger.js';

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
}

interface CircuitStats {
  failures: number;
  successes: number;
  lastFailureTime: number;
  halfOpenAttempts: number;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private stats: CircuitStats = {
    failures: 0,
    successes: 0,
    lastFailureTime: 0,
    halfOpenAttempts: 0,
  };

  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly halfOpenMax: number;
  private readonly name: string;

  constructor(name: string, options: CircuitBreakerOptions = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeout = options.resetTimeout ?? 30_000;
    this.halfOpenMax = options.halfOpenMax ?? 2;
  }

  getState(): CircuitState {
    // Check if we should transition from OPEN to HALF_OPEN
    if (this.state === CircuitState.OPEN) {
      const elapsed = Date.now() - this.stats.lastFailureTime;
      if (elapsed >= this.resetTimeout) {
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
    this.stats.halfOpenAttempts = 0;
    this.stats.successes = 0;
  }

  private reset(): void {
    this.state = CircuitState.CLOSED;
    this.stats = {
      failures: 0,
      successes: 0,
      lastFailureTime: 0,
      halfOpenAttempts: 0,
    };
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      throw new Error(`Circuit breaker "${this.name}" is OPEN - request rejected`);
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

  getStats(): { state: CircuitState; failures: number; successes: number } {
    return {
      state: this.getState(),
      failures: this.stats.failures,
      successes: this.stats.successes,
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

export function getAllCircuitStats(): Record<string, { state: CircuitState; failures: number; successes: number }> {
  const stats: Record<string, { state: CircuitState; failures: number; successes: number }> = {};
  for (const [name, breaker] of breakers) {
    stats[name] = breaker.getStats();
  }
  return stats;
}
