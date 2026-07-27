import { CircuitBreaker, CircuitState, getCircuitBreaker, getAllCircuitStats, tripBreakers } from '../services/circuit-breaker';
import { CnbsServiceError, CnbsErrorType } from '../services/error';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test', {
      failureThreshold: 3,
      resetTimeout: 100,
      halfOpenMax: 2,
    });
  });

  describe('initial state', () => {
    it('should start in CLOSED state', () => {
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should allow execution when CLOSED', () => {
      expect(breaker.canExecute()).toBe(true);
    });
  });

  describe('state transitions', () => {
    it('should transition to OPEN after failure threshold', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.recordFailure(); // 3rd failure hits threshold
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should reject execution when OPEN', () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      expect(breaker.canExecute()).toBe(false);
    });

    it('should transition to HALF_OPEN after reset timeout', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      await new Promise(r => setTimeout(r, 150));
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('should allow limited execution in HALF_OPEN', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise(r => setTimeout(r, 150));
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
      expect(breaker.canExecute()).toBe(true);
    });

    it('should recover to CLOSED after successful HALF_OPEN attempts', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise(r => setTimeout(r, 150));
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      breaker.recordSuccess();
      breaker.recordSuccess(); // halfOpenMax = 2
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should trip back to OPEN on failure in HALF_OPEN', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await new Promise(r => setTimeout(r, 150));
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('execute', () => {
    it('should execute function and return result when CLOSED', async () => {
      const result = await breaker.execute(async () => 'success');
      expect(result).toBe('success');
    });

    it('should throw when circuit is OPEN', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      await expect(
        breaker.execute(async () => 'should not run'),
      ).rejects.toThrow('Circuit breaker "test" is OPEN');
    });

    it('should reject with a structured CnbsServiceError carrying CIRCUIT_OPEN and retryAfter', async () => {
      breaker.recordFailure();
      breaker.recordFailure();
      breaker.recordFailure();

      let caught: unknown;
      try {
        await breaker.execute(async () => 'should not run');
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(CnbsServiceError);
      const details = (caught as CnbsServiceError).details;
      expect(details.type).toBe(CnbsErrorType.RATE_LIMIT);
      expect(details.code).toBe('CIRCUIT_OPEN');
      expect(details.canRetry).toBe(true);
      expect(details.retryAfter).toBeGreaterThanOrEqual(0);
      expect(details.retryAfter).toBeLessThanOrEqual(100); // resetTimeout = 100
      expect((details.hints || []).join(' ')).toContain('熔断');
    });

    it('should record failure when function throws', async () => {
      await expect(
        breaker.execute(async () => { throw new Error('fail'); }),
      ).rejects.toThrow('fail');

      expect(breaker.getStats().failures).toBe(1);
    });

    it('should reset failure count on success in CLOSED state', async () => {
      breaker.recordFailure();
      breaker.recordFailure();

      await breaker.execute(async () => 'ok');
      expect(breaker.getStats().failures).toBe(0);
    });
  });

  describe('getStats', () => {
    it('should return current statistics', () => {
      const stats = breaker.getStats();
      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failures).toBe(0);
      expect(stats.successes).toBe(0);
      expect(stats.consecutiveTrips).toBe(0);
    });
  });

  describe('exponential cool-down', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('doubles the cool-down per consecutive trip and caps at maxResetTimeout', () => {
      const b = new CircuitBreaker('backoff', {
        failureThreshold: 1,
        resetTimeout: 100,
        maxResetTimeout: 250,
      });

      b.recordFailure(); // trip #1 → cool-down 100
      expect(b.getStats().consecutiveTrips).toBe(1);
      jest.advanceTimersByTime(99);
      expect(b.getState()).toBe(CircuitState.OPEN);
      jest.advanceTimersByTime(1);
      expect(b.getState()).toBe(CircuitState.HALF_OPEN);

      b.recordFailure(); // trip #2 → cool-down 200
      expect(b.getStats().consecutiveTrips).toBe(2);
      jest.advanceTimersByTime(150);
      expect(b.getState()).toBe(CircuitState.OPEN);
      jest.advanceTimersByTime(50);
      expect(b.getState()).toBe(CircuitState.HALF_OPEN);

      b.recordFailure(); // trip #3 → min(400, 250) = 250 (capped)
      expect(b.getStats().consecutiveTrips).toBe(3);
      jest.advanceTimersByTime(249);
      expect(b.getState()).toBe(CircuitState.OPEN);
      jest.advanceTimersByTime(1);
      expect(b.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('restores the base cool-down after full recovery to CLOSED', () => {
      const b = new CircuitBreaker('backoff-reset', {
        failureThreshold: 1,
        resetTimeout: 100,
        maxResetTimeout: 800,
        halfOpenMax: 1,
      });

      b.recordFailure(); // trip #1 → 100
      jest.advanceTimersByTime(100);
      expect(b.getState()).toBe(CircuitState.HALF_OPEN);
      b.recordFailure(); // trip #2 → 200
      jest.advanceTimersByTime(200);
      expect(b.getState()).toBe(CircuitState.HALF_OPEN);

      b.recordSuccess(); // halfOpenMax = 1 → CLOSED, trip counter cleared
      expect(b.getState()).toBe(CircuitState.CLOSED);
      expect(b.getStats().consecutiveTrips).toBe(0);

      b.recordFailure(); // fresh trip → back to base cool-down 100
      jest.advanceTimersByTime(100);
      expect(b.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('reports retryAfter based on the dynamic cool-down', async () => {
      const b = new CircuitBreaker('backoff-retry-after', {
        failureThreshold: 1,
        resetTimeout: 100,
        maxResetTimeout: 800,
      });

      b.recordFailure(); // trip #1 → 100
      jest.advanceTimersByTime(100);
      expect(b.getState()).toBe(CircuitState.HALF_OPEN);
      b.recordFailure(); // trip #2 → cool-down 200

      let caught: unknown;
      try {
        await b.execute(async () => 'should not run');
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(CnbsServiceError);
      const details = (caught as CnbsServiceError).details;
      expect(details.code).toBe('CIRCUIT_OPEN');
      // Fake timers freeze Date.now, so retryAfter equals the doubled cool-down.
      expect(details.retryAfter).toBe(200);
      expect((details.hints || []).join(' ')).toContain('指数递增');
    });
  });
});

describe('Circuit Breaker Registry', () => {
  it('should return the same breaker for the same name', () => {
    const b1 = getCircuitBreaker('registry-test');
    const b2 = getCircuitBreaker('registry-test');
    expect(b1).toBe(b2);
  });

  it('should return different breakers for different names', () => {
    const b1 = getCircuitBreaker('breaker-a');
    const b2 = getCircuitBreaker('breaker-b');
    expect(b1).not.toBe(b2);
  });

  it('should aggregate stats from all breakers', () => {
    const stats = getAllCircuitStats();
    expect(typeof stats).toBe('object');
  });

  describe('tripBreakers', () => {
    it('trips only the named breakers, counting one trip each', () => {
      const a = getCircuitBreaker('linked-a');
      const b = getCircuitBreaker('linked-b');
      const c = getCircuitBreaker('linked-c');

      tripBreakers(['linked-a', 'linked-b']);

      expect(a.getState()).toBe(CircuitState.OPEN);
      expect(a.getStats().consecutiveTrips).toBe(1);
      expect(b.getState()).toBe(CircuitState.OPEN);
      expect(b.getStats().consecutiveTrips).toBe(1);
      expect(c.getState()).toBe(CircuitState.CLOSED);
      expect(c.getStats().consecutiveTrips).toBe(0);
    });

    it('creates missing breakers on demand', () => {
      tripBreakers(['linked-created-on-demand']);
      expect(getAllCircuitStats()['linked-created-on-demand'].state).toBe(CircuitState.OPEN);
    });

    it('does not double-count trips on an already OPEN breaker', () => {
      const d = getCircuitBreaker('linked-d');
      tripBreakers(['linked-d']);
      tripBreakers(['linked-d']);
      expect(d.getStats().consecutiveTrips).toBe(1);
      expect(d.getState()).toBe(CircuitState.OPEN);
    });
  });
});
